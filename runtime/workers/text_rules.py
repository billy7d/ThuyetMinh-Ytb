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


# ---- Thuật ngữ giữ nguyên khi dịch và cách đọc riêng khi thuyết minh ----
# Model dịch hay dịch sát từng chữ thuật ngữ ("transformer" -> "biến đổi", "token" -> "mã thông báo", "Stable Diffusion" ->
# "Ổn định khuếch tán"). Thay thuật ngữ bằng ký hiệu giữ chỗ trước khi dịch rồi đặt lại dạng mong muốn sau khi dịch.
# Đo trên 24 câu kỹ thuật: ký hiệu "X1" giữ nguyên ngữ cảnh xung quanh tốt hơn tên riêng hoặc "QZT1" (hai kiểu kia làm model bỏ mất
# cụm "machine learning" đứng trước thuật ngữ).
MAX_TERM_TRANSLATIONS = 500
_PLACEHOLDER_IN_SOURCE = re.compile(r"\bX\d+\b")
_SENTENCE_START = re.compile(r"(?:^|[.!?…]\s+)$")


def compile_term_patterns(mapping: dict[str, str]) -> list[tuple[re.Pattern[str], str]]:
    """Biên dịch từ điển {thuật ngữ tiếng Anh: dạng trong bản dịch}; cụm dài khớp trước, chấp nhận số nhiều (s/es)."""
    patterns = []
    for source, target in sorted(mapping.items(), key=lambda item: -len(item[0])):
        source, target = source.strip(), target.strip()
        if source and target:
            patterns.append((re.compile(rf"(?<![\w-]){re.escape(source)}(?:s|es)?(?![\w-])", re.IGNORECASE), target))
    return patterns


def protect_terms(text: str, patterns: list[tuple[re.Pattern[str], str]]) -> tuple[str, list[tuple[str, str]]]:
    """Trả (câu đã thay ký hiệu giữ chỗ, danh sách (ký hiệu, dạng đích)). Không làm gì nếu câu đã có sẵn chuỗi giống ký hiệu."""
    if not patterns or _PLACEHOLDER_IN_SOURCE.search(text):
        return text, []
    placeholders: list[tuple[str, str]] = []
    protected = text
    for pattern, target in patterns:
        def replace(_: re.Match[str], target: str = target) -> str:
            token = f"X{len(placeholders) + 1}"
            placeholders.append((token, target))
            return token

        protected = pattern.sub(replace, protected)
    return protected, placeholders


def restore_terms(translated: str, placeholders: list[tuple[str, str]]) -> tuple[str, bool]:
    """Đặt dạng đích vào chỗ ký hiệu. Trả (văn bản, True nếu mọi ký hiệu đều còn trong bản dịch)."""
    restored = translated
    complete = True
    for token, target in placeholders:
        match = re.search(rf"(?<!\w){re.escape(token)}(?!\w)", restored, re.IGNORECASE)
        if match is None:
            complete = False
            continue
        value = target
        if _SENTENCE_START.search(restored[: match.start()]) and value[:1].islower() and not any(c.isupper() for c in value[1:]):
            value = value[:1].upper() + value[1:]
        restored = restored[: match.start()] + value + restored[match.end():]
    return restored, complete


def apply_pronunciations(text: str, patterns: list[tuple[re.Pattern[str], str]]) -> str:
    """Thay thuật ngữ bằng cách viết dễ đọc hơn, chỉ dùng cho văn bản đưa vào TTS (phụ đề giữ nguyên)."""
    spoken = text
    for pattern, target in patterns:
        spoken = pattern.sub(target, spoken)
    return spoken


# ---- Tên riêng giữ nguyên tiếng Anh ----
# Model dịch hay dịch sát chữ tên riêng gồm từ thường ("Silicon Valley" -> "Thung lũng Silicon", "Harvard University" -> "Đại học Harvard",
# "Eiffel Tower" -> "Tháp Eiffel"). Nhận diện tên riêng bằng chữ viết hoa rồi giữ chỗ bằng ký hiệu X<n> như thuật ngữ, đặt lại nguyên văn sau khi dịch.
# Không dùng từ điển tên: viết hoa giữa câu, cụm nhiều từ viết hoa liền nhau (nối bằng of/the), tên dạng camelCase (YouTube, iPhone) và viết tắt
# toàn chữ hoa. Tên đã có cách gọi quen thuộc trong tiếng Việt (Liên Hợp Quốc, Nhà Trắng...) khai báo trong mục "translations" của từ điển
# (áp dụng trước bước này) hoặc nằm trong danh sách bỏ qua dưới đây.
_NAME_TOKEN = re.compile(r"[A-Za-z][A-Za-z0-9]*(?:['\u2019-][A-Za-z0-9]+)*")
_SENTENCE_BOUNDARY_BEFORE = re.compile(r"(?:^|[.!?]['\"\u201d\u2019)\]]*\s+)$")
_PLACEHOLDER_TOKEN = re.compile(r"^X\d+$")
_POSSESSIVE = re.compile(r"(?:'s|\u2019s)$", re.IGNORECASE)

# Từ viết hoa nhưng không phải tên riêng (đầu câu/đầu lời thoại, đại từ, từ nối...).
_COMMON_CAPITALIZED = frozenset(
    """a an the i i'm i've i'll i'd we you he she it they this that these those there here what when where why how who whom whose which
    and but or so if then than because although though while since until unless once as at by for from in into of on onto to with without about
    after before over under between among through during against around not no yes ok okay oh well hello hi hey thanks thank please sorry look now let let's
    do does did can could would should will shall may might must have has had be is are was were am been being get got go going come
    my our your his her their its mine ours yours theirs me us him them also just still even only very really maybe perhaps however
    all some any every each both either neither one two three first second third last next many much more most few less other another such same
    good great new old big small long short high low right left true false today tomorrow yesterday tonight morning evening night
    mr mrs ms miss dr prof sir madam""".split()
)
# Tên có cách gọi tiếng Việt thông dụng hoặc không phải tên riêng cần giữ: dịch bình thường.
_TRANSLATE_NORMALLY = frozenset(
    """january february march april may june july august september october november december
    monday tuesday wednesday thursday friday saturday sunday
    english vietnamese french german spanish italian chinese japanese korean russian portuguese arabic hindi thai latin greek
    american british european asian african canadian australian indian mexican brazilian russian swiss dutch swedish
    america usa us uk england britain france germany spain italy china japan korea russia vietnam india canada australia mexico brazil
    africa europe asia antarctica pacific atlantic
    god christmas easter internet""".split()
)
# Chức danh đứng trước tên người: dịch chức danh ("Tiến sĩ Smith"), chỉ giữ tên.
_PERSON_TITLES = frozenset(
    """mr mrs ms miss dr prof professor doctor president prince princess king queen senator mayor governor captain general
    sir lord lady saint pope minister chancellor judge""".split()
)
_NAME_CONNECTORS = frozenset({"of", "the", "de", "van", "von", "la", "del"})
# Tính từ thường mở đầu tên riêng nhiều từ ("New York", "Great Wall", "Big Ben"); chỉ tính khi từ kế tiếp cũng viết hoa.
_NAME_ADJECTIVE_STARTERS = frozenset({"new", "great", "big", "old", "little", "high", "long", "red", "white", "black", "blue", "green", "golden", "south", "north", "east", "west"})
_TITLE_ABBREVIATION_BEFORE = re.compile(r"\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|Mt)\.\s+$")


def _is_capitalized_name_word(token: str) -> bool:
    return token[:1].isupper() and not _PLACEHOLDER_TOKEN.match(token) and not token.startswith(LIKE_TOKEN)


def _is_camel_case(token: str) -> bool:
    return any(c.isupper() for c in token[1:]) and any(c.islower() for c in token) and not token.isupper()


def _is_acronym(token: str) -> bool:
    return len(token) >= 2 and token.isupper() and token.isalpha()


def protect_names(
    text: str, start_index: int = 0, only: frozenset[str] | None = None
) -> tuple[str, list[tuple[str, str]]]:
    """Thay tên riêng trong câu tiếng Anh bằng ký hiệu giữ chỗ X<n> (đánh số tiếp từ start_index). Trả (câu mới, [(ký hiệu, tên gốc)]).

    only: chỉ thay những tên có trong tập này (dùng khi chỉ cần sửa các tên model đã dịch mất); None = mọi tên nhận diện được."""
    tokens = list(_NAME_TOKEN.finditer(text))
    if not tokens:
        return text, []
    placeholders: list[tuple[str, str]] = []
    replacements: list[tuple[int, int, str]] = []
    index = 0
    while index < len(tokens):
        token = tokens[index]
        word = token.group(0)
        stem = _POSSESSIVE.sub("", word)
        lowered = stem.lower()
        before = text[: token.start()]
        sentence_start = bool(_SENTENCE_BOUNDARY_BEFORE.search(before)) and not _TITLE_ABBREVIATION_BEFORE.search(before)
        camel = _is_camel_case(stem)
        acronym = _is_acronym(stem)
        if not (_is_capitalized_name_word(stem) or camel):
            index += 1
            continue
        if lowered in _TRANSLATE_NORMALLY or lowered in _PERSON_TITLES or stem.startswith(LIKE_TOKEN):
            index += 1
            continue
        starts_name = camel or acronym or lowered not in _COMMON_CAPITALIZED
        if not starts_name and lowered in _NAME_ADJECTIVE_STARTERS and index + 1 < len(tokens) and text[token.end(): tokens[index + 1].start()] == " ":
            following = _POSSESSIVE.sub("", tokens[index + 1].group(0))
            starts_name = _is_capitalized_name_word(following) and following.lower() not in _COMMON_CAPITALIZED and following.lower() not in _TRANSLATE_NORMALLY
        if not starts_name:
            index += 1
            continue
        # Mở rộng thành cụm: các từ viết hoa liền nhau (cách nhau đúng một dấu cách), có thể nối bằng of/the.
        end = index
        while end + 1 < len(tokens):
            nxt = tokens[end + 1]
            gap = text[tokens[end].end(): nxt.start()]
            if gap != " ":
                break
            nxt_stem = _POSSESSIVE.sub("", nxt.group(0))
            if _is_capitalized_name_word(nxt_stem) and nxt_stem.lower() not in _COMMON_CAPITALIZED and nxt_stem.lower() not in _PERSON_TITLES \
                    and nxt_stem.lower() not in _TRANSLATE_NORMALLY:
                end += 1
                continue
            if nxt_stem.lower() in _NAME_CONNECTORS and end + 2 < len(tokens) and text[nxt.end(): tokens[end + 2].start()] == " ":
                after = tokens[end + 2].group(0)
                if _is_capitalized_name_word(after) and after.lower() not in _COMMON_CAPITALIZED:
                    end += 2
                    continue
                # "of the Rings": một từ nối nữa rồi mới tới từ viết hoa.
                if after.lower() == "the" and end + 3 < len(tokens) and text[tokens[end + 2].end(): tokens[end + 3].start()] == " " \
                        and _is_capitalized_name_word(tokens[end + 3].group(0)):
                    end += 3
                    continue
            break
        multi_word = end > index
        # Đầu câu, từ đơn viết hoa chưa chắc là tên (đầu câu nào cũng viết hoa): chỉ nhận cụm nhiều từ, camelCase hoặc viết tắt.
        if sentence_start and not (multi_word or camel or acronym):
            index += 1
            continue
        span_start = token.start()
        span_end = tokens[end].end()
        name = text[span_start:span_end]
        suffix = ""
        possessive = _POSSESSIVE.search(name)
        if possessive:
            suffix = name[possessive.start():]
            name = name[: possessive.start()]
            span_end = span_start + len(name)
        if name and (only is None or name in only):
            replacements.append((span_start, span_end, name))
        index = end + 1
    if not replacements:
        return text, []
    pieces: list[str] = []
    cursor = 0
    for start, end, name in replacements:
        token_id = f"X{start_index + len(placeholders) + 1}"
        placeholders.append((token_id, name))
        pieces.append(text[cursor:start])
        pieces.append(token_id)
        cursor = end
    pieces.append(text[cursor:])
    return "".join(pieces), placeholders
