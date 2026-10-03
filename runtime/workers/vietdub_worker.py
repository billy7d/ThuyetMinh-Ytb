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
import queue
import re
import sys
import threading
import traceback
import wave
from collections import OrderedDict, deque
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from text_rules import (
    MAX_TERM_TRANSLATIONS,
    apply_pronunciations,
    compile_term_patterns,
    correct_terms,
    fix_vietnamese,
    protect_names,
    protect_terms,
    restore_terms,
    rewrite_source_for_translation,
    strip_fillers,
)


MAX_AUDIO_BYTES = 512 * 1024
# Các op nặng có thể bị bỏ qua khi phiên/generation đã bị hủy; op dọn dẹp luôn được xử lý.
CANCELLABLE_OPERATIONS = frozenset({"audio_chunk", "translate", "synthesize"})
MAX_CANCEL_ENTRIES = 512
MAX_TEXT_CHARACTERS = 2400
SAMPLE_RATE_STT = 16_000
SAMPLE_RATE_TTS = 48_000
# 20 s WAV mono 48 kHz ≈ 2.6 MB base64; backend cho worker TTS khung 8 MB nên luôn còn dư.
MAX_TTS_SECONDS = 20
TRANSLATION_BEAMS = 4

# Cố định chế độ offline trước khi nạp thư viện có khả năng dùng Hugging Face Hub.
os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"
os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"


class WorkerInputError(ValueError):
    """Lỗi request có thông báo an toàn, không đưa nội dung riêng tư ra ngoài."""


_STDOUT_LOCK = threading.Lock()


def emit(payload: dict[str, Any]) -> None:
    """Ghi một JSON frame và flush ngay để backend nhận được phản hồi."""
    line = json.dumps(payload, ensure_ascii=True, separators=(",", ":")) + "\n"
    # Luồng đọc stdin trả lời lệnh cancel song song với luồng suy luận; khóa để frame không bị trộn.
    with _STDOUT_LOCK:
        sys.stdout.write(line)
        sys.stdout.flush()


def log_error(context: str) -> None:
    """Ghi traceback ra stderr; backend chuyển stderr vào file log local, không gửi ra trình duyệt."""
    print(f"[vietdub-worker] {context}", file=sys.stderr, flush=True)
    traceback.print_exc(file=sys.stderr)
    sys.stderr.flush()


def log_info(message: str) -> None:
    print(f"[vietdub-worker] {message}", file=sys.stderr, flush=True)


DEVICE_CHOICES = ("auto", "cpu", "cuda")
CT2_CONVERSION_METADATA = "vietdub-conversion.json"


def enable_cuda_libraries() -> None:
    """Cho CTranslate2 tìm thấy cuBLAS/cuDNN cài bằng gói pip nvidia-*-cu12 trong venv.

    CTranslate2 nạp các DLL này khi chạy model lần đầu theo PATH (không theo os.add_dll_directory), nên phải thêm cả hai.
    """
    import importlib.util

    spec = importlib.util.find_spec("nvidia")
    for root in (spec.submodule_search_locations or []) if spec else []:
        for library in ("cublas", "cudnn"):
            for sub in ("bin", "lib"):
                directory = Path(root) / library / sub
                if not directory.is_dir():
                    continue
                if hasattr(os, "add_dll_directory"):
                    os.add_dll_directory(str(directory))
                os.environ["PATH"] = str(directory) + os.pathsep + os.environ.get("PATH", "")


def load_on_best_device(requested: str, load_cuda: Any, load_cpu: Any) -> str:
    """Nạp model trên GPU khi được yêu cầu/khả dụng; "auto" lùi về CPU nếu GPU lỗi. Trả về nhãn backend đã chọn."""
    if requested in ("auto", "cuda"):
        try:
            enable_cuda_libraries()
            import ctranslate2

            if ctranslate2.get_cuda_device_count() < 1:
                raise RuntimeError("no CUDA device")
            label = load_cuda()
            log_info(f"backend={label}")
            return label
        except Exception:
            if requested == "cuda":
                raise
            log_error("GPU unavailable; falling back to CPU")
    label = load_cpu()
    log_info(f"backend={label}")
    return label


def verify_ct2_conversion(ct2_path: Path, source_path: Path) -> None:
    """Bản CTranslate2 là dữ liệu dẫn xuất từ model đã kiểm tra hash: chỉ nhận khi đúng nguồn (kích thước + SHA-256 ghi lúc chuyển)."""
    metadata_path = ct2_path / CT2_CONVERSION_METADATA
    if not (ct2_path / "model.bin").is_file() or not metadata_path.is_file():
        raise RuntimeError("CTranslate2 translation model or conversion metadata is missing")
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    source_file = source_path / str(metadata.get("sourceFile", ""))
    if not source_file.is_file() or source_file.stat().st_size != metadata.get("sourceSizeBytes"):
        raise RuntimeError("CTranslate2 translation model was converted from a different source model")


class CancellationRegistry:
    """Theo dõi phiên/generation đã hủy để bỏ qua request còn xếp hàng của phiên cũ."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._cancelled: OrderedDict[str, bool] = OrderedDict()
        self._min_generation: OrderedDict[str, int] = OrderedDict()

    @staticmethod
    def _remember(store: OrderedDict, key: str, value: Any) -> None:
        store[key] = value
        store.move_to_end(key)
        while len(store) > MAX_CANCEL_ENTRIES:
            store.popitem(last=False)

    def cancel(self, payload: dict[str, Any]) -> None:
        key = payload.get("sessionId")
        if not isinstance(key, str) or not key:
            raise WorkerInputError("sessionId is required")
        before_generation = payload.get("beforeGeneration")
        with self._lock:
            if before_generation is None:
                self._remember(self._cancelled, key, True)
                return
            if not isinstance(before_generation, int) or before_generation < 0:
                raise WorkerInputError("beforeGeneration is invalid")
            current = self._min_generation.get(key, 0)
            self._remember(self._min_generation, key, max(current, before_generation))

    def is_cancelled(self, payload: dict[str, Any]) -> bool:
        if payload.get("op") not in CANCELLABLE_OPERATIONS:
            return False
        key = payload.get("sessionId")
        if not isinstance(key, str):
            return False
        generation = payload.get("generation")
        with self._lock:
            if self._cancelled.get(key):
                return True
            minimum = self._min_generation.get(key)
            return isinstance(generation, int) and minimum is not None and generation < minimum


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


MAX_REPEATED_NGRAM = 6
# Tiếng Anh nói nhanh khoảng 15–20 ký tự/giây; vượt xa mức này gần như chắc chắn là Whisper lặp ảo giác.
MAX_CHARS_PER_SECOND = 25.0


NON_SPEECH_TAG = re.compile(
    r"[\[(（]\s*(?:music|applause|laughter|laughs|laughing|cheering|cheers|silence|inaudible|noise|"
    r"background noise|crowd|sighs?|coughs?|upbeat music|dramatic music|mus?ic playing|blank_audio)[^\])）]*[\])）]",
    re.IGNORECASE,
)
MUSIC_SYMBOLS = re.compile(r"[♪♫♬♩🎵🎶]+")


def strip_non_speech(text: str) -> str:
    """Bỏ ký hiệu nhạc và nhãn phi lời thoại ([Music], (Laughter)…) mà Whisper chèn vào; không có chữ thì trả rỗng."""
    cleaned = MUSIC_SYMBOLS.sub(" ", NON_SPEECH_TAG.sub(" ", text))
    cleaned = re.sub(r"\s+", " ", cleaned).strip(" -–—,;:")
    return cleaned if re.search(r"[A-Za-zÀ-ỹ0-9]", cleaned) else ""


def sanitize_transcript(text: str, duration_s: float) -> str:
    """Loại vòng lặp ảo giác của Whisper ("English English English…") và giới hạn độ dài theo thời lượng audio."""
    text = strip_fillers(dedupe_sentences(collapse_repetitions(strip_non_speech(text))))
    return truncate_words(text, int(max(40.0, duration_s * MAX_CHARS_PER_SECOND)))


def dedupe_sentences(text: str) -> str:
    """Bỏ câu lặp lại trong cùng một đoạn ("I'm tired. I'm fine. I'm tired.") — dấu hiệu Whisper ảo giác trên nhạc/tiếng ồn."""
    sentences = re.findall(r"[^.!?…]+[.!?…]*", text)
    seen: set[str] = set()
    kept: list[str] = []
    for sentence in sentences:
        key = re.sub(r"[^a-z0-9À-ỹ']+", " ", sentence.lower()).strip()
        if not key:
            continue
        if key in seen:
            continue
        seen.add(key)
        kept.append(sentence.strip())
    return " ".join(kept)


def is_probable_hallucination(no_speech_prob: float, avg_logprob: float, compression_ratio: float) -> bool:
    """Ngưỡng theo khuyến nghị của Whisper: nhiều khả năng không có lời nói, hoặc độ tin cậy/độ lặp bất thường."""
    if no_speech_prob > 0.6 and avg_logprob < -1.0:
        return True
    if no_speech_prob > 0.5 and avg_logprob < -0.8:
        return True
    return avg_logprob < -1.2 or compression_ratio > 2.4


def translation_char_limit(source_text: str) -> int:
    """Độ dài tối đa của bản dịch tiếng Việt cho một câu nguồn.

    Bản dịch bình thường dài ~0.9–1.4 lần câu tiếng Anh. OPUS-MT dịch mảnh câu đôi khi "bịa" thêm gấp
    ba; giọng đọc khi đó dài gấp mấy lần lời gốc và kéo toàn bộ thuyết minh (cùng phụ đề đồng bộ) trễ dồn.
    """
    return max(40, int(len(source_text.strip()) * 2.0))


def truncate_words(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    cut = text.rfind(" ", 0, limit)
    return text[: cut if cut > 0 else limit].rstrip(",;: ").strip()


def collapse_repetitions(text: str) -> str:
    """Giữ tối đa hai lần lặp liên tiếp của một cụm 1–6 từ; model sinh lặp nhiều hơn là dấu hiệu ảo giác."""
    words = text.split()
    if not words:
        return ""
    changed = True
    while changed:
        changed = False
        for size in range(1, MAX_REPEATED_NGRAM + 1):
            index = 0
            result: list[str] = []
            while index < len(words):
                gram = words[index:index + size]
                repeats = 1
                while (
                    len(gram) == size
                    and words[index + repeats * size:index + (repeats + 1) * size] == gram
                ):
                    repeats += 1
                if len(gram) == size and repeats > 2:
                    # Giữ tối đa hai lần lặp liên tiếp; lặp nhiều hơn là dấu hiệu ảo giác.
                    result.extend(gram * 2)
                    index += repeats * size
                    changed = True
                else:
                    result.append(words[index])
                    index += 1
            words = result
    return " ".join(words).strip()


FRAME_MS = 20
FRAME_BYTES = SAMPLE_RATE_STT * FRAME_MS // 1000 * 2
PRE_ROLL_FRAMES = 10
MIN_SPEECH_MS = 300.0


@dataclass
class AudioSession:
    """Trạng thái gom câu của một stream STT; mọi mốc thời gian tính theo thời gian video (ms)."""

    buffer: bytearray = field(default_factory=bytearray)
    energies: list[float] = field(default_factory=list)
    start_ms: float | None = None
    silence_ms: float = 0.0
    speech_ms: float = 0.0
    noise_floor: float = 0.0
    pre_roll: deque = field(default_factory=lambda: deque(maxlen=PRE_ROLL_FRAMES))
    pre_roll_start_ms: deque = field(default_factory=lambda: deque(maxlen=PRE_ROLL_FRAMES))
    remainder: bytearray = field(default_factory=bytearray)
    next_frame_ms: float | None = None


MAX_GLOSSARY_TERMS = 200


def load_glossary(path: str) -> list[str]:
    """Đọc từ điển thuật ngữ chuyên ngành (JSON mảng chuỗi hoặc {"terms": [...]}, hoặc mỗi dòng một thuật ngữ)."""
    if not path:
        return []
    raw = Path(path).read_text(encoding="utf-8")
    try:
        parsed = json.loads(raw)
        terms = parsed.get("terms", []) if isinstance(parsed, dict) else parsed
    except json.JSONDecodeError:
        terms = [line.strip() for line in raw.splitlines() if line.strip() and not line.lstrip().startswith("#")]
    cleaned = [str(term).strip() for term in terms if isinstance(term, str) and term.strip()]
    return cleaned[:MAX_GLOSSARY_TERMS]


def load_glossary_section(path: str, key: str) -> dict[str, str]:
    """Đọc mục {"translations": {...}} hoặc {"pronunciations": {...}} của file từ điển: thuật ngữ tiếng Anh -> dạng mong muốn."""
    if not path:
        return {}
    try:
        parsed = json.loads(Path(path).read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}
    section = parsed.get(key) if isinstance(parsed, dict) else None
    if not isinstance(section, dict):
        return {}
    cleaned = {
        source.strip(): target.strip()
        for source, target in section.items()
        if isinstance(source, str) and isinstance(target, str) and source.strip() and target.strip()
    }
    return dict(list(cleaned.items())[:MAX_TERM_TRANSLATIONS])


def _looks_like_placeholder(token: str) -> bool:
    """Câu nguồn đã chứa chuỗi giống ký hiệu giữ chỗ (X1, X2...): không bảo vệ tên để khỏi nhầm khi đặt lại."""
    stripped = token.strip(".,;:!?\"'()[]")
    return len(stripped) >= 2 and stripped[0] == "X" and stripped[1:].isdigit()


class SttRuntime(RuntimeBase):
    def __init__(
        self,
        model_path: Path,
        threads: int,
        compute_type: str,
        vad_threshold: float,
        silence_ms: int,
        soft_max_utterance_ms: int = 3500,
        max_utterance_ms: int = 5000,
        whisper_vad: bool = True,
        device: str = "cpu",
        gpu_compute_type: str = "int8_float16",
        cpu_model_path: Path | None = None,
        beam_size: int = 1,
        glossary: list[str] | None = None,
    ) -> None:
        super().__init__(model_path)
        try:
            import numpy as np
            from faster_whisper import WhisperModel
        except ImportError as exc:
            raise RuntimeError("STT dependencies are not installed") from exc

        self._np = np

        def load(target: str, target_compute_type: str, weights: Path) -> str:
            self._model = WhisperModel(
                str(weights),
                device=target,
                compute_type=target_compute_type,
                cpu_threads=threads,
                num_workers=1,
                local_files_only=True,
            )
            # Chạy thử 1 s im lặng (không VAD) để nạp cuBLAS/cuDNN và cấp phát bộ nhớ ngay lúc khởi động,
            # thay vì làm câu đầu tiên của người dùng trễ thêm ~1 s; lỗi GPU cũng lộ ra ở đây để còn lùi về CPU.
            list(self._model.transcribe(np.zeros(SAMPLE_RATE_STT, dtype=np.float32), language="en", vad_filter=False)[0])
            return f"{target}-{target_compute_type}:{weights.name}"

        # GPU int8_float16 trên GTX 1660 SUPER: small.en 0.42 s cho 3.5 s audio, nhanh hơn base.en trên CPU (0.69 s).
        self.backend = load_on_best_device(
            device,
            lambda: load("cuda", gpu_compute_type, model_path),
            # Model lớn cho GPU (small.en) quá chậm trên CPU 6 nhân (2.1 s/lượt nói): khi phải lùi về CPU thì dùng
            # model nhỏ đã cài (base.en) để vẫn theo kịp thời gian thực.
            lambda: load("cpu", compute_type, cpu_model_path or model_path),
        )
        self._vad_threshold = vad_threshold
        self._silence_limit_ms = float(silence_ms)
        self._soft_max_utterance_ms = float(soft_max_utterance_ms)
        self._max_utterance_ms = float(max(max_utterance_ms, soft_max_utterance_ms))
        self._whisper_vad = whisper_vad
        self._beam_size = beam_size
        self._glossary = glossary or []
        self._sessions: dict[str, AudioSession] = {}
        self._segment_counter = 0
        log_info(f"stt beam={beam_size} glossary={len(self._glossary)}")

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
            if session is None or payload.get("discard") is True:
                return {"events": []}
            return {"events": self._flush(session, len(session.buffer))}
        raise WorkerInputError("unsupported STT operation")

    def discard_session(self, session_id: str) -> None:
        self._sessions.pop(session_id, None)

    def _require_audio_format(self, payload: dict[str, Any]) -> None:
        if payload.get("sampleRate") != SAMPLE_RATE_STT or payload.get("channels") != 1:
            raise WorkerInputError("STT requires mono 16 kHz PCM")

    def _speech_threshold(self, session: AudioSession) -> float:
        # Ngưỡng thích nghi: nhạc nền/tiếng ồn làm nền năng lượng tăng, nên chỉ tiếng nói nổi bật hơn nền mới tính là speech.
        return max(self._vad_threshold, session.noise_floor * 1.8)

    def _update_noise_floor(self, session: AudioSession, energy: float) -> None:
        # Nền giảm nhanh khi gặp khung yên tĩnh, tăng rất chậm (hằng số ~40 s) để tiếng nói không bị coi là nền.
        if session.noise_floor <= 0.0:
            session.noise_floor = min(energy, self._vad_threshold)
        elif energy < session.noise_floor:
            session.noise_floor = session.noise_floor * 0.9 + energy * 0.1
        else:
            session.noise_floor = session.noise_floor * 0.9995 + energy * 0.0005

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

        # Nếu timeline video nhảy (tua/đổi video), bỏ phần lẻ của khung cũ để mốc thời gian không lệch.
        if session.next_frame_ms is None or abs(session.next_frame_ms - timestamp_ms) > 1000:
            session.remainder.clear()
            session.next_frame_ms = timestamp_ms
        data = bytes(session.remainder) + pcm
        session.remainder.clear()

        events: list[dict[str, Any]] = []
        offset = 0
        while offset + FRAME_BYTES <= len(data):
            frame = data[offset:offset + FRAME_BYTES]
            offset += FRAME_BYTES
            frame_start_ms = session.next_frame_ms
            session.next_frame_ms = frame_start_ms + FRAME_MS
            events.extend(self._process_frame(session, frame, frame_start_ms))
        session.remainder.extend(data[offset:])
        return events

    def _process_frame(self, session: AudioSession, frame: bytes, frame_start_ms: float) -> list[dict[str, Any]]:
        samples = self._np.frombuffer(frame, dtype=self._np.int16).astype(self._np.float32) / 32768.0
        energy = float(self._np.sqrt(self._np.mean(samples ** 2))) if samples.size else 0.0
        is_speech = energy >= self._speech_threshold(session)
        self._update_noise_floor(session, energy)

        if session.start_ms is None:
            if not is_speech:
                session.pre_roll.append(frame)
                session.pre_roll_start_ms.append(frame_start_ms)
                return []
            # Giữ khoảng 200 ms trước khi phát hiện speech để không mất âm đầu của từ.
            session.start_ms = session.pre_roll_start_ms[0] if session.pre_roll_start_ms else frame_start_ms
            for pre_frame in session.pre_roll:
                session.buffer.extend(pre_frame)
                session.energies.append(0.0)
            session.pre_roll.clear()
            session.pre_roll_start_ms.clear()

        session.buffer.extend(frame)
        session.energies.append(energy)
        if is_speech:
            session.speech_ms += FRAME_MS
            session.silence_ms = 0.0
        else:
            session.silence_ms += FRAME_MS

        if session.silence_ms >= self._silence_limit_ms:
            return self._flush(session, len(session.buffer))

        utterance_ms = len(session.energies) * FRAME_MS
        if utterance_ms >= self._soft_max_utterance_ms:
            cut_frame = self._find_cut_frame(session, utterance_ms >= self._max_utterance_ms)
            if cut_frame is not None:
                return self._flush(session, cut_frame * FRAME_BYTES, mid_speech=True)
        return []

    def _find_cut_frame(self, session: AudioSession, force: bool) -> int | None:
        """Tìm khoảng lặng ngắn nhất gần cuối câu để cắt, tránh cắt giữa từ khi người nói không ngừng."""
        np = self._np
        energies = np.asarray(session.energies, dtype=np.float32)
        total = energies.size
        window = 5
        search_frames = int(2500 / FRAME_MS) if force else int(1500 / FRAME_MS)
        low = max(window, total - search_frames)
        high = total - 5
        if high <= low:
            return total if force else None
        smoothed = np.convolve(energies, np.ones(window, dtype=np.float32) / window, mode="same")
        region = smoothed[low:high]
        index = int(np.argmin(region)) + low
        if force:
            return index
        speech_energies = energies[energies > 0]
        reference = float(np.median(speech_energies)) if speech_energies.size else 0.0
        return index if float(smoothed[index]) <= reference * 0.6 else None

    def _flush(self, session: AudioSession, cut_bytes: int, mid_speech: bool = False) -> list[dict[str, Any]]:
        if session.start_ms is None or not session.buffer:
            self._reset_utterance(session)
            return []
        cut_bytes = max(0, min(len(session.buffer), cut_bytes - cut_bytes % FRAME_BYTES))
        cut_frames = cut_bytes // FRAME_BYTES
        head = bytes(session.buffer[:cut_bytes])
        tail = bytes(session.buffer[cut_bytes:])
        tail_energies = session.energies[cut_frames:]
        start_ms = session.start_ms
        speech_ms = session.speech_ms
        threshold = self._speech_threshold(session)

        self._reset_utterance(session)
        if tail:
            # Phần sau điểm cắt trở thành đầu câu tiếp theo để không mất chữ.
            session.buffer.extend(tail)
            session.energies.extend(tail_energies)
            session.start_ms = start_ms + cut_frames * FRAME_MS
            session.speech_ms = sum(FRAME_MS for value in tail_energies if value >= threshold)
            speech_ms -= session.speech_ms

        if not head or speech_ms < MIN_SPEECH_MS:
            return []
        events = self._transcribe(head, start_ms)
        if mid_speech and events:
            # Cắt vì quá dài chứ không phải vì người nói ngừng: câu còn tiếp ở đoạn sau. Dấu chấm Whisper tự thêm vào cuối
            # đoạn này không đáng tin; bên dịch dùng cờ này để chờ phần nối tiếp rồi mới dịch.
            events[-1]["endedMidSpeech"] = True
        return events

    @staticmethod
    def _reset_utterance(session: AudioSession) -> None:
        session.buffer.clear()
        session.energies.clear()
        session.start_ms = None
        session.silence_ms = 0.0
        session.speech_ms = 0.0

    def _transcribe(self, pcm: bytes, start_ms: float) -> list[dict[str, Any]]:
        audio = self._np.frombuffer(pcm, dtype=self._np.int16).astype(self._np.float32) / 32768.0
        try:
            segments, _ = self._model.transcribe(
                audio,
                language="en",
                task="transcribe",
                beam_size=self._beam_size,
                best_of=1,
                # Nhiệt độ 0 trước; chỉ khi đầu ra lặp bất thường (compression ratio cao) mới thử lại ở nhiệt độ cao hơn.
                temperature=(0.0, 0.2, 0.4),
                compression_ratio_threshold=2.4,
                log_prob_threshold=-1.0,
                no_repeat_ngram_size=3,
                condition_on_previous_text=False,
                # Silero VAD đi kèm faster-whisper (file local) loại bỏ đoạn chỉ có nhạc để giảm ảo giác.
                vad_filter=self._whisper_vad,
                vad_parameters={"min_silence_duration_ms": 300, "speech_pad_ms": 200} if self._whisper_vad else None,
                word_timestamps=False,
            )
            events: list[dict[str, Any]] = []
            for segment in segments:
                avg_logprob = float(getattr(segment, "avg_logprob", 0.0))
                no_speech_prob = float(getattr(segment, "no_speech_prob", 0.0))
                compression_ratio = float(getattr(segment, "compression_ratio", 0.0))
                if is_probable_hallucination(no_speech_prob, avg_logprob, compression_ratio):
                    continue
                duration_s = max(0.0, float(segment.end) - float(segment.start))
                text = sanitize_transcript(str(segment.text or ""), duration_s)
                if not text:
                    continue
                if self._glossary:
                    text = correct_terms(text, self._glossary)
                self._segment_counter += 1
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
    """Dịch Anh→Việt. Hỗ trợ OPUS-MT (Marian) và vinai-translate-en2vi (mBART, mã ngôn ngữ en_XX/vi_VN).

    Có bản chuyển đổi CTranslate2 thì chạy bằng CTranslate2 (GPU nếu có, CPU int8 nếu không): đo trên GTX 1660 SUPER/i5-9400F
    nhanh hơn PyTorch CPU 4–5 lần với bản dịch tương đương. Không có thì dùng PyTorch."""

    def __init__(
        self,
        model_path: Path,
        threads: int,
        ct2_model_path: Path | None = None,
        device: str = "cpu",
        gpu_compute_type: str = "int8_float16",
        term_translations: dict[str, str] | None = None,
        keep_names: bool = True,
    ) -> None:
        super().__init__(model_path)
        self._term_patterns = compile_term_patterns(term_translations or {})
        self._keep_names = keep_names
        try:
            from transformers import AutoTokenizer
        except ImportError as exc:
            raise RuntimeError("translation dependencies are not installed") from exc
        try:
            model_type = json.loads((model_path / "config.json").read_text(encoding="utf-8")).get("model_type")
            self._target_prefix: list[list[str]] | None = None
            # Quy tắc viết lại câu nguồn được đo riêng cho từng model (xem text_rules.REWRITE_PROFILES).
            self._rewrite_profile = "vinai" if model_type == "mbart" else "opus"
            if model_type == "mbart":
                from transformers import MBartTokenizer

                # vinai-translate không kèm tokenizer_config.json: dựng tokenizer trực tiếp từ sentencepiece.bpe.model.
                self._tokenizer = MBartTokenizer(
                    vocab_file=str(model_path / "sentencepiece.bpe.model"), src_lang="en_XX", tgt_lang="vi_VN"
                )
                self._target_prefix = [["vi_VN"]]
            else:
                self._tokenizer = AutoTokenizer.from_pretrained(str(model_path), local_files_only=True)
        except Exception as exc:
            raise RuntimeError("translation tokenizer could not be loaded locally") from exc

        self._translator: Any = None
        self._model: Any = None
        self.backend = "torch-cpu"
        if ct2_model_path is not None:
            verify_ct2_conversion(ct2_model_path, model_path)
            import ctranslate2

            def load(target: str, compute_type: str) -> Any:
                translator = ctranslate2.Translator(
                    str(ct2_model_path), device=target, compute_type=compute_type, inter_threads=1, intra_threads=threads
                )
                self._translator = translator
                self._generate("Hello there.")  # nạp cuBLAS ngay, không để câu đầu tiên chịu trễ
                return translator

            self.backend = load_on_best_device(
                device,
                lambda: (load("cuda", gpu_compute_type), f"ct2-cuda-{gpu_compute_type}")[1],
                lambda: (load("cpu", "int8"), "ct2-cpu-int8")[1],
            )
            return
        try:
            import torch
            from transformers import AutoModelForSeq2SeqLM
        except ImportError as exc:
            raise RuntimeError("translation dependencies are not installed") from exc
        torch.set_num_threads(threads)
        try:
            self._torch = torch
            self._model = AutoModelForSeq2SeqLM.from_pretrained(str(model_path), local_files_only=True)
            self._model.eval()
        except Exception as exc:
            raise RuntimeError("translation model could not be loaded locally") from exc
        log_info(f"translation backend={self.backend}")

    def _translate_tokens(self, tokens: list[str], translator: Any = None) -> list[str]:
        result = (translator or self._translator).translate_batch(
            [tokens],
            beam_size=TRANSLATION_BEAMS,
            max_decoding_length=min(256, len(tokens) * 2 + 10),
            no_repeat_ngram_size=4,
            target_prefix=self._target_prefix,
        )
        output = result[0].hypotheses[0]
        # mBART bắt đầu đầu ra bằng mã ngôn ngữ đích (đã đưa vào target_prefix): bỏ nó đi.
        return output[1:] if self._target_prefix and output and output[0] == self._target_prefix[0][0] else output

    def _generate(self, prepared: str) -> tuple[str, int]:
        if self._translator is not None:
            ids = self._tokenizer.encode(prepared, truncation=True, max_length=256)
            output = self._translate_tokens(self._tokenizer.convert_ids_to_tokens(ids))
            text = self._tokenizer.decode(self._tokenizer.convert_tokens_to_ids(output), skip_special_tokens=True)
            return text.strip(), len(ids) + len(output)
        encoded = self._tokenizer(prepared, return_tensors="pt", truncation=True, max_length=256)
        input_tokens = int(encoded["input_ids"].shape[-1])
        with self._torch.inference_mode():
            generated = self._model.generate(
                **encoded,
                # Bản dịch hiếm khi dài hơn ~2.5 lần số token nguồn; giới hạn này chặn vòng lặp sinh vô hạn.
                max_new_tokens=min(256, input_tokens * 2 + 10),
                # Beam search cho bản dịch đúng hơn rõ rệt (xem docs/TEST_REPORT.md) với chi phí ~+120 ms/câu.
                num_beams=TRANSLATION_BEAMS,
                do_sample=False,
                no_repeat_ngram_size=4,
            )
        text = self._tokenizer.batch_decode(generated, skip_special_tokens=True)[0].strip()
        return text, int(encoded["input_ids"].numel() + generated.numel())

    def _translate_prepared(self, prepared: str) -> tuple[str, int]:
        """Dịch một câu, giữ thuật ngữ trong từ điển và tên riêng đúng nguyên văn tiếng Anh.

        Dịch bình thường trước (model đã giữ nguyên phần lớn tên như Berlin, Tesla; thay tên bằng ký hiệu giữ chỗ làm câu xung quanh
        kém tự nhiên: "ở Paris" -> "trong Paris"). Chỉ khi tên nào bị dịch mất ("Harvard University" -> "Đại học Harvard") mới dịch lại
        câu đó với riêng các tên ấy được giữ chỗ."""
        protected, placeholders = protect_terms(prepared, self._term_patterns)
        translated, token_count = self._generate(protected)
        if placeholders:
            restored, complete = restore_terms(translated, placeholders)
            if complete:
                translated = restored
            else:
                # Model bỏ mất ký hiệu giữ chỗ: dịch lại không bảo vệ còn hơn mất thuật ngữ khỏi câu.
                protected, placeholders = prepared, []
                translated, token_count = self._generate(prepared)
        if not self._keep_names or any(_looks_like_placeholder(token) for token in prepared.split()):
            return translated, token_count
        _, candidates = protect_names(protected)
        lowered = translated.casefold()
        missing = frozenset(name for _, name in candidates if name.casefold() not in lowered)
        if not missing:
            return translated, token_count
        name_protected, name_placeholders = protect_names(protected, len(placeholders), only=missing)
        retranslated, retranslated_tokens = self._generate(name_protected)
        restored, complete = restore_terms(retranslated, placeholders + name_placeholders)
        if complete:
            return restored, retranslated_tokens
        return translated, token_count

    def handle(self, payload: dict[str, Any]) -> dict[str, Any]:
        self.check_model(payload)
        if payload.get("op") != "translate":
            raise WorkerInputError("unsupported translation operation")
        source_text = safe_text(payload.get("sourceText"), "sourceText")
        try:
            prepared = rewrite_source_for_translation(strip_fillers(source_text), self._rewrite_profile)
            if not prepared:
                raise WorkerInputError("translation contains no speech")
            translated, token_count = self._translate_prepared(prepared)
            translated = fix_vietnamese(translated, source_text)
            translated = truncate_words(collapse_repetitions(strip_non_speech(translated)), translation_char_limit(source_text))
            if not translated:
                raise WorkerInputError("translation contains no speech")
            return {"translatedText": translated, "tokensUsed": token_count}
        except WorkerInputError:
            raise
        except Exception as exc:
            raise RuntimeError("translation inference failed") from exc


class TtsRuntime(RuntimeBase):
    def __init__(
        self, model_path: Path, codec_path: Path, threads: int, voice: str, pronunciations: dict[str, str] | None = None
    ) -> None:
        super().__init__(model_path)
        self._pronunciation_patterns = compile_term_patterns(pronunciations or {})
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
            chunks, gaps = self._normalize_chunks(apply_pronunciations(text, self._pronunciation_patterns), max_chars=256)
            audio_chunks = []
            total_samples = 0
            for chunk in chunks:
                # Câu thuyết minh quá dài vừa trễ vừa làm khung JSONL phình to; dừng khi đủ thời lượng tối đa.
                if total_samples >= MAX_TTS_SECONDS * SAMPLE_RATE_TTS:
                    break
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
                total_samples += audio_chunks[-1].size
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
        return SttRuntime(
            model_path,
            args.threads,
            args.compute_type,
            args.vad_threshold,
            args.silence_ms,
            soft_max_utterance_ms=args.soft_max_utterance_ms,
            max_utterance_ms=args.max_utterance_ms,
            whisper_vad=args.whisper_vad,
            device=args.device,
            gpu_compute_type=args.gpu_compute_type,
            cpu_model_path=resolve_existing_directory(args.cpu_model_path, "CPU fallback model") if args.cpu_model_path else None,
            beam_size=args.beam_size,
            glossary=load_glossary(args.glossary_file),
        )
    if args.role == "translation":
        ct2_path = resolve_existing_directory(args.ct2_model_path, "CTranslate2 model") if args.ct2_model_path else None
        return TranslationRuntime(
            model_path, args.threads, ct2_path, args.device, args.gpu_compute_type,
            term_translations=load_glossary_section(args.glossary_file, "translations"),
            keep_names=not args.translate_names,
        )
    codec_path = resolve_existing_directory(args.codec_path, "codec")
    return TtsRuntime(
        model_path, codec_path, args.threads, args.voice,
        pronunciations=load_glossary_section(args.glossary_file, "pronunciations"),
    )


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="VietDub local JSONL inference worker")
    parser.add_argument("--role", choices=("stt", "translation", "tts"), required=True)
    parser.add_argument("--model-path", required=True)
    parser.add_argument("--codec-path", default="")
    parser.add_argument("--threads", type=int, default=2)
    parser.add_argument("--compute-type", default="int8")
    parser.add_argument("--vad-threshold", type=float, default=0.006)
    parser.add_argument("--silence-ms", type=int, default=300)
    parser.add_argument("--soft-max-utterance-ms", type=int, default=3500)
    parser.add_argument("--max-utterance-ms", type=int, default=5000)
    parser.add_argument("--whisper-vad", dest="whisper_vad", action="store_true", default=True)
    parser.add_argument("--no-whisper-vad", dest="whisper_vad", action="store_false")
    parser.add_argument("--voice", default="Minh Đức")
    # auto: dùng GPU NVIDIA nếu có (cần gói nvidia-cublas-cu12 + nvidia-cudnn-cu12), lỗi thì lùi về CPU.
    parser.add_argument("--device", choices=DEVICE_CHOICES, default="cpu")
    parser.add_argument("--gpu-compute-type", default="int8_float16")
    parser.add_argument("--ct2-model-path", default="")
    # STT: beam search trên GPU gần như không tốn thêm thời gian (beam 3: 484 ms so với 490 ms của beam 1, xem TEST_REPORT).
    parser.add_argument("--beam-size", type=int, default=1)
    # Đã đo và KHÔNG dùng initial_prompt (ngữ cảnh câu trước làm Whisper lặp lại câu trước: 9.4% lỗi so với 5.0%) hay hotwords
    # (sửa đúng thuật ngữ nhưng chèn từ thừa ở chỗ khác); xem docs/TEST_REPORT.md. Thuật ngữ được sửa sau nhận dạng.
    parser.add_argument("--glossary-file", default="", help="từ điển thuật ngữ chuyên ngành để sửa lỗi nghe nhầm (JSON hoặc mỗi dòng một thuật ngữ)")
    parser.add_argument("--translate-names", action="store_true", help="dịch cả tên riêng (mặc định giữ nguyên tiếng Anh)")
    parser.add_argument("--cpu-model-path", default="", help="STT: model dùng khi phải chạy CPU (mặc định = --model-path)")
    args = parser.parse_args(argv)
    if (
        args.threads < 1
        or args.silence_ms < FRAME_MS
        or args.vad_threshold < 0
        or args.soft_max_utterance_ms < 1000
        or args.max_utterance_ms < args.soft_max_utterance_ms
        or args.max_utterance_ms > 15000
        or not 1 <= args.beam_size <= 8
    ):
        parser.error("worker limits are invalid")
    if args.role == "tts" and not args.codec_path:
        parser.error("--codec-path is required for TTS")
    return args


_STOP = object()


def read_requests(requests: "queue.Queue[Any]", cancellations: CancellationRegistry) -> None:
    """Đọc stdin ở luồng riêng: lệnh cancel được xử lý ngay, không phải chờ suy luận đang chạy."""
    try:
        for line in sys.stdin:
            if not line.strip():
                continue
            try:
                parsed = json.loads(line)
            except ValueError:
                emit({"id": "unknown", "ok": False, "error": "request must be valid JSON"})
                continue
            if isinstance(parsed, dict) and parsed.get("op") == "cancel":
                identifier = parsed.get("id") if isinstance(parsed.get("id"), str) else "unknown"
                try:
                    cancellations.cancel(parsed)
                    emit({"id": identifier, "ok": True, "result": {}})
                except WorkerInputError as exc:
                    emit({"id": identifier, "ok": False, "error": str(exc)})
                continue
            requests.put(parsed)
    finally:
        requests.put(_STOP)


def handle_request(runtime: RuntimeBase, cancellations: CancellationRegistry, parsed: Any) -> None:
    payload: dict[str, Any] | None = None
    try:
        if not isinstance(parsed, dict):
            raise WorkerInputError("request must be a JSON object")
        payload = parsed
        identifier = request_id(payload)
        if cancellations.is_cancelled(payload):
            # Request của phiên/generation đã hủy: trả lời ngay để hàng đợi phiên mới không bị chặn.
            if isinstance(runtime, SttRuntime) and isinstance(payload.get("sessionId"), str):
                runtime.discard_session(payload["sessionId"])
            emit({"id": identifier, "ok": False, "error": "request was cancelled", "cancelled": True})
            return
        result = runtime.handle(payload)
        emit({"id": identifier, "ok": True, "result": result})
    except Exception as exc:
        identifier = payload.get("id") if isinstance(payload, dict) and isinstance(payload.get("id"), str) else "unknown"
        if isinstance(exc, WorkerInputError):
            message = str(exc)
        else:
            log_error(f"request failed op={payload.get('op') if isinstance(payload, dict) else 'unknown'}")
            message = "local inference request failed"
        emit({"id": identifier, "ok": False, "error": message})


def run() -> int:
    args = parse_args()
    # Backend Node gửi JSONL UTF-8; đặt encoding rõ ràng để không phụ thuộc code page Windows.
    if hasattr(sys.stdin, "reconfigure"):
        sys.stdin.reconfigure(encoding="utf-8", errors="strict")
    try:
        runtime = build_runtime(args)
    except Exception as exc:
        print(f"worker startup failed: {type(exc).__name__}", file=sys.stderr, flush=True)
        log_error("startup failed")
        return 1

    cancellations = CancellationRegistry()
    requests: "queue.Queue[Any]" = queue.Queue()
    reader = threading.Thread(target=read_requests, args=(requests, cancellations), daemon=True)
    reader.start()
    emit({"event": "ready"})
    while True:
        parsed = requests.get()
        if parsed is _STOP:
            break
        handle_request(runtime, cancellations, parsed)
    return 0


if __name__ == "__main__":
    raise SystemExit(run())
