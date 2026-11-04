"""Bộ tách từ mBART (vinai-translate-en2vi) chỉ dùng sentencepiece, thay cho transformers.MBartTokenizer.

Import transformers kéo theo PyTorch và mất ~13 s mỗi lần bật worker dịch (đo trên i5-9400F), trong khi đường CTranslate2 chỉ cần
chuỗi token. Lớp này làm đúng như MBartTokenizer (bản chậm) của transformers 4.57: câu nguồn = các mảnh sentencepiece + "</s>" +
mã ngôn ngữ nguồn, cắt còn tối đa max_length token; giải mã bỏ token đặc biệt rồi đổi "▁" thành dấu cách. Đã so khớp với
transformers trên toàn bộ câu kiểm thử (test_vietdub_worker.py).
"""

from __future__ import annotations

from pathlib import Path

SPIECE_UNDERLINE = "▁"
# Token đặc biệt của fairseq/mBART và 25 mã ngôn ngữ của mbart-large-cc25 (theo thứ tự id, sau từ vựng sentencepiece).
FAIRSEQ_SPECIAL_TOKENS = ("<s>", "<pad>", "</s>", "<unk>")
LANGUAGE_CODES = (
    "ar_AR", "cs_CZ", "de_DE", "en_XX", "es_XX", "et_EE", "fi_FI", "fr_XX", "gu_IN", "hi_IN", "it_IT", "ja_XX", "kk_KZ",
    "ko_KR", "lt_LT", "lv_LV", "my_MM", "ne_NP", "nl_XX", "ro_RO", "ru_RU", "si_LK", "tr_TR", "vi_VN", "zh_CN",
)
SPECIAL_TOKENS = frozenset((*FAIRSEQ_SPECIAL_TOKENS, "<mask>", *LANGUAGE_CODES))


class MBartPieceTokenizer:
    def __init__(self, sentencepiece_model: Path, src_lang: str = "en_XX") -> None:
        import sentencepiece

        if src_lang not in LANGUAGE_CODES:
            raise ValueError(f"unknown mBART language code: {src_lang}")
        self._sp = sentencepiece.SentencePieceProcessor()
        self._sp.Load(str(sentencepiece_model))
        self._src_lang = src_lang
        self._unk_id = self._sp.unk_id()

    def encode_tokens(self, text: str, max_length: int = 256) -> list[str]:
        """Token đầu vào cho CTranslate2 (giống convert_ids_to_tokens(encode(text, truncation=True, max_length)))."""
        pieces = self._split_on_special_tokens(text)
        suffix = ["</s>", self._src_lang]
        return pieces[: max(0, max_length - len(suffix))] + suffix

    def decode_tokens(self, tokens: list[str]) -> str:
        """Giống decode(convert_tokens_to_ids(tokens), skip_special_tokens=True)."""
        kept = [token for token in tokens if token not in SPECIAL_TOKENS and self._sp.PieceToId(token) != self._unk_id]
        return "".join(kept).replace(SPIECE_UNDERLINE, " ").strip()

    def _split_on_special_tokens(self, text: str) -> list[str]:
        # transformers tách các token đặc biệt viết sẵn trong câu (vd "</s>", "en_XX") ra trước, phần còn lại mới qua sentencepiece;
        # khoảng trắng hai bên token đặc biệt bị bỏ (lstrip/rstrip của AddedToken mặc định của MBart là False nên chỉ cắt bằng strip()).
        tokens: list[str] = []
        for chunk, is_special in self._chunks(text):
            if is_special:
                tokens.append(chunk)
            elif chunk.strip():
                tokens.extend(self._pieces(chunk))
        return tokens

    def _pieces(self, text: str) -> list[str]:
        pieces = self._sp.EncodeAsPieces(text)
        return ["<unk>" if self._sp.PieceToId(piece) == self._unk_id else piece for piece in pieces]

    @staticmethod
    def _chunks(text: str) -> list[tuple[str, bool]]:
        chunks: list[tuple[str, bool]] = []
        start = index = 0
        while index < len(text):
            match = next((token for token in SPECIAL_TOKENS if text.startswith(token, index)), None)
            if match is None:
                index += 1
                continue
            chunks.append((text[start:index], False))
            chunks.append((match, True))
            index += len(match)
            start = index
        chunks.append((text[start:], False))
        return chunks
