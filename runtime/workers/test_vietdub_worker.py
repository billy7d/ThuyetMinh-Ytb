"""Kiểm thử logic gom câu STT và hủy request của worker, không cần nạp model thật.

Chạy: python -m unittest runtime/workers/test_vietdub_worker.py
"""

from __future__ import annotations

import base64
import math
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import numpy as np  # noqa: E402

import text_rules  # noqa: E402
import vietdub_worker as worker  # noqa: E402

SAMPLE_RATE = worker.SAMPLE_RATE_STT


def tone(duration_ms: int, amplitude: float, frequency: float = 220.0) -> np.ndarray:
    count = int(SAMPLE_RATE * duration_ms / 1000)
    t = np.arange(count, dtype=np.float32) / SAMPLE_RATE
    return (amplitude * np.sin(2 * math.pi * frequency * t)).astype(np.float32)


def to_pcm(samples: np.ndarray) -> bytes:
    return (np.clip(samples, -1.0, 1.0) * 32767).astype("<i2").tobytes()


class FakeStt(worker.SttRuntime):
    """SttRuntime không nạp Whisper; ghi lại các đoạn audio được đưa đi nhận dạng."""

    def __init__(self, **kwargs: object) -> None:
        self._np = np
        self._vad_threshold = float(kwargs.get("vad_threshold", 0.006))
        self._silence_limit_ms = float(kwargs.get("silence_ms", 400))
        self._soft_max_utterance_ms = float(kwargs.get("soft_max", 5000))
        self._max_utterance_ms = float(kwargs.get("hard_max", 7000))
        self._whisper_vad = False
        self._sessions = {}
        self._segment_counter = 0
        self.model_path = Path("/model")
        self.transcribed: list[tuple[float, float]] = []
        self.next_text = ""

    def check_model(self, payload: dict) -> None:
        return None

    def _transcribe(self, pcm: bytes, start_ms: float) -> list[dict]:
        duration = len(pcm) / 2 / SAMPLE_RATE * 1000
        self.transcribed.append((start_ms, duration))
        text = self.next_text or "x"
        return [{"kind": "final", "segmentId": f"t{len(self.transcribed)}", "text": text, "startMs": start_ms, "endMs": start_ms + duration}]


def feed(runtime: FakeStt, samples: np.ndarray, start_ms: float = 0.0, chunk_ms: int = 250) -> list[dict]:
    runtime.handle({"op": "start_stream", "sessionId": "s", "sampleRate": SAMPLE_RATE, "channels": 1})
    events: list[dict] = []
    step = int(SAMPLE_RATE * chunk_ms / 1000)
    for index in range(0, len(samples), step):
        chunk = samples[index:index + step]
        events.extend(runtime.handle({
            "op": "audio_chunk",
            "sessionId": "s",
            "pcmBase64": base64.b64encode(to_pcm(chunk)).decode("ascii"),
            "timestampMs": start_ms + index / SAMPLE_RATE * 1000,
            "durationMs": len(chunk) / SAMPLE_RATE * 1000,
            "sampleRate": SAMPLE_RATE,
            "channels": 1,
        })["events"])
    return events


class SegmentationTests(unittest.TestCase):
    def test_flushes_after_short_silence(self) -> None:
        runtime = FakeStt()
        audio = np.concatenate([tone(1500, 0.2), np.zeros(int(SAMPLE_RATE * 0.8), dtype=np.float32)])
        events = feed(runtime, audio)
        self.assertEqual(len(events), 1)
        start_ms, duration = runtime.transcribed[0]
        self.assertLessEqual(start_ms, 20)
        self.assertLess(duration, 2200)

    def test_continuous_music_is_cut_before_hard_limit(self) -> None:
        # Nhạc nền liên tục không có khoảng lặng: trước đây phải chờ 10 s mới cắt.
        runtime = FakeStt()
        audio = tone(16000, 0.25) * (1.0 + 0.3 * np.sin(np.arange(int(SAMPLE_RATE * 16)) / SAMPLE_RATE * 2 * math.pi * 0.7)).astype(np.float32)
        feed(runtime, audio)
        self.assertGreaterEqual(len(runtime.transcribed), 2)
        for _, duration in runtime.transcribed:
            self.assertLessEqual(duration, 7000 + 1)

    def test_marks_utterance_cut_for_length_but_not_cut_by_silence(self) -> None:
        # Cắt vì quá dài (người nói chưa ngừng): câu còn tiếp ở đoạn sau nên phải báo cho bên dịch chờ phần nối tiếp.
        runtime = FakeStt()
        audio = tone(16000, 0.25) * (1.0 + 0.3 * np.sin(np.arange(int(SAMPLE_RATE * 16)) / SAMPLE_RATE * 2 * math.pi * 0.7)).astype(np.float32)
        events = feed(runtime, audio)
        self.assertTrue(events)
        self.assertTrue(all(event.get("endedMidSpeech") is True for event in events))
        # Người nói ngừng thật (khoảng lặng dài) thì không phải cắt giữa chừng.
        runtime = FakeStt()
        audio = np.concatenate([tone(1500, 0.2), np.zeros(int(SAMPLE_RATE * 0.8), dtype=np.float32)])
        events = feed(runtime, audio)
        self.assertEqual(len(events), 1)
        self.assertNotIn("endedMidSpeech", events[0])

    def test_cuts_at_quiet_gap_near_soft_limit(self) -> None:
        runtime = FakeStt()
        loud = tone(4400, 0.3)
        gap = np.full(int(SAMPLE_RATE * 0.2), 0.0, dtype=np.float32) + tone(200, 0.02)
        audio = np.concatenate([loud, gap, tone(3000, 0.3), np.zeros(int(SAMPLE_RATE * 0.6), dtype=np.float32)])
        feed(runtime, audio)
        self.assertGreaterEqual(len(runtime.transcribed), 2)
        first_start, first_duration = runtime.transcribed[0]
        # Điểm cắt phải rơi vào khoảng lặng ngắn quanh giây 4.4–4.6, không kéo tới giới hạn cứng.
        self.assertGreater(first_start + first_duration, 4300)
        self.assertLess(first_start + first_duration, 4800)
        second_start, _ = runtime.transcribed[1]
        self.assertAlmostEqual(second_start, first_start + first_duration, delta=21)

    def test_timeline_is_continuous_across_coalesced_chunks(self) -> None:
        runtime = FakeStt()
        audio = np.concatenate([np.zeros(int(SAMPLE_RATE * 1.0), dtype=np.float32), tone(1000, 0.2), np.zeros(int(SAMPLE_RATE * 0.6), dtype=np.float32)])
        # Backend gom nhiều chunk thành một request lớn khi worker bận.
        feed(runtime, audio, start_ms=30_000, chunk_ms=1300)
        start_ms, _ = runtime.transcribed[0]
        self.assertAlmostEqual(start_ms, 30_800, delta=60)

    def test_quiet_noise_does_not_trigger_transcription(self) -> None:
        runtime = FakeStt()
        rng = np.random.default_rng(1)
        audio = (rng.standard_normal(int(SAMPLE_RATE * 3)) * 0.001).astype(np.float32)
        self.assertEqual(feed(runtime, audio), [])
        self.assertEqual(runtime.transcribed, [])

    def test_discard_end_stream_skips_transcription(self) -> None:
        runtime = FakeStt()
        feed(runtime, tone(1000, 0.2))
        result = runtime.handle({"op": "end_stream", "sessionId": "s", "discard": True})
        self.assertEqual(result, {"events": []})
        self.assertEqual(runtime.transcribed, [])


class SanitizeTranscriptTests(unittest.TestCase):
    def test_collapses_whisper_repetition_loop(self) -> None:
        text = "Hello, this is a locally generated English " + "English " * 300
        cleaned = worker.sanitize_transcript(text, 3.8)
        self.assertLessEqual(len(cleaned), int(3.8 * worker.MAX_CHARS_PER_SECOND))
        self.assertNotIn("English English English", cleaned)
        self.assertTrue(cleaned.startswith("Hello, this is a locally generated English"))

    def test_collapses_repeated_phrases(self) -> None:
        cleaned = worker.sanitize_transcript("thank you for watching " * 20, 10.0)
        self.assertEqual(cleaned, "thank you for watching thank you for watching")

    def test_keeps_normal_sentence(self) -> None:
        sentence = "We really, really want to go home now."
        self.assertEqual(worker.sanitize_transcript(sentence, 3.0), sentence)

    def test_collapse_keeps_vietnamese_translation_intact(self) -> None:
        text = "Xin chào, đây là mẫu tiếng Anh. Tiếng Anh tiếng Anh tiếng Anh tiếng Anh tiếng Anh"
        cleaned = worker.collapse_repetitions(text)
        self.assertTrue(cleaned.startswith("Xin chào, đây là mẫu tiếng Anh."))
        self.assertLess(len(cleaned), len(text))

    def test_strips_music_symbols_and_non_speech_tags(self) -> None:
        self.assertEqual(worker.strip_non_speech("♪ There will be ♪ ♪"), "There will be")
        self.assertEqual(worker.strip_non_speech("[Music] Good morning. (Laughter)"), "Good morning.")
        self.assertEqual(worker.strip_non_speech("♪♪ [Applause] ♪"), "")
        self.assertEqual(worker.sanitize_transcript("(upbeat music)", 2.0), "")
        self.assertEqual(worker.strip_non_speech("♪ Sẽ có ♪ ♪"), "Sẽ có")

    def test_dedupes_hallucinated_sentence_lists(self) -> None:
        text = "I'm tired. I'm trying to go back. I'm tired. I'm tired. I'm fine. I'm fine."
        self.assertEqual(worker.dedupe_sentences(text), "I'm tired. I'm trying to go back. I'm fine.")
        self.assertEqual(worker.dedupe_sentences("Good morning. How are you?"), "Good morning. How are you?")

    def test_hallucination_gate_keeps_confident_speech(self) -> None:
        self.assertFalse(worker.is_probable_hallucination(0.05, -0.30, 1.19))
        self.assertFalse(worker.is_probable_hallucination(0.02, -0.61, 0.62))
        self.assertTrue(worker.is_probable_hallucination(0.7, -1.1, 1.2))
        self.assertTrue(worker.is_probable_hallucination(0.1, -1.4, 1.0))
        self.assertTrue(worker.is_probable_hallucination(0.1, -0.5, 3.1))

    def test_translation_limit_stops_runaway_expansion(self) -> None:
        source = "and so we went over to the"
        self.assertEqual(worker.translation_char_limit(source), 52)
        runaway = "và vì vậy chúng tôi đã đi đến đó và rồi chúng tôi lại đi tiếp đến những nơi khác nữa"
        self.assertLessEqual(len(worker.truncate_words(runaway, worker.translation_char_limit(source))), 52)
        normal = "Tôi đã hoàn toàn bị choáng ngợp bởi toàn bộ chuyện này."
        self.assertEqual(worker.truncate_words(normal, worker.translation_char_limit("I've been blown away by this whole thing.")), normal)
        self.assertEqual(worker.translation_char_limit("Hi."), 40)

    def test_short_segments_keep_minimum_budget(self) -> None:
        self.assertEqual(worker.sanitize_transcript("Hello there, friend.", 0.2), "Hello there, friend.")


class TextRulesTests(unittest.TestCase):
    def test_strips_fillers_but_keeps_real_words(self) -> None:
        self.assertEqual(text_rules.strip_fillers("Um"), "")
        self.assertEqual(text_rules.strip_fillers("Um, so today we start."), "so today we start.")
        self.assertEqual(text_rules.strip_fillers("Hmm... okay."), "okay.")
        self.assertEqual(text_rules.strip_fillers("I mean, it works pretty well."), "it works pretty well.")
        # "um" nằm trong từ khác thì giữ nguyên.
        self.assertEqual(text_rules.strip_fillers("The umbrella is humming."), "The umbrella is humming.")
        self.assertEqual(text_rules.strip_fillers("Alright, let's go."), "Alright, let's go.")

    def test_rewrites_phrases_the_model_mistranslates(self) -> None:
        rewrite = text_rules.rewrite_source_for_translation
        self.assertEqual(rewrite("Don't forget to subscribe."), "Don't forget to sign up.")
        self.assertEqual(rewrite("Hit the like button and subscribe."), "Hit the VDLIKE button and sign up.")
        self.assertEqual(rewrite("Like, comment, and subscribe."), "VDLIKE, comment, and sign up.")
        self.assertEqual(rewrite("I've been blown away by it."), "I've been amazed by it.")
        self.assertEqual(rewrite("Let me show you what I mean."), "Let me show you what I am saying.")
        # "like" thông thường không bị động tới.
        self.assertEqual(rewrite("If you like this video, stay."), "If you like this video, stay.")

    def test_rewrite_profiles_differ_per_model(self) -> None:
        rewrite = text_rules.rewrite_source_for_translation
        # vinai dịch đúng "subscribe" và "what I mean": không viết lại; quy tắc chung vẫn áp dụng.
        self.assertEqual(rewrite("Don't forget to subscribe.", "vinai"), "Don't forget to subscribe.")
        self.assertEqual(rewrite("Let me show you what I mean.", "vinai"), "Let me show you what I mean.")
        self.assertEqual(rewrite("Hit the like button.", "vinai"), "Hit the VDLIKE button.")
        self.assertEqual(rewrite("It's a game changer.", "vinai"), "It's a breakthrough.")
        self.assertEqual(rewrite("Don't forget to subscribe.", "opus"), "Don't forget to sign up.")

    def test_informal_you_becomes_ban_but_guys_and_boys_stay(self) -> None:
        fix = text_rules.fix_vietnamese
        self.assertEqual(fix("Chuyện này sẽ làm cậu ngạc nhiên đấy.", "This will surprise you."), "Chuyện này sẽ làm bạn ngạc nhiên đấy.")
        self.assertEqual(fix("Khỏe không, các cậu?", "What's up, you guys?"), "Khỏe không, các cậu?")
        self.assertEqual(fix("Cậu bé nói với bạn.", "The boy told you."), "Cậu bé nói với bạn.")

    def test_fixes_known_vietnamese_errors_and_second_person(self) -> None:
        fix = text_rules.fix_vietnamese
        self.assertEqual(fix("Nhấn nút VDLIKEEE và để lại ghi chú.", "Hit the like button"), "Nhấn nút Thích và để lại ghi chú.")
        self.assertEqual(fix("Chào mừng trở lại với kênh liên lạc.", "Welcome back to the channel."), "Chào mừng trở lại với kênh.")
        self.assertEqual(fix("Anh có nghe thấy tôi không?", "Can you hear me?"), "Bạn có nghe thấy tôi không?")
        self.assertEqual(fix("Vậy anh nghĩ sao?", "So, what do you think?"), "Vậy bạn nghĩ sao?")
        # "Anh" là tên nước/ngôn ngữ, hoặc nguồn không có ngôi thứ hai: giữ nguyên.
        self.assertEqual(fix("Học tiếng Anh ở nước Anh.", "Do you study English in England?"), "Học tiếng Anh ở nước Anh.")
        self.assertEqual(fix("Anh trai tôi đến.", "My brother came."), "Anh trai tôi đến.")
        self.assertEqual(fix("Anh ấy đến.", "He came to see you, brother."), "Anh ấy đến.")

    def test_replaces_archaic_pronouns_only_when_source_confirms_person(self) -> None:
        fix = text_rules.fix_vietnamese
        self.assertEqual(fix("Ta mang vàng đến cho ngươi.", "I brought you gold."), "Tôi mang vàng đến cho bạn.")
        self.assertEqual(fix("Sarah, hắn quen cổ một tháng.", "Sarah, he'd known her a month."), "Sarah, anh ấy quen cô ấy một tháng.")
        # Không có ngôi tương ứng ở nguồn: không đụng tới ("chúng ta", "cổ" = cái cổ).
        self.assertEqual(fix("Chúng ta cùng đi.", "Let's go together."), "Chúng ta cùng đi.")
        self.assertEqual(fix("Cái cổ áo bị rách.", "Her collar is torn."), "Cái cổ áo bị rách.")
        self.assertEqual(fix("Ta đi đây.", "We are leaving."), "Ta đi đây.")

    def test_removes_word_segmentation_underscores(self) -> None:
        self.assertEqual(text_rules.fix_vietnamese("Nhưng đứa trẻ thứ_ba nói.", "But the third kid said."), "Nhưng đứa trẻ thứ ba nói.")
        self.assertEqual(
            text_rules.fix_vietnamese("Người thứ_ba trả_lời rằng : Frank gởi cái nầy .", "And the third boy said, Frank sent this."),
            "Người thứ ba trả lời rằng: Frank gởi cái nầy.",
        )

    def test_sanitize_transcript_drops_filler_only_text(self) -> None:
        self.assertEqual(worker.sanitize_transcript("Um", 1.0), "")
        self.assertEqual(worker.sanitize_transcript("Um, hello there.", 2.0), "hello there.")


class GlossaryTests(unittest.TestCase):
    TERMS = ["Docker", "Kubernetes", "TensorRT", "WebSocket", "Elasticsearch", "Nginx", "JSON", "API", "transformer"]

    def fix(self, text: str) -> str:
        return text_rules.correct_terms(text, self.TERMS)

    def test_corrects_misheard_terms_and_casing(self) -> None:
        self.assertEqual(self.fix("We use nginx as a proxy."), "We use Nginx as a proxy.")
        self.assertEqual(self.fix("export it to tensor RT."), "export it to TensorRT.")
        self.assertEqual(self.fix("the web socket server and json messages"), "the WebSocket server and JSON messages")
        self.assertEqual(self.fix("it runs on kubernetis today"), "it runs on Kubernetes today")

    def test_does_not_guess_when_too_different(self) -> None:
        self.assertEqual(self.fix("we store logs in lr stick search"), "we store logs in lr stick search")

    def test_never_swallows_neighbouring_words_or_crosses_sentences(self) -> None:
        self.assertEqual(self.fix("We push it to Kubernetes now."), "We push it to Kubernetes now.")
        self.assertEqual(self.fix("Measure with Prometheus. If it fails."), "Measure with Prometheus. If it fails.")
        self.assertEqual(self.fix("the websocket"), "the WebSocket")
        self.assertEqual(self.fix("Ask the transform team."), "Ask the transform team.")

    def test_short_terms_only_fix_casing_not_fuzzy(self) -> None:
        self.assertEqual(self.fix("call the api now"), "call the API now")
        self.assertEqual(self.fix("a pie and a pi"), "a pie and a pi")

    def test_empty_glossary_changes_nothing(self) -> None:
        self.assertEqual(text_rules.correct_terms("anything at all", []), "anything at all")

    def test_load_glossary_accepts_json_and_text_files(self) -> None:
        import tempfile

        with tempfile.TemporaryDirectory() as folder:
            as_json = Path(folder) / "terms.json"
            as_json.write_text('{"terms": ["Kubernetes", "PyTorch", 5, ""]}', encoding="utf-8")
            self.assertEqual(worker.load_glossary(str(as_json)), ["Kubernetes", "PyTorch"])
            as_text = Path(folder) / "terms.txt"
            as_text.write_text("\n".join(["# chú thích", "CUDA", "", "TensorRT", ""]), encoding="utf-8")
            self.assertEqual(worker.load_glossary(str(as_text)), ["CUDA", "TensorRT"])
        self.assertEqual(worker.load_glossary(""), [])

    def test_beam_size_is_validated(self) -> None:
        with self.assertRaises(SystemExit):
            worker.parse_args(["--role", "stt", "--model-path", "x", "--beam-size", "0"])
        self.assertEqual(worker.parse_args(["--role", "stt", "--model-path", "x", "--beam-size", "3"]).beam_size, 3)


class CancellationTests(unittest.TestCase):
    def test_cancelled_session_and_old_generation_are_skipped(self) -> None:
        registry = worker.CancellationRegistry()
        registry.cancel({"sessionId": "stt-1"})
        registry.cancel({"sessionId": "tts-1", "beforeGeneration": 3})
        self.assertTrue(registry.is_cancelled({"op": "audio_chunk", "sessionId": "stt-1"}))
        self.assertTrue(registry.is_cancelled({"op": "synthesize", "sessionId": "tts-1", "generation": 2}))
        self.assertFalse(registry.is_cancelled({"op": "synthesize", "sessionId": "tts-1", "generation": 3}))
        self.assertFalse(registry.is_cancelled({"op": "end_stream", "sessionId": "stt-1"}))
        self.assertFalse(registry.is_cancelled({"op": "audio_chunk", "sessionId": "stt-2"}))

    def test_generation_floor_never_moves_backwards(self) -> None:
        registry = worker.CancellationRegistry()
        registry.cancel({"sessionId": "tts", "beforeGeneration": 5})
        registry.cancel({"sessionId": "tts", "beforeGeneration": 2})
        self.assertTrue(registry.is_cancelled({"op": "synthesize", "sessionId": "tts", "generation": 4}))

    def test_rejects_invalid_cancel(self) -> None:
        registry = worker.CancellationRegistry()
        with self.assertRaises(worker.WorkerInputError):
            registry.cancel({})
        with self.assertRaises(worker.WorkerInputError):
            registry.cancel({"sessionId": "x", "beforeGeneration": -1})


class ArgumentTests(unittest.TestCase):
    def test_rejects_invalid_utterance_limits(self) -> None:
        with self.assertRaises(SystemExit):
            worker.parse_args(["--role", "stt", "--model-path", "x", "--soft-max-utterance-ms", "6000", "--max-utterance-ms", "5000"])

    def test_defaults_bound_latency(self) -> None:
        args = worker.parse_args(["--role", "stt", "--model-path", "x"])
        self.assertLessEqual(args.max_utterance_ms, 7000)
        self.assertTrue(args.whisper_vad)


class TermTranslationTests(unittest.TestCase):
    PATTERNS = text_rules.compile_term_patterns(
        {"transformer": "Transformer", "token": "token", "Stable Diffusion": "Stable Diffusion", "overfitting": "overfitting"}
    )

    def test_replaces_terms_with_placeholders_and_restores_them(self) -> None:
        protected, placeholders = text_rules.protect_terms("The transformer reads each token.", self.PATTERNS)
        self.assertEqual(protected, "The X1 reads each X2.")
        restored, complete = text_rules.restore_terms("X1 đọc từng X2.", placeholders)
        self.assertTrue(complete)
        self.assertEqual(restored, "Transformer đọc từng token.")

    def test_accepts_plurals_but_not_longer_words(self) -> None:
        protected, placeholders = text_rules.protect_terms("Tokens and the tokenizer.", self.PATTERNS)
        self.assertEqual(protected, "X1 and the tokenizer.")
        self.assertEqual(len(placeholders), 1)

    def test_multiword_term_wins_over_its_parts(self) -> None:
        protected, placeholders = text_rules.protect_terms("Stable Diffusion is fast.", self.PATTERNS)
        self.assertEqual(protected, "X1 is fast.")
        self.assertEqual(placeholders, [("X1", "Stable Diffusion")])

    def test_capitalises_term_at_sentence_start_only(self) -> None:
        restored, _ = text_rules.restore_terms("X1 xảy ra khi mô hình học vẹt.", [("X1", "overfitting")])
        self.assertEqual(restored, "Overfitting xảy ra khi mô hình học vẹt.")
        restored, _ = text_rules.restore_terms("Đây là X1. X2 khác.", [("X1", "token"), ("X2", "token")])
        self.assertEqual(restored, "Đây là token. Token khác.")

    def test_reports_incomplete_when_model_drops_a_placeholder(self) -> None:
        restored, complete = text_rules.restore_terms("Mô hình đọc X1.", [("X1", "token"), ("X2", "prompt")])
        self.assertFalse(complete)
        self.assertEqual(restored, "Mô hình đọc token.")

    def test_skips_protection_when_source_already_contains_a_placeholder_lookalike(self) -> None:
        protected, placeholders = text_rules.protect_terms("Point X1 is a token.", self.PATTERNS)
        self.assertEqual(protected, "Point X1 is a token.")
        self.assertEqual(placeholders, [])

    def test_empty_mapping_changes_nothing(self) -> None:
        self.assertEqual(text_rules.protect_terms("A token.", text_rules.compile_term_patterns({})), ("A token.", []))

    def test_pronunciations_only_rewrite_matching_words(self) -> None:
        patterns = text_rules.compile_term_patterns({"CUDA": "Cu-đa"})
        self.assertEqual(text_rules.apply_pronunciations("CUDA chạy nhanh, cuda cũng vậy.", patterns), "Cu-đa chạy nhanh, Cu-đa cũng vậy.")
        self.assertEqual(text_rules.apply_pronunciations("Kubernetes", patterns), "Kubernetes")

    def test_load_glossary_section_reads_only_valid_string_pairs(self) -> None:
        import json
        import tempfile

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "glossary.json"
            path.write_text(
                json.dumps({"terms": ["A"], "translations": {"token": "token", "": "x", "bad": 3}, "pronunciations": []}),
                encoding="utf-8",
            )
            self.assertEqual(worker.load_glossary_section(str(path), "translations"), {"token": "token"})
            self.assertEqual(worker.load_glossary_section(str(path), "pronunciations"), {})
            self.assertEqual(worker.load_glossary_section("", "translations"), {})


class ProperNameTests(unittest.TestCase):
    def names(self, text: str) -> list[str]:
        return [name for _, name in text_rules.protect_names(text)[1]]

    def test_detects_people_places_organisations_and_products(self) -> None:
        self.assertEqual(self.names("Elon Musk said that Tesla will open a factory in Berlin."), ["Elon Musk", "Tesla", "Berlin"])
        self.assertEqual(self.names("She studied at Harvard University and then worked for the United Nations."), ["Harvard University", "United Nations"])
        self.assertEqual(self.names("We visited the Eiffel Tower in New York."), ["Eiffel Tower", "New York"])
        self.assertEqual(self.names("We thought it was a good idea, but the Great Wall of China was closed."), ["Great Wall of China"])
        self.assertEqual(self.names("Bank of America and Wells Fargo reported earnings."), ["Bank of America", "Wells Fargo"])

    def test_sentence_initial_single_words_are_not_names_but_camel_case_and_acronyms_are(self) -> None:
        self.assertEqual(self.names("Today we talk about it. Then Frank sent this."), ["Frank"])
        self.assertEqual(self.names("YouTube and iPhone are popular, said NASA."), ["YouTube", "iPhone", "NASA"])
        self.assertEqual(self.names("Stable Diffusion creates images."), ["Stable Diffusion"])

    def test_months_days_languages_countries_and_common_words_are_translated_normally(self) -> None:
        self.assertEqual(self.names("Last Monday in January he spoke English in France."), [])
        self.assertEqual(self.names("Thank you very much, everyone. Yes, I think so."), [])
        self.assertEqual(self.names("The first boy said, I bring you gold."), [])

    def test_person_titles_are_translated_but_the_name_is_kept(self) -> None:
        self.assertEqual(self.names("Dr. Smith moved here. Prince Harry and President Biden met."), ["Smith", "Harry", "Biden"])

    def test_possessive_suffix_stays_outside_the_placeholder(self) -> None:
        protected, placeholders = text_rules.protect_names("This is Frank's book.")
        self.assertEqual(placeholders, [("X1", "Frank")])
        self.assertEqual(protected, "This is X1's book.")

    def test_only_filter_protects_just_the_requested_names(self) -> None:
        protected, placeholders = text_rules.protect_names(
            "Harvard University is in Cambridge.", 2, only=frozenset({"Harvard University"})
        )
        self.assertEqual(protected, "X3 is in Cambridge.")
        self.assertEqual(placeholders, [("X3", "Harvard University")])

    def test_placeholder_lookalikes_and_like_marker_are_never_names(self) -> None:
        self.assertEqual(self.names("Point X1 and the VDLIKE button."), [])

    def test_camel_case_names_keep_their_case_at_sentence_start(self) -> None:
        restored, complete = text_rules.restore_terms("X1 rất phổ biến.", [("X1", "iPhone")])
        self.assertTrue(complete)
        self.assertEqual(restored, "iPhone rất phổ biến.")


class FakeNameTranslator(worker.TranslationRuntime):
    """TranslationRuntime không nạp model: `_generate` giả lập một model hay dịch mất tên riêng."""

    def __init__(self, keep_names: bool = True) -> None:
        self._term_patterns = text_rules.compile_term_patterns({})
        self._keep_names = keep_names
        self.calls: list[str] = []

    def _generate(self, prepared: str):
        self.calls.append(prepared)
        text = prepared.replace("Harvard University", "Đại học Harvard").replace("She studied at", "Cô học tại")
        return text, 10


class NameVerificationTests(unittest.TestCase):
    def test_translates_once_when_the_model_already_kept_every_name(self) -> None:
        runtime = FakeNameTranslator()
        translated, _ = runtime._translate_prepared("She studied at Berlin.")
        self.assertEqual(translated, "Cô học tại Berlin.")
        self.assertEqual(len(runtime.calls), 1)

    def test_retranslates_with_the_lost_name_protected_and_restores_it_verbatim(self) -> None:
        runtime = FakeNameTranslator()
        translated, _ = runtime._translate_prepared("She studied at Harvard University.")
        self.assertEqual(len(runtime.calls), 2)
        self.assertEqual(runtime.calls[1], "She studied at X1.")
        self.assertEqual(translated, "Cô học tại Harvard University.")

    def test_keep_names_off_never_retranslates(self) -> None:
        runtime = FakeNameTranslator(keep_names=False)
        translated, _ = runtime._translate_prepared("She studied at Harvard University.")
        self.assertEqual(len(runtime.calls), 1)
        self.assertEqual(translated, "Cô học tại Đại học Harvard.")

    def test_translate_names_flag_is_parsed(self) -> None:
        args = worker.parse_args(["--role", "translation", "--model-path", "x"])
        self.assertFalse(args.translate_names)
        self.assertTrue(worker.parse_args(["--role", "translation", "--model-path", "x", "--translate-names"]).translate_names)


class FakeStreamEngine:
    """Engine giả: infer_stream trả các mảng 0.25 s như bản thật trả theo khung."""

    def __init__(self, seconds: float = 3.0, frame_seconds: float = 0.25) -> None:
        self.frames = int(seconds / frame_seconds)
        self.frame_samples = int(frame_seconds * worker.SAMPLE_RATE_TTS)
        self.produced = 0
        self.closed = False

    def infer_stream(self, **kwargs: object):
        try:
            for index in range(self.frames):
                self.produced += 1
                yield np.full(self.frame_samples, 0.1 * ((index % 3) + 1), dtype=np.float32)
        finally:
            self.closed = True


class FakeStreamTts(worker.TtsRuntime):
    def __init__(self, engine: FakeStreamEngine, chunks: list[str] | None = None, gaps: list[float] | None = None) -> None:
        self._np = np
        self._engine = engine
        self._pronunciation_patterns = []
        self._speaker_embedding = None
        self._reference_codes = None
        self._chunks = chunks or ["xin chào"]
        self._gaps = gaps or []
        self.model_path = Path("/model")
        self._normalize_chunks = lambda text, max_chars=256: (self._chunks, ["minor"] * len(self._gaps))
        self._gaps_to_silence = lambda gaps: list(self._gaps)
        self._phonemize = lambda text: text
        self._max_expected_frames = lambda phonemes: 100

    def check_model(self, payload: dict) -> None:
        return None


class TtsStreamTests(unittest.TestCase):
    def run_stream(self, runtime: FakeStreamTts, is_cancelled=lambda: False) -> tuple[list[dict], dict]:
        parts: list[dict] = []
        result = runtime.handle_stream({"op": "synthesize", "text": "xin chào"}, parts.append, is_cancelled)
        return parts, result

    def test_every_engine_chunk_is_forwarded_immediately_and_they_sum_to_the_whole_sentence(self) -> None:
        engine = FakeStreamEngine(seconds=5.0)
        parts, result = self.run_stream(FakeStreamTts(engine))
        durations = [part["durationMs"] for part in parts]
        # Không gộp: gộp làm đoạn kế tiếp tới muộn hơn lúc đoạn trước phát xong (khoảng trống khi phát tăng tốc).
        self.assertEqual(durations, [250] * 20)
        self.assertEqual(sum(durations), result["durationMs"])
        self.assertEqual(result["durationMs"], 5000)
        self.assertEqual([part["index"] for part in parts], list(range(len(parts))))
        self.assertTrue(engine.closed)

    def test_pieces_are_16_bit_mono_pcm_at_48khz(self) -> None:
        parts, _ = self.run_stream(FakeStreamTts(FakeStreamEngine(seconds=1.0)))
        first = parts[0]
        self.assertEqual((first["mimeType"], first["sampleRate"], first["channels"]), ("audio/pcm", 48000, 1))
        raw = base64.b64decode(first["audioBase64"])
        samples = np.frombuffer(raw, dtype="<i2")
        self.assertEqual(len(samples), int(first["durationMs"] / 1000 * 48000))
        self.assertAlmostEqual(float(samples[0]) / 32767, 0.1, places=3)

    def test_silence_between_text_chunks_is_inserted_between_the_audio(self) -> None:
        runtime = FakeStreamTts(FakeStreamEngine(seconds=0.5), chunks=["một", "hai"], gaps=[0.3])
        parts, result = self.run_stream(runtime)
        self.assertEqual(result["durationMs"], 500 + 300 + 500)

    def test_cancel_stops_generation_early_and_closes_the_engine_stream(self) -> None:
        engine = FakeStreamEngine(seconds=10.0)
        runtime = FakeStreamTts(engine)
        calls = {"n": 0}

        def cancelled() -> bool:
            calls["n"] += 1
            return calls["n"] >= 3

        with self.assertRaises(worker.RequestCancelled):
            self.run_stream(runtime, cancelled)
        self.assertLess(engine.produced, 10)
        self.assertTrue(engine.closed)

    def test_no_audio_is_an_error_and_unsupported_ops_are_rejected(self) -> None:
        with self.assertRaises(RuntimeError):
            self.run_stream(FakeStreamTts(FakeStreamEngine(seconds=0.0)))
        with self.assertRaises(worker.WorkerInputError):
            FakeStreamTts(FakeStreamEngine()).handle_stream({"op": "other", "text": "x"}, lambda part: None, lambda: False)

    def test_handle_request_emits_partial_frames_then_the_final_result(self) -> None:
        emitted: list[dict] = []
        original = worker.emit
        worker.emit = emitted.append
        try:
            runtime = FakeStreamTts(FakeStreamEngine(seconds=2.0))
            registry = worker.CancellationRegistry()
            worker.handle_request(runtime, registry, {"id": "r1", "op": "synthesize", "text": "xin chào", "stream": True, "sessionId": "s", "generation": 1})
        finally:
            worker.emit = original
        self.assertTrue(all(frame.get("partial") for frame in emitted[:-1]))
        self.assertGreaterEqual(len(emitted), 3)
        self.assertEqual(emitted[-1]["ok"], True)
        self.assertEqual(emitted[-1]["result"]["durationMs"], 2000)
        self.assertTrue(all(frame["id"] == "r1" for frame in emitted))

    def test_handle_request_reports_cancellation_with_the_cancelled_flag(self) -> None:
        emitted: list[dict] = []
        original = worker.emit
        worker.emit = emitted.append
        try:
            runtime = FakeStreamTts(FakeStreamEngine(seconds=10.0))
            registry = worker.CancellationRegistry()
            payload = {"id": "r2", "op": "synthesize", "text": "xin chào", "stream": True, "sessionId": "s", "generation": 1}
            original_flush_emit = emitted.append

            def cancel_after_first_partial(frame: dict) -> None:
                original_flush_emit(frame)
                if frame.get("partial"):
                    registry.cancel({"sessionId": "s", "beforeGeneration": 2})

            worker.emit = cancel_after_first_partial
            worker.handle_request(runtime, registry, payload)
        finally:
            worker.emit = original
        self.assertEqual(emitted[-1].get("cancelled"), True)
        self.assertEqual(emitted[-1].get("ok"), False)


class TtsGpuOptionTests(unittest.TestCase):
    def test_only_the_heavy_sessions_are_eligible_for_the_gpu(self) -> None:
        for name in ("vieneu_prefill.onnx", "vieneu_decode_step.onnx", "moss_audio_tokenizer_decode_full.onnx", "moss_audio_tokenizer_decode_step.onnx"):
            self.assertTrue(worker.tts_session_runs_on_gpu("E:/models/" + name), name)
        # acoustic chạy từng khung với nhiều phép tính nhỏ nên giữ trên CPU, cùng bộ mã hóa tham chiếu.
        for name in ("vieneu_acoustic_cached.onnx", "moss_audio_tokenizer_encode.onnx"):
            self.assertFalse(worker.tts_session_runs_on_gpu("E:/models/" + name), name)

    def test_missing_or_wrong_gpu_libs_fall_back_to_cpu_without_raising(self) -> None:
        import tempfile

        self.assertFalse(worker.enable_tts_gpu(Path("/definitely/not/here")))
        with tempfile.TemporaryDirectory() as directory:
            self.assertFalse(worker.enable_tts_gpu(Path(directory)))

    def test_flag_is_optional_and_parsed(self) -> None:
        args = worker.parse_args(["--role", "tts", "--model-path", "x", "--codec-path", "y"])
        self.assertEqual(args.tts_gpu_libs, "")
        self.assertEqual(worker.parse_args(["--role", "tts", "--model-path", "x", "--codec-path", "y", "--tts-gpu-libs", "E:/gpu"]).tts_gpu_libs, "E:/gpu")


if __name__ == "__main__":
    unittest.main()
