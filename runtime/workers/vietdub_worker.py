"""Worker inference local cho ba contract JSONL của VietDub.

Tiến trình được giữ sống để model chỉ được nạp một lần. stdout chỉ dành cho
JSONL; log chẩn đoán không được ghi ra stdout để không làm hỏng frame.
"""

from __future__ import annotations

import argparse
import base64
import io
import json
import math
import os
import sys
import wave
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


MAX_AUDIO_BYTES = 512 * 1024
MAX_TEXT_CHARACTERS = 2400
SAMPLE_RATE_STT = 16_000
SAMPLE_RATE_TTS = 48_000

# Cố định chế độ offline trước khi nạp thư viện có khả năng dùng Hugging Face Hub.
os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"
os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"


class WorkerInputError(ValueError):
    """Lỗi request có thông báo an toàn, không đưa nội dung riêng tư ra ngoài."""


def emit(payload: dict[str, Any]) -> None:
    """Ghi một JSON frame và flush ngay để backend nhận được phản hồi."""
    sys.stdout.write(json.dumps(payload, ensure_ascii=True, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def request_id(payload: dict[str, Any]) -> str:
    value = payload.get("id")
    if not isinstance(value, str) or not value:
        raise WorkerInputError("request id is required")
    return value


def resolve_existing_directory(value: str, label: str) -> Path:
    path = Path(value).expanduser().resolve()
    if not path.is_dir():
        raise RuntimeError(f"{label} directory is missing")
    return path


def verify_request_model(payload: dict[str, Any], model_path: Path) -> None:
    value = payload.get("modelPath")
    if not isinstance(value, str) or Path(value).expanduser().resolve() != model_path:
        raise WorkerInputError("request model path does not match the loaded model")


def safe_text(value: Any, field_name: str, max_length: int = MAX_TEXT_CHARACTERS) -> str:
    if not isinstance(value, str):
        raise WorkerInputError(f"{field_name} must be text")
    text = value.strip()
    if not text:
        raise WorkerInputError(f"{field_name} must not be empty")
    if len(text) > max_length:
        raise WorkerInputError(f"{field_name} exceeds the local limit")
    return text


def pcm16_from_base64(value: Any) -> bytes:
    if not isinstance(value, str) or not value:
        raise WorkerInputError("pcmBase64 is required")
    try:
        pcm = base64.b64decode(value, validate=True)
    except (ValueError, TypeError) as exc:
        raise WorkerInputError("pcmBase64 is invalid") from exc
    if not pcm or len(pcm) > MAX_AUDIO_BYTES or len(pcm) % 2:
        raise WorkerInputError("PCM frame size is invalid")
    return pcm


def as_positive_number(value: Any, field_name: str) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError) as exc:
        raise WorkerInputError(f"{field_name} is invalid") from exc
    if not math.isfinite(number) or number <= 0:
        raise WorkerInputError(f"{field_name} is invalid")
    return number


def as_nonnegative_number(value: Any, field_name: str) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError) as exc:
        raise WorkerInputError(f"{field_name} is invalid") from exc
    if not math.isfinite(number) or number < 0:
        raise WorkerInputError(f"{field_name} is invalid")
    return number


class RuntimeBase:
    def __init__(self, model_path: Path) -> None:
        self.model_path = model_path

    def check_model(self, payload: dict[str, Any]) -> None:
        verify_request_model(payload, self.model_path)


@dataclass
class AudioSession:
    buffer: bytearray = field(default_factory=bytearray)
    start_ms: float | None = None
    end_ms: float = 0.0
    silence_ms: float = 0.0
    has_speech: bool = False


class SttRuntime(RuntimeBase):
    def __init__(self, model_path: Path, threads: int, compute_type: str, vad_threshold: float, silence_ms: int) -> None:
        super().__init__(model_path)
        try:
            import numpy as np
            from faster_whisper import WhisperModel
        except ImportError as exc:
            raise RuntimeError("STT dependencies are not installed") from exc

        self._np = np
        self._model = WhisperModel(
            str(model_path),
            device="cpu",
            compute_type=compute_type,
            cpu_threads=threads,
            num_workers=1,
            local_files_only=True,
        )
        self._vad_threshold = vad_threshold
        self._silence_limit_ms = float(silence_ms)
        self._max_utterance_ms = 10_000.0
        self._sessions: dict[str, AudioSession] = {}
        self._segment_counter = 0

    def handle(self, payload: dict[str, Any]) -> dict[str, Any]:
        self.check_model(payload)
        operation = payload.get("op")
        session_id = payload.get("sessionId")
        if not isinstance(session_id, str) or not session_id:
            raise WorkerInputError("sessionId is required")

        if operation == "start_stream":
            self._require_audio_format(payload)
            self._sessions[session_id] = AudioSession()
            return {}
        if operation == "audio_chunk":
            return {"events": self._audio_chunk(session_id, payload)}
        if operation == "end_stream":
            session = self._sessions.pop(session_id, None)
            if session is None:
                return {"events": []}
            return {"events": self._flush(session)}
        raise WorkerInputError("unsupported STT operation")

    def _require_audio_format(self, payload: dict[str, Any]) -> None:
        if payload.get("sampleRate") != SAMPLE_RATE_STT or payload.get("channels") != 1:
            raise WorkerInputError("STT requires mono 16 kHz PCM")

    def _audio_chunk(self, session_id: str, payload: dict[str, Any]) -> list[dict[str, Any]]:
        session = self._sessions.get(session_id)
        if session is None:
            raise WorkerInputError("STT stream is not started")
        self._require_audio_format(payload)
        pcm = pcm16_from_base64(payload.get("pcmBase64"))
        timestamp_ms = as_nonnegative_number(payload.get("timestampMs", 0), "timestampMs")
        duration_ms = as_positive_number(payload.get("durationMs"), "durationMs")
        expected_duration = len(pcm) / 2 / SAMPLE_RATE_STT * 1000
        if abs(expected_duration - duration_ms) > 50:
            raise WorkerInputError("PCM duration does not match the frame")

        samples = self._np.frombuffer(pcm, dtype=self._np.int16).astype(self._np.float32)
        rms = float(self._np.sqrt(self._np.mean((samples / 32768.0) ** 2))) if samples.size else 0.0
        if rms >= self._vad_threshold:
            if session.start_ms is None:
                session.start_ms = timestamp_ms
            session.has_speech = True
            session.silence_ms = 0.0
            session.buffer.extend(pcm)
            session.end_ms = timestamp_ms + duration_ms
            if session.end_ms - session.start_ms >= self._max_utterance_ms:
                return self._flush(session)
            return []

        if not session.has_speech:
            return []
        session.buffer.extend(pcm)
        session.silence_ms += duration_ms
        session.end_ms = timestamp_ms + duration_ms
        if session.silence_ms < self._silence_limit_ms:
            return []
        return self._flush(session)

    def _flush(self, session: AudioSession) -> list[dict[str, Any]]:
        if not session.has_speech or not session.buffer or session.start_ms is None:
            return []
        audio = self._np.frombuffer(bytes(session.buffer), dtype=self._np.int16).astype(self._np.float32) / 32768.0
        start_ms = session.start_ms
        session.buffer.clear()
        session.start_ms = None
        session.end_ms = 0.0
        session.silence_ms = 0.0
        session.has_speech = False

        try:
            segments, _ = self._model.transcribe(
                audio,
                language="en",
                task="transcribe",
                beam_size=1,
                best_of=1,
                temperature=0.0,
                condition_on_previous_text=False,
                vad_filter=False,
                word_timestamps=False,
            )
            events: list[dict[str, Any]] = []
            for segment in segments:
                text = str(segment.text or "").strip()
                if not text:
                    continue
                self._segment_counter += 1
                avg_logprob = float(getattr(segment, "avg_logprob", 0.0))
                confidence = min(1.0, max(0.0, math.exp(avg_logprob))) if math.isfinite(avg_logprob) else 0.0
                events.append({
                    "kind": "final",
                    "segmentId": f"stt_{self._segment_counter}",
                    "text": text,
                    "startMs": round(start_ms + float(segment.start) * 1000),
                    "endMs": round(start_ms + float(segment.end) * 1000),
                    "confidence": confidence,
                })
            return events
        except Exception as exc:
            raise RuntimeError("STT inference failed") from exc


class TranslationRuntime(RuntimeBase):
    def __init__(self, model_path: Path, threads: int) -> None:
        super().__init__(model_path)
        try:
            import torch
            from transformers import AutoModelForSeq2SeqLM, AutoTokenizer
        except ImportError as exc:
            raise RuntimeError("translation dependencies are not installed") from exc

        torch.set_num_threads(threads)
        try:
            self._torch = torch
            self._tokenizer = AutoTokenizer.from_pretrained(str(model_path), local_files_only=True)
            self._model = AutoModelForSeq2SeqLM.from_pretrained(str(model_path), local_files_only=True)
            self._model.eval()
        except Exception as exc:
            raise RuntimeError("translation model could not be loaded locally") from exc

    def handle(self, payload: dict[str, Any]) -> dict[str, Any]:
        self.check_model(payload)
        if payload.get("op") != "translate":
            raise WorkerInputError("unsupported translation operation")
        source_text = safe_text(payload.get("sourceText"), "sourceText")
        try:
            encoded = self._tokenizer(
                source_text,
                return_tensors="pt",
                truncation=True,
                max_length=256,
            )
            with self._torch.inference_mode():
                generated = self._model.generate(
                    **encoded,
                    max_new_tokens=256,
                    num_beams=1,
                    do_sample=False,
                )
            translated = self._tokenizer.batch_decode(generated, skip_special_tokens=True)[0].strip()
            if not translated:
                raise RuntimeError("empty translation")
            token_count = int(encoded["input_ids"].numel() + generated.numel())
            return {"translatedText": translated, "tokensUsed": token_count}
        except WorkerInputError:
            raise
        except Exception as exc:
            raise RuntimeError("translation inference failed") from exc


class TtsRuntime(RuntimeBase):
    def __init__(self, model_path: Path, codec_path: Path, threads: int, voice: str) -> None:
        super().__init__(model_path)
        # Ngăn SDK truy cập Hub trong quá trình nạp model hoặc kiểm tra file tùy chọn.
        try:
            import numpy as np
            from vieneu._v3_turbo_engine.onnx_runtime_lite import OnnxV3LiteEngine
            from vieneu_utils.core_utils import (
                gaps_to_silence,
                join_audio_chunks,
                max_expected_frames,
                strip_encoder_pad_frame,
            )
            from vieneu_utils.phonemize_text import phonemize_text_with_emotions, normalize_to_chunks_v3_with_gaps
        except ImportError as exc:
            raise RuntimeError("TTS dependencies are not installed") from exc

        voices_path = Path(__import__("vieneu").__file__).resolve().parent / "assets" / "voices_v3_turbo.json"
        try:
            voices = json.loads(voices_path.read_text(encoding="utf-8"))
        except Exception as exc:
            raise RuntimeError("VieNeu voice asset could not be loaded") from exc
        speaker_embedding, reference_codes = self._select_voice(voices, voice, np, strip_encoder_pad_frame)
        onnx_dir = model_path / "onnx_update"
        if not onnx_dir.is_dir() or not codec_path.is_dir():
            raise RuntimeError("VieNeu ONNX or codec directory is missing")
        try:
            self._engine = OnnxV3LiteEngine(
                checkpoint_path=str(model_path),
                onnx_dir=str(onnx_dir),
                codec_dir=str(codec_path),
                threads=threads,
            )
        except Exception as exc:
            raise RuntimeError("VieNeu ONNX engine could not be loaded locally") from exc
        self._np = np
        self._join_audio_chunks = join_audio_chunks
        self._max_expected_frames = max_expected_frames
        self._gaps_to_silence = gaps_to_silence
        self._phonemize = phonemize_text_with_emotions
        self._normalize_chunks = normalize_to_chunks_v3_with_gaps
        self._speaker_embedding = speaker_embedding
        self._reference_codes = reference_codes

    @staticmethod
    def _select_voice(voices: Any, requested: str, np: Any, strip_encoder_pad_frame: Any) -> tuple[Any, Any]:
        if not isinstance(voices, dict):
            raise RuntimeError("VieNeu voice asset has an invalid format")
        presets = voices.get("presets") if isinstance(voices.get("presets"), dict) else voices
        default_voice = voices.get("default_voice") or "Minh Đức"
        selected = presets.get(requested)
        if selected is None:
            selected = next(
                (
                    value
                    for value in presets.values()
                    if isinstance(value, dict) and requested in (value.get("aliases") or [])
                ),
            )
        if selected is None:
            selected = presets.get(default_voice)
        if not isinstance(selected, dict):
            selected = next((value for value in presets.values() if isinstance(value, dict)), None)
        if not isinstance(selected, dict):
            raise RuntimeError("VieNeu voice asset contains no voice")
        embedding = selected.get("speaker_emb") or selected.get("speaker_embedding")
        codes = selected.get("codes") or selected.get("ref_codes")
        if embedding is None or codes is None:
            raise RuntimeError("VieNeu voice asset is incomplete")
        return np.asarray(embedding, dtype=np.float32), strip_encoder_pad_frame(np.asarray(codes, dtype=np.int64))

    def handle(self, payload: dict[str, Any]) -> dict[str, Any]:
        self.check_model(payload)
        if payload.get("op") != "synthesize":
            raise WorkerInputError("unsupported TTS operation")
        text = safe_text(payload.get("text"), "text")
        try:
            chunks, gaps = self._normalize_chunks(text, max_chars=256)
            audio_chunks = []
            for chunk in chunks:
                phonemes = self._phonemize(chunk)
                max_frames = min(300, int(self._max_expected_frames(phonemes)))
                if max_frames <= 0:
                    continue
                audio = self._engine.infer(
                    phonemes=phonemes,
                    speaker_emb=self._speaker_embedding,
                    ref_codes=self._reference_codes,
                    use_ref_codes=True,
                    max_new_frames=max_frames,
                    temperature=0.8,
                    top_k=25,
                    top_p=0.95,
                    repetition_penalty=1.2,
                )
                audio_chunks.append(self._np.asarray(audio, dtype=self._np.float32).reshape(-1))
            if not audio_chunks:
                raise RuntimeError("TTS generated no audio")
            audio = self._join_audio_chunks(
                audio_chunks,
                SAMPLE_RATE_TTS,
                silence_ps=self._gaps_to_silence(gaps),
            )
            return self._wav_response(audio)
        except WorkerInputError:
            raise
        except Exception as exc:
            raise RuntimeError("TTS inference failed") from exc

    def _wav_response(self, audio: Any) -> dict[str, Any]:
        samples = self._np.asarray(audio, dtype=self._np.float32).reshape(-1)
        samples = self._np.clip(samples, -1.0, 1.0)
        pcm = (samples * 32767.0).astype("<i2").tobytes()
        output = io.BytesIO()
        with wave.open(output, "wb") as wav_file:
            wav_file.setnchannels(1)
            wav_file.setsampwidth(2)
            wav_file.setframerate(SAMPLE_RATE_TTS)
            wav_file.writeframes(pcm)
        return {
            "audioBase64": base64.b64encode(output.getvalue()).decode("ascii"),
            "mimeType": "audio/wav",
            "sampleRate": SAMPLE_RATE_TTS,
            "channels": 1,
            "durationMs": round(len(samples) / SAMPLE_RATE_TTS * 1000),
        }


def build_runtime(args: argparse.Namespace) -> RuntimeBase:
    model_path = resolve_existing_directory(args.model_path, "model")
    if args.role == "stt":
        return SttRuntime(model_path, args.threads, args.compute_type, args.vad_threshold, args.silence_ms)
    if args.role == "translation":
        return TranslationRuntime(model_path, args.threads)
    codec_path = resolve_existing_directory(args.codec_path, "codec")
    return TtsRuntime(model_path, codec_path, args.threads, args.voice)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="VietDub local JSONL inference worker")
    parser.add_argument("--role", choices=("stt", "translation", "tts"), required=True)
    parser.add_argument("--model-path", required=True)
    parser.add_argument("--codec-path", default="")
    parser.add_argument("--threads", type=int, default=6)
    parser.add_argument("--compute-type", default="int8")
    parser.add_argument("--vad-threshold", type=float, default=0.01)
    parser.add_argument("--silence-ms", type=int, default=500)
    parser.add_argument("--voice", default="Minh Đức")
    args = parser.parse_args()
    if args.threads < 1 or args.silence_ms < 1 or args.vad_threshold < 0:
        parser.error("worker limits are invalid")
    if args.role == "tts" and not args.codec_path:
        parser.error("--codec-path is required for TTS")
    return args


def run() -> int:
    args = parse_args()
    # Backend Node gửi JSONL UTF-8; đặt encoding rõ ràng để không phụ thuộc code page Windows.
    if hasattr(sys.stdin, "reconfigure"):
        sys.stdin.reconfigure(encoding="utf-8", errors="strict")
    try:
        runtime = build_runtime(args)
    except Exception as exc:
        print(f"worker startup failed: {type(exc).__name__}", file=sys.stderr, flush=True)
        return 1

    emit({"event": "ready"})
    for line in sys.stdin:
        if not line.strip():
            continue
        payload: dict[str, Any] | None = None
        try:
            parsed = json.loads(line)
            if not isinstance(parsed, dict):
                raise WorkerInputError("request must be a JSON object")
            payload = parsed
            identifier = request_id(payload)
            result = runtime.handle(payload)
            emit({"id": identifier, "ok": True, "result": result})
        except Exception as exc:
            identifier = payload.get("id") if isinstance(payload, dict) and isinstance(payload.get("id"), str) else "unknown"
            if isinstance(exc, WorkerInputError):
                message = str(exc)
            else:
                message = "local inference request failed"
            emit({"id": identifier, "ok": False, "error": message})
    return 0


if __name__ == "__main__":
    raise SystemExit(run())
