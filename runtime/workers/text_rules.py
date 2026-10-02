"""Quy tắc văn bản cho worker dịch: sửa các lỗi dịch có hệ thống của OPUS-MT en-vi.

Mọi quy tắc đều có bằng chứng đo thực tế (xem docs/TEST_REPORT.md): mô hình dịch từng chữ các thành ngữ
và thuật ngữ nền tảng video ("subscribe" -> "viết nghiêng", "like button" -> "nút thích hợp",
"Um" -> "Nhóm:"). Bảng quy tắc cố ý nhỏ và chỉ chứa lỗi đã quan sát được; không thay thế cho việc nâng cấp model.
"""

from __future__ import annotations

import re

# Từ đệm không mang nghĩa; Whisper chép lại còn mô hình dịch thì cho ra "Nhóm:", "Ừm"…
_FILLER_WORD = r"(?:um+|uh+|uhm+|er+m?|erm+|hm+|hmm+|mm+|mhm+|ah+)"
_FILLER = re.compile(rf"(?<![\w'’]){_FILLER_WORD}(?![\w'’])[,.!?…]*\s*", re.IGNORECASE)
_DISCOURSE_FILLER = re.compile(r"(?:(?<=,)|^)\s*you know,\s*|,\s*you know(?=[,.?!])|^\s*i mean,\s*", re.IGNORECASE)

# Token giữ chỗ cho tên nút "Thích" của nền tảng video: model sao chép nguyên token (đôi khi kéo dài thêm chữ cái cuối).
LIKE_TOKEN = "VDLIKE"

def _compile(rules: tuple[tuple[str, str], ...]) -> tuple[tuple[re.Pattern[str], str], ...]:
    return tuple((re.compile(pattern, re.IGNORECASE), replacement) for pattern, replacement in rules)


# Quy tắc có lợi với mọi model (đo trên cả OPUS-MT và vinai-translate).
_COMMON_REWRITES = _compile((
    # Nút Like: OPUS "nút thích hợp"/"nút giống như nút", vinai "nút like"/"ngón tay cái lên".
    (r"\bgive (it|this video|the video|us|me) (?:a )?(?:like|thumbs[- ]up)\b", rf"{LIKE_TOKEN} \1"),
    (r"\b(?:the )?(?:like|thumbs[- ]up) button\b", f"the {LIKE_TOKEN} button"),
    (r"\blike(?=,\s*(?:comment|share|and))", LIKE_TOKEN),
    # Thành ngữ bị dịch từng chữ ("bị thổi bay đi", "nó sẽ thay đổi cuộc chơi").
    (r"\bblown away\b", "amazed"),
    (r"\bblew (me|us|you) away\b", r"amazed \1"),
    (r"\bgame[- ]?changer\b", "breakthrough"),
    (r"\bblow your mind\b", "surprise you"),
))

# Chỉ OPUS-MT cần: vinai đã dịch đúng "subscribe", còn "what I mean" viết lại lại làm câu của vinai tệ đi
# ("tôi đang nói gì" thay vì "điều tôi muốn nói").
_OPUS_ONLY_REWRITES = _compile((
    # "subscribe" bị dịch thành "viết nghiêng"/"phụ thuộc"/"ghi đè"; "sign up" cho ra "đăng ký".
    (r"\bsubscribers\b", "followers"),
    (r"\bsubscribed\b", "signed up"),
    (r"\bsubscribe\b", "sign up"),
    (r"\bsubscription\b", "sign-up"),
    (r"\bwhat i mean\b", "what I am saying"),
))

REWRITE_PROFILES = {"opus": _COMMON_REWRITES + _OPUS_ONLY_REWRITES, "vinai": _COMMON_REWRITES}

_WORD_SEGMENT_UNDERSCORE = re.compile(r"(?<=[^\W\d_])_+(?=[^\W\d_])")
_SPACE_BEFORE_PUNCTUATION = re.compile(r"\s+(?=[,.:;!?…])")
_LIKE_RESULT = re.compile(rf"{LIKE_TOKEN}\w*")
_VIETNAMESE_FIXES: tuple[tuple[re.Pattern[str], str], ...] = tuple(
    (re.compile(pattern, re.IGNORECASE), replacement)
    for pattern, replacement in (
        (r"\bviết nghiêng\b", "đăng ký"),
        (r"\bkênh liên lạc\b", "kênh"),
        (r"\bnút thích hợp\b", "nút Thích"),
    )
)

# "you" trong video thường là khán giả: model chọn "anh" ngẫu nhiên; trung tính hơn là "bạn".
_SECOND_PERSON_SOURCE = re.compile(r"\byou(?:r|rs|rself)?\b", re.IGNORECASE)
_SIBLING_OR_MALE_SOURCE = re.compile(r"\b(?:brother|bro|sir|mister|mr|dude|man)\b", re.IGNORECASE)
_ANH = re.compile(
    r"(?<![\w])(?P<prev>tiếng|nước|người|ở|tại|vương quốc|quốc|nền|bằng)?(?P<space>\s*)(?P<word>anh)(?![\w])",
    re.IGNORECASE,
)


# OPUS-MT học từ văn truyện nên đôi khi dùng đại từ cổ/khẩu ngữ ("Ta mang vàng đến cho ngươi", "hắn quen cổ một tháng").
# Chỉ đổi khi ngôi của câu nguồn xác nhận đúng nghĩa để không đụng tới "chúng ta", "cổ" (cái cổ)…
_FIRST_PERSON_SOURCE = re.compile(r"\b(?:i|i'm|i've|i'll|i'd|me|my)\b", re.IGNORECASE)
_HE_SOURCE = re.compile(r"\b(?:he|he's|he'd|he'll|him|his)\b", re.IGNORECASE)
_SHE_SOURCE = re.compile(r"\b(?:she|she's|she'd|she'll|her|hers)\b", re.IGNORECASE)
_BODY_PART_SOURCE = re.compile(r"\b(?:neck|collar|throat)\b", re.IGNORECASE)
_INFORMAL_YOU = re.compile(r"(?<!các )(?<!\w)cậu(?!\w)(?! bé)", re.IGNORECASE)
_ARCHAIC_YOU = re.compile(r"(?<!\w)ngươi(?!\w)", re.IGNORECASE)
_ARCHAIC_I = re.compile(r"(?:^|(?<=[.!?…]\s))Ta(?=\s)")
_ARCHAIC_HE = re.compile(r"(?<!\w)hắn(?!\w)", re.IGNORECASE)
_COLLOQUIAL_SHE = re.compile(r"(?<!\w)cổ(?!\w)")


def _keep_case(replacement: str):
    def apply(match: re.Match[str]) -> str:
        return replacement[0].upper() + replacement[1:] if match.group(0)[0].isupper() else replacement
    return apply


def strip_fillers(text: str) -> str:
    """Bỏ từ đệm ("um", "uh", "hmm", "you know,") khỏi câu; trả về chuỗi rỗng nếu chỉ còn từ đệm."""
    cleaned = _FILLER.sub(" ", text)
    cleaned = _DISCOURSE_FILLER.sub(" ", cleaned)
    cleaned = re.sub(r"\s+([,.!?…])", r"\1", cleaned)
    cleaned = re.sub(r"^[\s,;:.!?…-]+", "", cleaned)
    cleaned = re.sub(r"\s{2,}", " ", cleaned).strip()
    return cleaned if re.search(r"[A-Za-zÀ-ỹ0-9]", cleaned) else ""


def rewrite_source_for_translation(text: str, profile: str = "opus") -> str:
    """Viết lại cụm tiếng Anh mà model dịch sai thành dạng nó dịch đúng (không đổi nghĩa); profile: "opus" hoặc "vinai"."""
    rewritten = text
    for pattern, replacement in REWRITE_PROFILES[profile]:
        rewritten = pattern.sub(replacement, rewritten)
    return rewritten


def fix_vietnamese(translated: str, source_text: str) -> str:
    """Sửa các lỗi dịch đã biết và đại từ ngôi thứ hai sau khi dịch."""
    fixed = _LIKE_RESULT.sub("Thích", translated)
    # OPUS-MT học từ dữ liệu đã tách từ nên đôi khi trả "thứ_ba", "cảm_ơn": đổi gạch dưới giữa hai chữ thành dấu cách.
    fixed = _WORD_SEGMENT_UNDERSCORE.sub(" ", fixed)
    # Cùng nguồn dữ liệu đó để lại dấu cách trước dấu câu ("nói rằng : Frank gởi cái nầy .").
    fixed = _SPACE_BEFORE_PUNCTUATION.sub("", fixed)
    for pattern, replacement in _VIETNAMESE_FIXES:
        fixed = pattern.sub(replacement, fixed)
    if _SECOND_PERSON_SOURCE.search(source_text) and not _SIBLING_OR_MALE_SOURCE.search(source_text):
        def to_ban(match: re.Match[str]) -> str:
            if match.group("prev"):
                return match.group(0)
            return f"{match.group('space')}{'Bạn' if match.group('word')[0].isupper() else 'bạn'}"
        fixed = _ANH.sub(to_ban, fixed)
        fixed = _ARCHAIC_YOU.sub(_keep_case("bạn"), fixed)
        # vinai hay chọn "cậu" cho "you" ("sẽ làm cậu ngạc nhiên đấy"); "các cậu" (guys) và "cậu bé" (boy) giữ nguyên.
        fixed = _INFORMAL_YOU.sub(_keep_case("bạn"), fixed)
    if _FIRST_PERSON_SOURCE.search(source_text):
        fixed = _ARCHAIC_I.sub("Tôi", fixed)
    if _HE_SOURCE.search(source_text):
        fixed = _ARCHAIC_HE.sub(_keep_case("anh ấy"), fixed)
    if _SHE_SOURCE.search(source_text) and not _BODY_PART_SOURCE.search(source_text):
        fixed = _COLLOQUIAL_SHE.sub("cô ấy", fixed)
    return fixed


# ---- Sửa thuật ngữ chuyên ngành sau khi nhận dạng (so khớp mờ với từ điển người dùng) ----
# Gợi ý thuật ngữ trực tiếp cho Whisper (hotwords) đo được: sửa đúng 76/76 thuật ngữ nhưng gây chèn từ thừa ở chỗ khác
# (tổng lỗi 15.8 so với 11.2 trên 219 từ). Sửa ở phía văn bản thì không có rủi ro ảo giác và không tốn độ trễ.
_TERM_KEY = re.compile(r"[^a-z0-9]")
FUZZY_THRESHOLD = 0.86
MAX_LENGTH_DIFF = 2  # lệch quá 2 ký tự nghĩa là cụm chứa thêm cả từ khác ("the websocket"), không phải nghe sai
MIN_FUZZY_LENGTH = 6  # thuật ngữ ngắn (API, GPU, CPU) chỉ sửa chữ hoa/thường, không so khớp mờ để tránh nhầm từ thường


# Từ thông dụng: cụm nhiều từ chứa chúng không được gộp ("to Kubernetes" -> "Kubernetes" sẽ làm mất chữ "to").
_STOPWORDS = frozenset(
    "a an the to of in on at by for with from and or but so if is are was were be it its this that these those as into onto than then there here we i you he she they my your our their".split()
)


def _term_key(text: str) -> str:
    return _TERM_KEY.sub("", text.lower())


def correct_terms(text: str, terms: list[str]) -> str:
    """Thay cụm từ nghe gần giống thuật ngữ trong từ điển bằng đúng cách viết của thuật ngữ ("elastik search" -> "Elasticsearch")."""
    from difflib import SequenceMatcher

    prepared = [(term, _term_key(term)) for term in terms if _term_key(term)]
    if not prepared or not text:
        return text
    tokens = text.split()
    output: list[str] = []
    index = 0
    while index < len(tokens):
        replaced = False
        for size in (3, 2, 1):  # ưu tiên cụm dài ("lr stick search" -> Elasticsearch)
            if index + size > len(tokens):
                continue
            window = tokens[index:index + size]
            # Không ghép qua ranh giới câu ("Prometheus. If").
            if any(re.search(r"[.!?…]$", token) for token in window[:-1]):
                continue
            if size > 1 and any(_term_key(token) in _STOPWORDS for token in window):
                continue
            key = _term_key("".join(window))
            if len(key) < 3:
                continue
            best_term, best_ratio = None, 0.0
            for term, term_key in prepared:
                if key == term_key:
                    best_term, best_ratio = term, 1.0
                    break
                # Từ nghe được chỉ là phần đầu/phần mở rộng của thuật ngữ ("transform" so với "transformer") thường là một từ
                # khác có thật, không phải nghe nhầm: bỏ qua.
                if key.startswith(term_key) or term_key.startswith(key):
                    continue
                if len(term_key) >= MIN_FUZZY_LENGTH and abs(len(key) - len(term_key)) <= MAX_LENGTH_DIFF:
                    ratio = SequenceMatcher(None, key, term_key).ratio()
                    if ratio >= FUZZY_THRESHOLD and ratio > best_ratio:
                        best_term, best_ratio = term, ratio
            if best_term is not None:
                trailing = re.search(r"[.,!?;:…]+$", window[-1])
                output.append(best_term + (trailing.group(0) if trailing else ""))
                index += size
                replaced = True
                break
        if not replaced:
            output.append(tokens[index])
            index += 1
    return " ".join(output)
