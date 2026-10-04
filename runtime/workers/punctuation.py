"""Thêm dấu câu, viết hoa và tách câu cho phụ đề tự động (ASR) của YouTube, giữ mốc thời gian từng từ.

Mô hình: 1-800-BAD-CODE/punctuation_fullstop_truecase_english (ONNX, Apache-2.0, ~210 MB). Phụ đề tự động không có dấu câu; ghép câu
theo khoảng ngừng cho ranh giới sai ("But you know even." / "…related to stiffness." + "And Tremor…") làm bản dịch sai nghĩa. Đo trên
video podcast 131 phút: 23 nghìn từ mất ~7.5 s CPU, câu đúng ranh giới hơn hẳn, bản dịch rõ nghĩa hơn (docs/TEST_REPORT.md).
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Any

POST_LABELS = ("<NULL>", "<ACRONYM>", ".", ",", "?")
# Mô hình được huấn luyện với chuỗi tới 256 token; 120 từ tiếng Anh ~150-180 token.
WINDOW_WORDS = 120
# Mô hình hay đoán có ngắt câu ở cuối chuỗi nó được xem: điểm ngắt trong chừng này từ cuối cửa sổ để xử lý lại cùng ngữ cảnh sau.
UNTRUSTED_TAIL_WORDS = 15
FILLERS = frozenset({"um", "uh", "uhm", "erm", "hmm", "mm"})
# Câu dài hơn thì cắt ở dấu phẩy gần giữa câu nhất: giọng đọc câu quá dài phải chờ lâu và khó vừa khung thời gian.
MAX_SENTENCE_MS = 15_000
MAX_SENTENCE_WORDS = 40
MIN_PART_WORDS = 4
MAX_WORD_TAIL_MS = 800


def clean_words(words: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Bỏ từ đệm, thẻ [Music]/[Applause] và từ rỗng; sắp theo thời gian."""
    out = []
    for word in words:
        text = str(word.get("text", "")).strip()
        start = word.get("startMs")
        if not text or not isinstance(start, (int, float)) or text.startswith("[") or text.lower().strip(",.?!") in FILLERS:
            continue
        out.append({"text": text, "startMs": int(start)})
    out.sort(key=lambda item: item["startMs"])
    return out


class Punctuator:
    def __init__(self, model_dir: Path, threads: int = 2) -> None:
        import numpy as np
        import onnxruntime as ort
        import sentencepiece as spm

        self._np = np
        options = ort.SessionOptions()
        options.intra_op_num_threads = max(1, threads)
        self._session = ort.InferenceSession(str(model_dir / "punct_cap_seg_en.onnx"), options, providers=["CPUExecutionProvider"])
        self._sp = spm.SentencePieceProcessor(model_file=str(model_dir / "spe_32k_lc_en.model"))

    def run(self, words: list[str]) -> tuple[list[str], list[bool]]:
        """Từng từ đã thêm dấu câu/viết hoa và cờ "câu kết thúc sau từ này"."""
        pieces = [self._sp.encode(word.lower()) for word in words]
        ids = [self._sp.bos_id()] + [token for word in pieces for token in word] + [self._sp.eos_id()]
        post, cap, seg = self._session.run(
            ["post_preds", "cap_preds", "seg_preds"], {"input_ids": self._np.array([ids], dtype=self._np.int64)}
        )
        out_words: list[str] = []
        ends: list[bool] = []
        position = 1
        for word_tokens in pieces:
            text, punct, boundary = "", "", False
            for token in word_tokens:
                raw = self._sp.id_to_piece(token)
                # Chỉ số viết hoa của mô hình tính cả ký tự "▁" đánh dấu đầu từ.
                shift = 1 if raw.startswith("▁") else 0
                piece = raw.replace("▁", "")
                chars = [ch.upper() if index + shift < 16 and cap[0][position][index + shift] else ch for index, ch in enumerate(piece)]
                label = POST_LABELS[int(post[0][position])]
                if label == "<ACRONYM>":
                    text += "".join(ch + "." for ch in chars)
                else:
                    text += "".join(chars)
                    punct = label if label != "<NULL>" else ""
                boundary = bool(seg[0][position])
                position += 1
            out_words.append(text + punct)
            ends.append(boundary or punct in (".", "?"))
        return out_words, ends


def _word_end_ms(words: list[dict[str, Any]], index: int) -> int:
    start = words[index]["startMs"]
    following = words[index + 1]["startMs"] if index + 1 < len(words) else start + MAX_WORD_TAIL_MS
    return int(min(following, start + MAX_WORD_TAIL_MS))


def _split_long(texts: list[str], timed: list[dict[str, Any]]) -> list[tuple[list[str], list[dict[str, Any]]]]:
    duration = _word_end_ms(timed, len(timed) - 1) - timed[0]["startMs"] if timed else 0
    if len(texts) <= MAX_SENTENCE_WORDS and duration <= MAX_SENTENCE_MS:
        return [(texts, timed)]
    middle = len(texts) / 2
    commas = [i for i, word in enumerate(texts[:-1]) if word.endswith(",") and MIN_PART_WORDS <= i + 1 <= len(texts) - MIN_PART_WORDS]
    cut = min(commas, key=lambda i: abs(i + 1 - middle)) + 1 if commas else None
    if cut is None:
        if len(texts) < 2 * MIN_PART_WORDS:
            return [(texts, timed)]
        cut = int(middle)
    return _split_long(texts[:cut], timed[:cut]) + _split_long(texts[cut:], timed[cut:])


def _sentence_text(texts: list[str]) -> str:
    text = " ".join(texts).strip()
    text = re.sub(r",$", "", text)
    if text and text[0].islower():
        text = text[0].upper() + text[1:]
    return text if re.search(r"[.?!]$", text) else f"{text}."


def segment_words(punctuator: Punctuator, raw_words: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Từ có mốc thời gian -> câu {text, startMs, endMs} đã có dấu câu."""
    words = clean_words(raw_words)
    sentences: list[dict[str, Any]] = []
    pending: list[dict[str, Any]] = []
    index = 0
    while index < len(words) or pending:
        take = WINDOW_WORDS - len(pending)
        window = pending + words[index:index + take]
        index += take
        final_window = index >= len(words)
        texts, ends = punctuator.run([word["text"] for word in window])
        trusted = len(window) if final_window else len(window) - UNTRUSTED_TAIL_WORDS
        cut = max((i for i, end in enumerate(ends) if end and i < trusted), default=-1)
        if final_window or cut < 0:
            # Cửa sổ cuối, hoặc cả cửa sổ không có điểm ngắt tin được (một câu rất dài): nhận hết.
            cut = len(window) - 1
        start = 0
        for i in range(cut + 1):
            if ends[i] or i == cut:
                first = start
                for part_texts, part_timed in _split_long(texts[start:i + 1], window[start:i + 1]):
                    last = first + len(part_timed) - 1
                    sentences.append({
                        "text": _sentence_text(part_texts),
                        "startMs": part_timed[0]["startMs"],
                        "endMs": _word_end_ms(window, last),
                    })
                    first = last + 1
                start = i + 1
        pending = window[cut + 1:]
        if final_window and not pending:
            break
    return [sentence for sentence in sentences if re.search(r"[A-Za-z0-9]", sentence["text"])]
