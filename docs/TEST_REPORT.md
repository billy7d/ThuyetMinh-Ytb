# Test Report — VietDub Local AI

Ngày cập nhật: 2026-09-24

## Độ chính xác nhận dạng: beam, ngữ cảnh, thuật ngữ (2026-10-02)

Đo bằng lời có đáp án: bài thuyết trình kỹ thuật 15 câu (219 từ, nhiều thuật ngữ: Kubernetes, PyTorch, TensorRT, CUDA…) đọc bằng giọng
Windows có sẵn Hazel (en-GB) và David (en-US), bản sạch và bản trộn nhiễu hồng; chạy qua đúng `SttRuntime` của worker (cùng cách cắt
lượt nói, small.en GPU int8_float16), số lỗi từ sau khi chuẩn hóa số/đơn vị ("seven" = "7"):

| Cấu hình | Sai (sạch) | Sai (nhiễu) | Thuật ngữ đúng | Giải mã p50 |
| --- | --- | --- | --- | --- |
| A beam 1 (cũ) | 5.0% | 5.9% | 64/76 | 428 ms |
| B beam 3 | 3.9% | 6.4% | 68/76 | 471 ms |
| C beam 3 + `initial_prompt` câu trước | **9.4%** | **14.8%** | 65/76 | 475 ms |
| D beam 3 + `hotwords` | 7.5% | 6.8% | 76/76 | 494 ms |
| E C + D | 8.0% | 7.8% | 75/76 | 518 ms |
| **B + sửa thuật ngữ sau nhận dạng (mới)** | **~3.9%** | — | **71/76** | +0 ms |

Kết luận: ngữ cảnh câu trước **có hại** (Whisper lặp lại chính câu trước), nên không dùng. `hotwords` sửa được thuật ngữ nhưng chèn
từ thừa chỗ khác (15.8 lỗi so với 11.2 trên 219 từ), nên không dùng. Thay bằng `text_rules.correct_terms`: so khớp mờ kết quả nhận
dạng với từ điển thuật ngữ (`--glossary-file`), chỉ sửa khi lệch ≤2 ký tự, không gộp qua ranh giới câu, không nuốt từ lân cận
("to Kubernetes"), bỏ qua từ thường là phần đầu/mở rộng của thuật ngữ ("transform" so với "transformer"); thuật ngữ <6 ký tự chỉ sửa
chữ hoa/thường. Trên cùng dữ liệu: 12.0 → 9.8 lỗi/219 từ (giảm 18%), thuật ngữ đúng 64 → 71/76, mọi chỗ thay đều đúng. Beam 3:
chênh lệch với beam 1 nhỏ và nằm trong nhiễu đo (cải thiện bản sạch, hơi kém bản nhiễu), nhưng không tốn độ trễ.

Giới hạn: lời tổng hợp, không phải giọng người thật; từ điển thử là từ điển "đúng chủ đề" nên đây là cận trên cho video cùng chủ đề.
Kiểm tra pipeline thật trên YouTube (đoạn t=300 s, 36 s, xen kẽ 2 lần mỗi cấu hình): STT p50 ~1.0–1.1 s ở cả beam 1 và beam 3,
giọng đọc bắt đầu sau cuối câu gốc p50 4.6–4.7 s (beam 1) và 3.6–3.7 s (beam 3), mỗi lần chỉ 9–12 câu nên chỉ kết luận được là beam 3
không làm chậm. `unittest` worker 35 test, `npm test`: PASS.

## Popup kẹt ở "Đang kết nối / nạp model…" khi Firefox chặn AudioContext (2026-10-02)

Log người dùng có `Một AudioContext đã bị ngăn bắt đầu tự động … content.js` còn backend `/health` báo cả 3 worker `ready`
(khởi động ~24 s, trong giới hạn 45 s). Nguyên nhân: `runFirefoxStart` gọi `await audioCtx.resume()`; khi trang chưa có thao
tác người dùng (bấm nút trong popup không tính) Firefox giữ Promise này vĩnh viễn nên phiên kẹt ở CONNECTING, trông như lỗi nạp
model. Sửa: `audio/audio-context-guard.ts` chờ tối đa 3 s rồi báo `AUDIO_CONTEXT_BLOCKED` kèm hướng dẫn "bấm vào video (Play) một
lần rồi bấm Bắt đầu lại" (áp dụng cho cả Firefox và Chrome offscreen). Không tái hiện được việc Firefox chặn thật trong tự động
hóa (Playwright cấp quyền kích hoạt nên AudioContext vẫn `running`, kể cả với `--autoplay block`), nên kiểm chứng bằng unit test
giả lập `resume()` treo (5 test) và test hồi quy YouTube thật PASS (6 phụ đề, 7 giọng đọc, 0 cảnh báo, context `running`).
Harness có thêm `--no-gesture true` và `--autoplay block`. `npm test` 115 test: PASS.

## A/B model dịch: OPUS-MT, vinai-translate-en2vi-v2, madlad400-3b-mt (2026-10-02)

Theo đồng ý của người dùng đã tải `vinai/vinai-translate-en2vi-v2` (revision `82f8c91…`, AGPL-3.0, SHA-256 `pytorch_model.bin`
khớp upstream) và `google/madlad400-3b-mt` (revision `fa184c6…`, Apache-2.0, SHA-256 khớp), chuyển cả hai sang CTranslate2
int8_float16, đo trên 40 câu (câu thật từ video đã test + câu hội thoại/kỹ thuật/tin tức), GPU, beam 4:

| | OPUS-MT (+quy tắc) | vinai | madlad-3b |
| --- | --- | --- | --- |
| Tốc độ GPU p50 / p95 | 105 / 211 ms | 126 / 204 ms | 453 / 793 ms |
| Tốc độ CPU p50 | ~280 ms | 281 ms | 1584 ms |
| Dung lượng CT2 | 144 MB | 430 MB | 3.0 GB |
| Câu sai rõ rệt (Claude đọc 40 câu) | 6 | 1–3 | 5 |

OPUS-MT sai nặng: "Climate change is affecting farmers" -> "Sự biến đổi là những người nông dân…", "updating the software" ->
"lập trình phần mềm", "tea towels" -> "trà", "feels wrong to me" -> "một sai lầm". madlad có lỗi sai ngôi ("I'll never find…" ->
"anh sẽ không bao giờ…") và chậm gấp ~4. Chọn vinai. Đánh giá do Claude đọc, không phải người bản ngữ hay metric tự động; mẫu nhỏ.
Bằng chứng: `translation-ab-1790917629710.json`. Chuyển madlad phải đọc file safetensors 11.8 GB bằng `read()` vì mmap làm Python
crash (access violation) trên máy này.

Tích hợp vinai (đã áp dụng cho cấu hình cục bộ): worker hỗ trợ mBART (`en_XX`/`vi_VN`, `target_prefix`), quy tắc viết lại câu nguồn
tách theo model (đo lại từng quy tắc với vinai: giữ like-button/blown-away/game-changer/blow-your-mind, bỏ subscribe và
"what I mean" vì làm câu tệ hơn), thêm "cậu" -> "bạn" cho "you". `manifest.json` cục bộ trỏ translation tới vinai (hash đã
kiểm tra, license ghi AGPL-3.0 kèm điều kiện copyleft); manifest mẫu trong repo vẫn là OPUS-MT. Sao lưu:
`E:\VietDub-AI\backup\*-before-vinai.*`.

YouTube thật, 3 đoạn × 36 s như các lần trước, đủ pipeline Firefox + STT small.en GPU + dịch vinai GPU: PASS cả 3 đoạn, 0 cảnh báo,
0 `STT_OVERLOADED`; dịch p50 / p95 114 / 303 ms (OPUS trong pipeline: 59 / 122 ms), STT p50 1.1 s, giọng đọc bắt đầu sau cuối
câu gốc p50 4.5–5.3 s. Bản dịch cùng đoạn video tốt hơn rõ ("Dù sao thì, ba chàng trai đã đến", "Họ nhìn vào cơ thể của họ như
một hình thức vận chuyển cho đầu của họ"). Lỗi còn lại chủ yếu do STT nghe nhầm ("Bạn là một câu trả lời tồi") và một từ
vinai giữ nguyên tiếng Anh ("disembodied"). `npm test` 110 test, `unittest` worker 28 test: PASS.

## Tối ưu theo cấu hình máy: GPU GTX 1660 SUPER + CPU i5-9400F (2026-10-02)

Trước đó mọi model chạy CPU (STT `device="cpu"` cố định, PyTorch bản CPU, VieNeu cố định `CPUExecutionProvider`); GPU
GTX 1660 SUPER 6 GB không được dùng. CTranslate2 4.8.2 thấy GPU nhưng thiếu `cublas64_12.dll`. Theo đồng ý của người
dùng đã cài `nvidia-cublas-cu12==12.9.2.10` + `nvidia-cudnn-cu12==9.27.0.42` (PyPI, ~1.3 GB) vào venv trên E:.

Đo trên cùng 12 s giọng người (TED), tốt nhất 3 lần sau warm-up:

| Model / thiết bị | 1 lượt nói 3.5 s | Nghe đúng "I've been blown away" |
| --- | --- | --- |
| base.en CPU int8 (cũ) | 694 ms | không |
| base.en GPU int8_float16 | 174 ms | không |
| small.en CPU int8 | 2133 ms | có |
| small.en GPU float16 | 957 ms | có |
| **small.en GPU int8_float16 (mới)** | **422 ms** | có |

Dịch: OPUS-MT chuyển sang CTranslate2 (không tải gì thêm): GPU int8_float16 71 ms/câu so với PyTorch CPU 328 ms/câu,
21/24 câu giống hệt, 3 câu khác cách diễn đạt cùng nghĩa. TTS VieNeu CPU: RTF 0.59 (2 luồng) → 0.51 (4 luồng) → 0.50 (5).
Cấu hình áp dụng: STT small.en GPU (lùi về base.en CPU nếu GPU lỗi — đã kiểm tra bằng `CUDA_VISIBLE_DEVICES=-1`),
dịch CTranslate2 GPU, TTS 4 luồng CPU. Sao lưu: `E:\VietDub-AIackup\env-2026-10-02-before-gpu.bak`,
`manifest-2026-10-02-before-gpu.json`; `manifest.json` nay trỏ STT tới small.en (hash đã kiểm tra).

YouTube thật, cùng 3 đoạn × 36 s như A/B hôm trước, Firefox + đủ pipeline:

| Chỉ số | base.en CPU (01/10) | GPU (02/10) |
| --- | --- | --- |
| STT trễ p50 / p95 / max | 1.4 / 4.7 / 5.7 s | 0.96 / 3.1 / 3.3 s |
| Dịch p50 / p95 | ~0.25 s | 0.06 / 0.12 s |
| Câu có thuyết minh / phụ đề | 31 / 29 | 36 / 32 |
| Giọng đọc bắt đầu sau cuối câu gốc, p50 theo từng đoạn | 7.4 / 5.0 / 5.0 s | 4.6 / 4.1 / 3.6 s |
| STT_OVERLOADED | 0 | 0 |

Nút thắt còn lại là TTS (p50 1.3 s, p95 3.5 s/câu trên CPU). Cảnh báo `PIPELINE_ERROR` duy nhất ("không phải tiếng
Việt") do small.en chép cả tiếng đệm ngắn ("Oh.", "yeah") mà model dịch giữ nguyên: câu ≤3 từ như vậy nay được bỏ qua
lặng lẽ (test mới). `npm test` 110 test, `unittest` worker 26 test, build validator: PASS.

## A/B Whisper base.en và small.en (2026-10-01)

Theo đồng ý của người dùng đã tải `Systran/faster-whisper-small.en` (revision `d1d751a5f8271d482d14ca55d9e2deeebbae577f`,
MIT, 486 MB, SHA-256 `model.bin` khớp upstream) vào `E:\VietDub-AI\models\sttaster-whisper-small.en`, kèm manifest
riêng `manifest-stt-small.json`; manifest/.env đang dùng không đổi.

| Chỉ số | base.en | small.en |
| --- | --- | --- |
| RTF nhận dạng, CPU rảnh (TED, cùng cách cắt câu) | 0.20 (tối đa 1.2 s/lượt) | 0.53 (tối đa 2.2 s/lượt) |
| STT trễ thực tế cùng Firefox + TTS, p50 / p95 / max | 1.4 / 4.7 / 5.7 s | 6.0 / 11.8 / 12.6 s |
| Câu có thuyết minh / phụ đề (3 đoạn YouTube × 36 s) | 31 / 29 | 10 / 25 |
| Cảnh báo | 0 | `STT_OVERLOADED` (bỏ audio), `PIPELINE_ERROR` |

`small.en` nghe đúng hơn một số câu ("I've been blown away", "I bring you gold") nhưng cũng sai/bịa câu khác
("morning" thiếu "Good", "Thank you." trong tiếng vỗ tay, "con ngựa cái"). Trên CPU 6 nhân này STT không theo kịp thời
gian thực khi chạy cùng trình duyệt và TTS: phần lớn câu thuyết minh bị bỏ vì quá trễ. Kết luận: giữ `base.en`.
`small.en` chỉ đáng dùng khi có GPU hoặc CPU mạnh hơn. Kèm theo: sửa dấu gạch dưới OPUS-MT sinh ra ("thứ_ba" -> "thứ ba").

## Dịch sai và cảnh báo "TTS backlog too long" trên Firefox (2026-10-01)

Log người dùng dán gồm nhiều dòng của YouTube/Firefox (CSP, CORS tới doubleclick, `mozPressure`, cảnh báo
fingerprinting, `file:///`…): đã kiểm tra build extension không chứa `file:///`, `doubleclick`, `mozPressure`
nên không phải lỗi của extension. Dòng duy nhất do extension in ra là `[AudioMixer] TTS backlog too long`.

1. **Cảnh báo backlog:** do mình hạ ngưỡng hàng chờ phát từ 5 s xuống 3 s ở lần sửa trước nên câu bị bỏ nhiều
   hơn, và việc bỏ câu được in bằng `console.warn` như thể là lỗi. Sửa: ngưỡng 3.5 s, tăng tốc phát sớm hơn
   (từ 0.5 s hàng chờ, trần 1.3x), chỉ ghi chẩn đoán `tts_mixer.backlog_skipped` (phụ đề câu bị bỏ vẫn hiện).
   Kết quả: 0 cảnh báo của extension trong 2 lần chạy YouTube thật; hàng chờ tối đa vẫn 3.1–3.3 s ở đoạn nói dày
   nên câu thuyết minh vẫn có thể bị bỏ khi người nói rất nhanh (xem KNOWN_LIMITATIONS).
2. **Dịch sai — đo trực tiếp trên model:** (a) greedy decoding → beam 4 (+~120 ms/câu): sửa "đã bị lộ toàn bộ
   chuyện này", "điều gì … số đầu vào"…; (b) "subscribe" → "viết nghiêng"/"phụ thuộc", "like button" → "nút thích
   hợp", "Welcome back to the channel" → "kênh liên lạc", "Um" → "Nhóm:": sửa bằng `runtime/workers/text_rules.py`
   (viết lại cụm nguồn + sửa lỗi tiếng Việt, kèm 6 test); (c) đại từ cổ/khẩu ngữ ("Ta mang vàng đến cho ngươi",
   "hắn quen cổ", "anh" cho "you") chỉ đổi khi ngôi của câu nguồn xác nhận; (d) mảnh cụt ≤4 từ ("There will be a")
   dịch riêng ra "Sẽ có Rồi sẽ có" → không dịch riêng nữa, chờ câu nối tiếp hoặc bỏ.
3. **Không sửa được bằng quy tắc:** Whisper base.en nghe nhầm giọng Anh nói nhanh. Độ tin cậy của Whisper
   (0.5–0.7) không tách được câu đúng/sai nên không lọc theo nó (sẽ làm mất câu đúng). Cần model STT lớn hơn.

Trước/sau (cùng worker dịch thật, 16 câu thường gặp trên YouTube): ví dụ "If you like this video, don't forget to
subscribe." "…đừng quên viết nghiêng." → "…đừng quên đăng ký."; "Hit the like button…" "Nhấn vào nút giống như nút" →
"Nhấn nút Thích rồi ghi chú lại bên dưới."; "I brought you gold." "Ta mang vàng đến cho ngươi" → "Tôi mang vàng đến cho bạn."
Thời gian dịch trung bình 207 → ~260 ms/câu. Firefox thật: TED giọng người kèm tải lại trang PASS, phụ đề lệch giọng
đọc 0–8 ms, không cảnh báo (`firefox-acceptance-1790843645910.json`); YouTube thật đoạn nói dày (t=300 s, 36 s)
PASS, 10/10 câu có thuyết minh, 0 câu bị bỏ, 0 cảnh báo extension (`firefox-acceptance-1790843698466.json`).
`npm run typecheck`/`build` (validator Chrome + Firefox), `npm test` (23 file, 109 test), `unittest` worker (25 test): PASS.
Ở đoạn nói dày, giọng thuyết minh bắt đầu trễ 3.4–6.9 s sau cuối câu gốc (do STT 1–3 s khi CPU bị Firefox/TTS tranh chấp)
— trễ này chưa được cải thiện thêm trong lần sửa này.

## Phụ đề đi trước thuyết minh và trễ so với âm gốc (2026-10-01)

Đo bằng log chẩn đoán có `segmentId`, mốc video và thời điểm phát (`firefox_acceptance.mjs` thêm mục
`sync`, `soak_local_gateway.mjs` thêm `subtitleMinusTtsMs`/`ttsLagMs`/`translationReadyLagMs`).
Nguyên nhân:

1. **Phụ đề đi trước thuyết minh 0.5–1.1 s, lệch dần:** backend gửi phụ đề ngay khi dịch xong, còn giọng
   đọc phải chờ tổng hợp (~0.6–1.2 s) và xếp hàng phát; phụ đề lại có hàng đợi riêng theo thời gian đọc.
   Hai hàng đợi độc lập nên lệch nhau. Sửa: chế độ thuyết minh + phụ đề gửi phụ đề (`syncWithTts`) ngay
   trước `TTS_CHUNK` cùng câu; bên phát audio hiện phụ đề đúng lúc giọng đọc bắt đầu
   (`sync/tts-subtitle-sync.ts`, `AudioMixer.scheduleTTSBuffer`). Câu không có giọng đọc vẫn hiện phụ đề.
2. **Trễ so với âm gốc:** (a) Whisper chỉ trả mọi câu của một lượt nói khi lượt nói kết thúc; lượt nói
   tối đa 5–7 s → giảm còn 3.5–5 s, khoảng lặng chốt câu 400 → 300 ms. (b) Đoạn thiếu dấu câu bị giữ chờ
   câu sau tới 5 s → chỉ giữ mảnh câu cụt (≤5 từ hoặc kết thúc bằng mạo từ/giới từ), tối đa 150 ms.
   (c) OPUS-MT "bịa" bản dịch dài gấp 3 câu nguồn cho mảnh câu (27 → 79 ký tự, 6 s giọng đọc cho 2 s lời
   gốc) làm cả hàng thuyết minh trễ dồn → giới hạn bản dịch 2× độ dài nguồn, phát nhanh tối đa 1.2× khi
   giọng đọc dài hơn câu gốc, hàng chờ phát tối đa 3 s (trước 5 s).
3. Cảnh báo `PIPELINE_ERROR` ("translation contains no speech") với đoạn chỉ có nhạc không còn hiện ở popup.

| Chỉ số (soak gateway 60 s, cùng audio) | Trước sửa độ trễ | Sau sửa (2 lần chạy) |
| --- | --- | --- |
| Phụ đề − giọng đọc cùng câu | phụ đề đi trước 0.5–1.1 s (code cũ) | −6…0 ms |
| Số câu phụ đề / TTS | 23 / 22 | 26 / 26 |
| Bản dịch sẵn sàng sau cuối câu p50 / p95 | 1.09 / 3.07 s | 1.03–1.10 / 2.52–2.54 s |
| Giọng đọc (và phụ đề) sau cuối câu p50 / p95 / max | 2.35 / 4.48 / 9.0 s | 2.12–2.48 / 3.59–4.41 / 4.47–4.91 s |

"Trước sửa độ trễ" là lần chạy đầu đã có đồng bộ phụ đề nhưng chưa có (a)–(c)
(`local-gateway-soak-sync-new-1790840342271.json`); sau sửa: `local-gateway-soak-sync-fa-1790841018370.json`,
`local-gateway-soak-sync-fb-1790841135155.json`. Firefox thật: TED giọng người kèm tải lại trang PASS, phụ đề
lệch giọng đọc 0–7 ms, trễ sau cuối câu p50 0.73 s / p95 3.5 s (`firefox-acceptance-1790841225424.json`);
YouTube thật 38 s PASS, lệch −1…+1 ms, AudioContext `running` (`firefox-acceptance-1790841306687.json`).
Mốc thời gian câu của Whisper (không bật word timestamps) chỉ chính xác ~±0.5 s nên số trễ là ước lượng.
Luồng Chrome (offscreen giữ phụ đề rồi chuyển cho tab) có unit test nhưng chưa kiểm chứng bằng thao tác thật.

## Firefox trên YouTube thật: phụ đề ngắt quãng, không có giọng thuyết minh, dịch sai (2026-10-01)

Kiểm thử bằng `node runtime/firefox_acceptance.mjs --url <YouTube> --print-subtitles true`
(Firefox thật, chính sách autoplay mặc định, click Play như người dùng) và backend có log
chẩn đoán. Lỗi tìm được:

1. **Phiên dừng lặng lẽ:** content script dừng thu âm khi `location.href` đổi, và
   background dừng phiên khi `tabs.onUpdated` báo URL mới — YouTube liên tục tự sửa query
   (`&t=`, `&pp=`, sau quảng cáo). Popup vẫn hiện "Đang thuyết minh" nhưng không còn audio.
   Sửa: so theo danh tính video (`navigation/video-identity.ts`); đổi video thật hoặc tải
   lại trang thì báo lỗi rõ (`VIDEO_NAVIGATION`, `PAGE_RELOADED`).
2. **Thu âm chết sau khi YouTube đổi nguồn phát:** track của `mozCaptureStream()` kết thúc,
   backend chỉ nhận toàn số 0. Sửa: theo dõi track + watchdog 3 s im lặng tuyệt đối khi video
   đang phát → thu lại vào cùng đồ thị Web Audio (`firefox_capture.recaptured`).
3. **Dịch câu cụt:** mảnh "There will be a" được dịch riêng. Sửa: chỉ dịch khi có dấu kết
   thúc câu (buộc dịch sau 5 s).
4. **Ký hiệu nhạc/nhãn phi lời thoại và ảo giác trên nhạc:** "♪ Sẽ có ♪ ♪", chuỗi "Tôi mệt
   rồi…". Sửa: lọc ♪/[Music]/(Laughter), ngưỡng no_speech/logprob/compression, bỏ câu lặp.

Kết quả sau sửa: YouTube thật (38 s, trước khi YouTube chặn trình duyệt tự động): PASS,
phụ đề trễ 0.4–3.6 s so với lời nói, 5/5 câu TTS phát với AudioContext `running`
(`firefox-acceptance-1790810776096.json`). Giọng người thật (TED, 44 s) kèm tải lại trang,
chạy 2 lần: PASS, không ảo giác, 8 câu TTS mỗi lần
(`firefox-acceptance-1790810627371.json`, `...1790810712108.json`).
Giới hạn môi trường: YouTube báo "Something went wrong" với trình duyệt tự động sau ~40 s
(đã xác nhận bằng lần chạy đối chứng không bật extension) nên chưa có soak dài trên YouTube.
Chất lượng dịch còn giới hạn bởi model nhỏ (Whisper base.en nghe nhầm "I've been" →
"It's been"; OPUS-MT dịch sát chữ).

## Firefox: "Không thể kết nối máy chủ AI" (2026-10-01)

Tái hiện trên Firefox thật (Playwright Firefox 155, add-on tạm cài qua Remote
Debugging Protocol, trang có origin `https://www.youtube.com`) bằng
`node runtime/firefox_acceptance.mjs --seconds 40`. Hai nguyên nhân chồng nhau:

1. WebSocket mở từ content script mang `Origin: https://www.youtube.com`; backend
   chỉ nhận origin extension/loopback nên trả HTTP 403 mọi lần. Sửa: content script
   chuyển dữ liệu qua runtime Port, background (`moz-extension://`) mở WebSocket
   (`packages/extension/src/relay/ws-relay.ts`); relay chỉ cho phép URL loopback.
2. CSP mặc định của Firefox MV3 có `upgrade-insecure-requests`, biến `ws://` thành
   `wss://` trong background. Sửa: khai báo `content_security_policy.extension_pages`
   trong `manifest.firefox.json`.

Ngoài ra URL mặc định đổi `ws://localhost:8080` → `ws://127.0.0.1:8080` vì backend
chỉ bind IPv4 loopback.

Kết quả sau sửa: PASS — phiên ACTIVE, 22 lần phụ đề hiển thị trên trang, 24 câu TTS
được giải mã/phát, F5 giữa phiên rồi Bắt đầu lại vẫn chạy (8 phụ đề sau reload),
0 lỗi, âm lượng video được khôi phục. Bằng chứng:
`E:\VietDub-AI\evidence\firefox-acceptance-1790808156818.json`. Trước sửa:
`firefox-acceptance-1790807803250.json` (`WS_CONNECTION_FAILED`).

Chrome/Edge: test e2e chạy bằng Edge (`VIETDUB_CHROMIUM_EXECUTABLE`) nạp được
extension, PING và overlay phụ đề PASS; kịch bản START qua popup mở dạng tab bị
`PERMISSION_DENIED` do tab popup không có quyền activeTab như khi bấm biểu tượng —
chưa kiểm chứng luồng Chrome thật bằng thao tác người dùng.

## Sửa lỗi realtime (2026-10-01): phiên tự dừng, trễ ~10 s, phụ đề/thuyết minh thiếu

Nguyên nhân gốc đã xác nhận bằng test A/B cùng máy (i5-9400F 6 nhân, 16 GB), cùng
model thật, cùng audio: giọng tổng hợp VieNeu tiếng Anh + nhạc nền tổng hợp liên
tục, phát thời gian thực 60 s rồi giả lập tải lại trang
(`node runtime/soak_local_gateway.mjs --ws ws://127.0.0.1:<port> --seconds 60`).

| Chỉ số | Code cũ (`22f514d`) | Code mới |
| --- | --- | --- |
| Phụ đề / TTS trong 60 s | 6 / 5 | 16 / 16 |
| Phụ đề đầu tiên | ~10.7 s | ~6.0 s |
| Trễ phụ đề p50 / p95 | 3.5 s / 10.8 s | 1.3 s / 2.3 s |
| Lỗi backend | `PIPELINE_ERROR` (dịch lặp, TTS vượt khung) | 0 |
| Extension dừng phiên | có (giây 13–20) | không |
| Sau "tải lại trang" | vẫn lỗi, 0 TTS | 6/6 phụ đề, 6/6 TTS |

Bằng chứng: `E:\VietDub-AI\evidence\local-gateway-soak-baseline-1790793634303.json`
và `E:\VietDub-AI\evidence\local-gateway-soak-new-1790793474584.json`.
Smoke gateway model thật: `local-gateway-smoke-1790792639085.json` PASS.

- `npm run typecheck`, `npm run build` (validator Chrome + Firefox): PASS.
- `npm test`: PASS — 20 test files, 85 tests (thêm `realtime-hardening`,
  `extension-hardening`, `gateway-readiness`).
- `python -m unittest runtime/workers/test_vietdub_worker.py`: PASS — 16 tests.
- `npm run test:e2e:firefox`: 1 passed, 3 skipped (thiết kế sẵn: chưa có runner
  web-ext).
- `npm run test:e2e:chrome`: BLOCKED do môi trường — Chrome thương mại 154 không
  còn hỗ trợ `--load-extension`, máy chưa có Chromium của Playwright. Không liên
  quan tới thay đổi này; cần kiểm thử thủ công extension trên YouTube thật.
- Audio vẫn là giọng tổng hợp + nhạc tổng hợp, chưa phải giọng người/video thật.

## Kết quả trong working tree hiện tại

- `npm run typecheck`: PASS.
- `npm run build`: PASS; build artifact Chrome và Firefox, validator của cả hai
  PASS.
- `npm test`: PASS — 16 test files, 58 tests. Một số integration pipeline dùng
  fixture/mock; kết quả này xác minh contract/source, không thay inference thật.
- Worker thật dùng `faster-whisper 1.2.0`, `transformers 4.57.6`, `torch 2.8.0`,
  `onnxruntime 1.22.1`, `vieneu 3.8.3` và `sea-g2p 0.10.0`; ba model đã load
  local và đã chạy benchmark/inference.
- `python -m pip check`: WARN/NOT CLEAN — SDK VieNeu khai báo Gradio, librosa,
  soundfile, soxr và kaldi-native-fbank; lock preset-only không cài các gói
  không dùng cho luồng bundled-voice ONNX. Những đường UI/voice-cloning chưa
  được hỗ trợ/kiểm thử.
- Backend `/health`: HTTP 200; mode `local`, manifest và cả ba worker `ready`.
- `npm run benchmark`: command PASS với 30 fixture rows nhưng trạng thái
  `FIXTURE_ONLY_NOT_PRODUCTION_EVIDENCE`; STT latency là `null`.
- `npm audit --omit=dev`: BLOCKED trong lần thử hiện tại — bulk advisory request
  tới npm registry lỗi và npm không ghi được log vào cache do quyền thư mục.
  Đây không phải kết quả `0 vulnerabilities` và cũng không chứng minh có lỗ hổng.
- `git diff --check`: PASS. Manifest mẫu trong repo không chứa weights; manifest
  thực tế và file model nằm ngoài repo tại `E:\VietDub-AI`.

## Chưa chạy / không được gọi là PASS

- Model weights đã được tải theo consent; 25 artifact, 1,005,369,274 bytes.
  Local checksums/upstream identity đã xác minh; không có weights trong Git.
- Benchmark thật: translation 30/30, p50 169 ms/p95 204 ms; TTS 20/20 WAV,
  p50 1,375 ms/p95 1,620 ms; STT 3/3 synthetic speech, RTF p50 0.1319/p95
  0.1333. Nguồn STT do VieNeu local tổng hợp, không phải tiếng người.
- Hai gateway WebSocket run liên tiếp qua ba model thật đều tạo phụ đề tiếng
  Việt, WAV mono PCM16 48 kHz có tín hiệu và zero cost. Backend metric: STT
  1,087–1,107 ms, dịch 127 ms, TTS 1,015–1,168 ms, total 1,144–1,299 ms.
- Chrome stable 153.0.8010.54 đã mở profile acceptance riêng 30 phút tại
  `chrome://extensions`, nhưng extension chưa được nạp nên phiên đã timeout và
  Chrome hiện đã đóng. Evidence:
  `E:\VietDub-AI\evidence\chrome-acceptance-1790256455236.json`. Chrome popup,
  tabCapture, YouTube/HTML5, subtitle hiển thị, audio restoration và audibility
  chưa verify. Firefox chưa cài; không cài vì cần xác nhận riêng.
- Chưa thực hiện soak 30 phút hoặc browser acceptance với tiếng người/video thật.
- Chưa commit, push, tạo PR hoặc merge.

## Gate tiếp theo

Trong profile Chrome thử nghiệm trên E:, bật Developer mode và Load unpacked từ
`packages/extension/dist/chrome`; sau đó click biểu tượng VietDub thật và bấm
Bắt đầu để cấp `tabCapture`. Chạy kiểm thử extension trên trang video thật, xác
nhận subtitle/TTS/pause/seek/mode/stop/restore, rồi mới chạy soak 30 phút. Không
coi synthetic speech hay fixture/mock là bằng chứng human-audio/browser PASS.
Chưa commit, push, tạo PR hoặc merge cho tới khi các gate này có evidence.

## Cờ `LOCAL_TTS_WORKER_PROCESSES` – 2 tiến trình TTS song song (2026-10-02)

Thêm cờ tùy chọn (mặc định `1` = hành vi cũ). Khi đặt `2`: backend chạy 2 tiến trình TTS (`LocalWorkerPool`, chia request cho
tiến trình rảnh nhất, `cancel` gửi cho tất cả), pipeline tổng hợp tối đa 2 câu cùng lúc nhưng vẫn phát câu theo đúng thứ tự
(câu xong sớm chờ câu trước rồi mới gửi; phụ đề vẫn đi ngay trước giọng đọc cùng `segmentId`). Cần đặt thêm
`LOCAL_TTS_MAX_CONCURRENT_REQUESTS=2` và `--threads 3` cho worker TTS.

Đo A/B xen kẽ (p1,p2,p1,p2), soak gateway 60 s, giọng nói dày (`--tempo 1.35 --gap 0.3`), model thật, i5-9400F:

| Chỉ số | 1 tiến trình × 4 luồng (2 lần) | 2 tiến trình × 3 luồng (2 lần) |
| --- | --- | --- |
| Phụ đề / TTS | 20 / 20 | 20 / 20 |
| Trễ TTS p50 / p95 | 3.15 s, 3.09 s / 4.0 s, 3.6 s | 3.26 s, 3.28 s / 4.4 s, 4.7 s |
| Trễ phụ đề p50 / p95 | 3.14 s, 3.09 s / 4.0 s, 3.6 s | 3.25 s, 3.27 s / 4.4 s, 4.7 s |
| Giọng đọc bắt đầu sau khi hết câu, p50 / p95 | 4.72 s, 4.75 s / 5.8 s, 5.4 s | 4.14 s, 4.35 s / 5.2 s, 5.3 s |
| Backlog mixer tối đa | 2.8 s, 2.8 s | 3.7 s, 3.9 s |
| Câu bị bỏ ở mixer | 0, 0 | 1, 1 |
| Lỗi | 0 | 0 |

Kết luận: không có lợi ích rõ ràng nên **giữ mặc định 1**. Thông lượng tổng hợp tăng (bench riêng +22%) nhưng trong
pipeline thật nút thắt nằm ở hàng đợi phát của mixer chứ không phải tốc độ sinh: giọng đọc bắt đầu sớm hơn ~0.4–0.6 s,
đổi lại phụ đề/TTS trễ hơn ~0.1–0.3 s (p95 +0.4–1.1 s), backlog mixer cao hơn và có 1 câu bị bỏ, RAM gấp đôi.
Bằng chứng: `E:\VietDub-AI\evidence\local-gateway-soak-ttsprocs-*.json`. Chưa đo với Firefox thật.

## Cải thiện chất lượng dịch: beam, giữ thuật ngữ, từ điển cách đọc (2026-10-02)

Đo trên vinai-translate-en2vi-v2 (CTranslate2, GPU int8_float16), 40 câu chung (tập A/B cũ) + 24 câu kỹ thuật mới
(`E:\VietDub-AI\runtime\tech_sentences.json`). Chất lượng do Claude đọc từng câu, không phải người bản ngữ hay metric tự động.

**1. Tham số giải mã** (beam 4/6/8, length_penalty 1.3, repetition_penalty 1.1): chỉ đổi 4–12/64 câu, khác biệt là cách chọn
từ tương đương, không bên nào đúng hơn rõ ràng; beam 6 chậm hơn (p50 206 ms so với 170 ms của beam 4). **Giữ beam 4.**

**2. Giữ thuật ngữ khi dịch** (mục `translations` trong file từ điển, cần `--glossary-file` ở worker dịch): thay thuật ngữ bằng
ký hiệu giữ chỗ `X1`, dịch xong đặt lại dạng mong muốn; mất ký hiệu thì dịch lại không bảo vệ. So sánh ký hiệu: `X1` giữ đủ ngữ cảnh
(`machine learning pipeline` -> `máy học pipeline`), còn `QZT1`/tên riêng làm model bỏ mất `machine learning`.

| | Không bảo vệ | Bảo vệ thuật ngữ |
| --- | --- | --- |
| Câu thay đổi | – | 9/64 (đều là câu kỹ thuật), 0/40 câu chung |
| Ví dụ | "biến đổi xử lý", "mã thông báo", "các nhúng", "Ổn định khuếch tán", "đẩy một cam kết", "Quá mức xảy ra" | "Transformer xử lý", "token", "embedding", "Stable Diffusion", "đẩy commit", "Overfitting xảy ra" |
| Độ trễ dịch p50 / p95 | 157 / 223 ms | 148 / 206 ms (trong sai số đo) |

**3. Cách đọc riêng** (mục `pronunciations`, tùy chọn, mặc định rỗng, chỉ áp cho văn bản đưa vào TTS, phụ đề giữ nguyên):
VieNeu vốn phiên âm từ tiếng Anh bằng âm tiếng Anh (`Kubernetes` -> `kuːbɚnˈɛɾiːz`), nên không đặt sẵn mục nào. Chưa nghe thử bằng tai.

Chưa thêm luật sửa lỗi mới vào `text_rules.py` vì chưa có câu sai thực tế từ người dùng; các lỗi còn lại trong tập mẫu
(ví dụ "Prometheus cạo các số liệu", "dấu chân bộ nhớ") là cách dùng từ của model, có thể thêm vào `translations` khi cần.
Bằng chứng: `E:\VietDub-AI\evidence\translation-decode-exp.json`, `translation-protect-e2e.json`.

## Giọng đọc tăng tốc không còn the thé: co giãn thời gian giữ cao độ (2026-10-02)

Nguyên nhân: mixer rút ngắn câu bằng `AudioBufferSourceNode.playbackRate`, đổi cả cao độ (1.3x = cao hơn ~4.5 nửa cung, nghe như
hoạt hình). Nay câu cần tăng tốc (>1.02x) được co giãn bằng WSOLA (`extension/src/audio/time-stretch.ts`) rồi phát ở
`playbackRate = 1`; thời lượng và lịch phát giữ như trước (tốc độ đọc không giảm). Môi trường thiếu `getChannelData`/`createBuffer`
hoặc lỗi thì tự lùi về `playbackRate`.

Đo trên 3 câu VieNeu thật (cao độ trung vị F0 bằng tự tương quan): gốc 166–168 Hz; WSOLA 1.3x: 168–170 Hz (giữ nguyên);
`playbackRate` 1.3x: 211–218 Hz (+27%). Xử lý ~60–90 ms cho câu 5 s (thỉnh thoảng 220–350 ms ở lần chạy đầu/GC), chạy ở luồng
của trang trước khi phát. Mẫu nghe so sánh: `E:\VietDub-AI\evidence\tts-stretch\` (`*_goc`, `*_wsola`, `*_playbackRate_cu`).
Chưa nghe nhận xét của người dùng và chưa chạy trên trình duyệt thật.

## Thuyết minh ngắt nghỉ sai làm đổi nghĩa: dịch mảnh câu dở (2026-10-03)

Tái hiện bằng bài giảng dài (SAPI, câu phức) phát qua gateway thật (`E:\VietDub-AI\runtime\dump_segments.mjs`). Nguyên nhân: STT cắt
đoạn khi quá dài (3.5–5 s) hoặc khi người nói ngừng 300 ms; mảnh dở bị dịch và đọc riêng sau 150 ms, kể cả khi Whisper tự thêm dấu
chấm giả vào cuối đoạn bị cắt. Ví dụ trước sửa: "…is that every" -> "Điều thứ hai tôi muốn các bạn chú ý là" rồi "time we simplified…" ->
"thời gian chúng tôi đơn giản hóa" (mất nghĩa "mỗi khi"); "…what to do with" -> "…phải làm gì với nó." rồi câu sau đứng riêng;
"So instead of trying to fix everything at once" bị dịch thành mệnh đề phụ cụt.

Sửa: (1) worker STT gắn `endedMidSpeech` cho đoạn bị cắt vì quá dài; (2) `TranslationEngine` coi đoạn đó là chưa trọn câu dù có dấu
chấm, và không còn dịch riêng đoạn thiếu dấu câu cuối (`flushUnpunctuated=false`); (3) từ hạn định `every/each/what/how…` cuối đoạn là câu dở;
(4) `joinFragments` bỏ dấu chấm giả, thêm dấu phẩy giữa mệnh đề phụ và chính, viết thường chữ đầu đoạn sau khi an toàn; (5) giới hạn giữ
tăng từ 3 s lên 8 s và hết `pendingFlushMs` (150 ms -> 4 s) thì vẫn buộc dịch để không treo. Công tắc: `LOCAL_TRANSLATION_HOLD_FRAGMENTS=false` quay lại hành vi cũ.

Sau sửa (cùng bài giảng): "…every time we simplified" -> "mỗi khi chúng ta đơn giản hóa kiến trúc"; "…what to do with the mistakes…" ->
"quyết định phải làm gì với những sai lầm…"; "If you have a system… every day, even a tiny delay…" -> "…mỗi ngày, thậm chí một sự chậm trễ nhỏ…";
"So instead of… at once, we decided…" -> "Vì vậy, thay vì…, chúng tôi quyết định…". Số đoạn dịch giảm vì ghép (soak 60 s: 20 -> 10).

Cái giá là độ trễ (soak giọng VieNeu nói dày `--tempo 1.35 --gap 0.3`, 2 lần): trễ phụ đề p50 4.5–4.9 s (trước 3.1 s), p95 5.1–6.0 s
(trước 3.6–4.0 s); giọng đọc bắt đầu sau khi hết câu p50 5.2–5.3 s (trước 4.7 s); backlog mixer tối đa 0.9–1.8 s (trước 2.8 s), không câu nào bị bỏ.
Còn lại: đoạn bị cắt vì người nói ngừng giữa câu mà Whisper đã thêm dấu chấm thì vẫn dịch riêng (không phân biệt được với hết câu);
câu dài hơn ~8 s vẫn bị cắt. Chưa kiểm chứng trên trình duyệt thật.

## Phiên tự dừng "Trình duyệt gửi audio dồn dập" (2026-10-03)

Log backend của người dùng: `pipeline.error BUDGET_OR_RATE_LIMIT fatal` ở 3 phiên liên tiếp, thường ngay sau các `tts_chunk_emitted` dài 8–14 s, kèm
`STT_OVERLOADED` và có lúc `videoTimeMs` đứng yên trong khi hàng chục đoạn audio tới cùng lúc. Nguyên nhân (nhiều lớp):
1. Giới hạn 10 đoạn/giây tính theo thời điểm backend xử lý, nên chỉ cần trang hoặc backend đứng hình >2.5 s là audio gửi đúng nhịp cũng bị tính là
   "dồn dập" và phiên bị dừng. Nay chế độ local mặc định 200 đoạn/giây và không giới hạn thời lượng (`MAX_SESSION_MINUTES=0`); thông báo lỗi nêu rõ lý do.
2. Co giãn giọng (WSOLA) bản đầu **không chạy được trong Firefox thật** (content script): diag `tts_mixer.scheduled` cho `pitchPreserved:false`, lùi về
   `playbackRate`. Viết lại: sao chép kênh bằng `copyFromChannel`, tìm điểm ghép trên bản giảm mẫu, trần thời gian 250 ms rồi tự lùi. Đo trong Firefox thật:
   `stretchMs` 17–38 ms cho câu 5–9 s, `pitchPreserved:true`.
3. Câu ghép dài làm giọng đọc 12–14 s chiếm CPU (TTS 4 luồng) khiến nhận dạng bị quá tải: giới hạn giữ mảnh 8 s -> 6.5 s, 300 -> 240 ký tự.
4. Thêm chẩn đoán `backend.event_loop_stall` khi vòng lặp backend đứng >1 s.
Acceptance Firefox thật (bài giảng 70 s qua gateway): PASS, 16 giọng đọc, không `STT_OVERLOADED`, không `BUDGET_OR_RATE_LIMIT`.
Lưu ý: ca lỗi gốc của người dùng (trang YouTube thật có quảng cáo) chưa tái hiện được 1:1.

## Giảm độ trễ thuyết minh mà giữ nguyên ngắt nghỉ: đọc từng vế (2026-10-03)

Phân rã độ trễ (lần chạy Firefox thật, bài giảng 70 s): trung vị ~4.9 s từ lúc câu nói xong tới lúc backend gửi giọng đọc = nhận dạng ~0.85 s
+ dịch ~0.2 s + chờ ghép mảnh dở 1–2.5 s + tổng hợp giọng ~2.9 s (câu dài tới 8 s: RTF 0.55–0.85 trên CPU).

Thay đổi: (1) câu thuyết minh ≥90 ký tự được cắt ở dấu phẩy/chấm phẩy/hai chấm có sẵn (không cắt nếu không có dấu, không cắt số thập phân) thành 2–3 vế;
vế đầu tổng hợp xong là gửi và phát ngay, vế sau tổng hợp trong lúc vế đầu đang phát. Phụ đề vẫn hiện một lần với tổng thời lượng ước tính; tốc độ phát của
từng vế tính theo tỉ lệ khung thời gian (`slotShare`). Không tốn thêm RAM/CPU (tuần tự trên cùng worker). Tắt bằng `LOCAL_TTS_STREAM_PARTS=false`.
(2) Đoạn STT bị cắt vì quá dài nhưng đã tự đủ ý (có dấu kết câu, ≥5 từ, không bắt đầu bằng mệnh đề phụ/chữ thường, không dừng ở từ nối) dịch ngay,
không chờ phần sau; bản dịch ghép trên bài giảng thử không đổi.

A/B xen kẽ (on,off,on,off; cùng âm thanh, backend mới khởi động mỗi lượt, 22–24 câu mỗi chế độ):

| | Đọc từng vế | Đọc nguyên câu |
| --- | --- | --- |
| Từ lúc dịch xong tới tiếng đầu tiên (trung vị) | 3.1 s | 3.6 s |
| Riêng câu ≥100 ký tự | 2.4 s (n=6) | 5.5 s (n=4) |
| Giọng bắt đầu sau khi câu gốc kết thúc (trung vị) | 3.8 s | 4.8 s |

Chưa nghe thử bằng tai: mỗi vế là một lần tổng hợp riêng nên chỗ nối (dấu phẩy) có thể nghe hơi khác so với đọc liền một hơi. Mẫu nhỏ, máy bận nên số đo
dao động; xu hướng nhất quán. Bằng chứng: `E:\VietDub-AI\evidence\ab_parts.out`.

## Giữ nguyên tên riêng tiếng Anh khi dịch (2026-10-03)

Vinai giữ được phần lớn tên (Apple, Tesla, Elon Musk, Berlin…) nhưng vẫn dịch sát chữ các tên có từ thường: "Silicon Valley" -> "Thung lũng Silicon",
"Harvard University" -> "Đại học Harvard", "Eiffel Tower" -> "Tháp Eiffel", "Mount Everest" -> "Núi Everest", "Supreme Court" -> "Tòa án Tối cao".

Cách làm (worker dịch, `--translate-names` để tắt): nhận diện tên bằng chữ viết hoa — từ viết hoa giữa câu, cụm nhiều từ viết hoa liền nhau (nối được bằng of/the,
mở đầu được bằng New/Great/…), tên camelCase (YouTube, iPhone) và viết tắt chữ hoa; bỏ qua đại từ/từ nối viết hoa, tháng, thứ, ngôn ngữ, quốc tịch, tên nước,
chức danh (dịch "Tiến sĩ", giữ tên). Dịch bình thường trước; chỉ khi tên nào không còn nguyên văn trong bản dịch mới dịch lại câu đó với riêng các tên ấy
được giữ chỗ (`X<n>`) rồi đặt lại đúng nguyên văn. Lý do: bảo vệ mọi tên làm câu quanh đó kém tự nhiên ("ở Paris" -> "trong Paris", "thành lập Apple" -> "tạo ra Apple").

Đo (24 câu tên riêng mới + 64 câu cũ): 9/24 câu tên riêng đổi, đúng là các câu có tên bị dịch (nay giữ "Silicon Valley", "Harvard University", "United Nations",
"Eiffel Tower", "Mount Everest/Mount Fuji", "Supreme Court", "Great Wall of China", "Red Cross", "World Health Organization", "White House"), 15 câu còn lại không đổi;
64 câu cũ chỉ đổi 1 ("API REST" -> "REST API"); độ trễ dịch p50 152 ms -> 146 ms (chỉ câu có tên bị dịch mất mới thêm một lượt dịch ~+130 ms).
Tên đã có cách gọi quen thuộc trong tiếng Việt muốn dịch (Liên Hợp Quốc, Nhà Trắng, Vạn Lý Trường Thành…) thêm vào mục `translations` của từ điển
(áp dụng trước bước này), ví dụ `"United Nations": "Liên Hợp Quốc"`. Hạn chế: không có từ điển tên nên từ viết hoa ở đầu câu không nhận diện được trừ khi là cụm
nhiều từ/camelCase/viết tắt; tên viết thường hoặc Whisper không viết hoa sẽ không được giữ.
