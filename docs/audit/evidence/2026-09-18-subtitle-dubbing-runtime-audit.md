# Audit runtime phụ đề và thuyết minh — 2026-09-18

## Phạm vi

- Repository: `billy7d/ThuyetMinh-Ytb`
- Branch: `fix/firefox-extension-reliability-p0`
- Phạm vi kiểm tra: Audio Capture → PCM → WebSocket → Mock STT → rule translation → mock TTS → subtitle/TTS client path.
- Evidence chính: WebSocket gateway thật trên cổng tạm, không bypass gateway/pipeline bằng unit mock; browser acceptance được ghi riêng là BLOCKED.

## Kết luận ngắn

Backend mock pipeline không bị kẹt khi nhận PCM có tín hiệu và có ranh giới speech hợp lệ. Trace runtime trực tiếp đã đi qua `SESSION_START`, `SESSION_READY`, `AUDIO_CHUNK`, VAD, `TRANSCRIPT_FINAL`, `TRANSLATION_READY`, `SUBTITLE_EVENT`, `TTS_CHUNK` và `SESSION_METRICS`.

Nguyên nhân làm lần kiểm tra thực tế không có phụ đề/giọng đọc chưa thể quy về một lỗi duy nhất ở browser vì extension không được nạp vào Chrome surface khả dụng và Firefox không được expose. Bằng chứng hiện có khoanh vùng lỗi trước backend hoặc ở renderer: việc điều khiển volume chứng minh nhánh AudioMixer/native playback hoạt động, không chứng minh STT tap đã có PCM. Hai lỗi P0 trong code có thể làm mất/đảo điều kiện downstream đã được sửa:

1. `MockSTTProvider` gọi `SimpleVAD.process()` hai lần cho cùng một chunk, làm sai stateful VAD và mốc speech end.
2. `PCMProcessor` lấy timestamp từ `AudioContext.currentTime`; nhiều chunk sinh trong cùng callback có thể trùng timestamp. Timestamp nay tính theo số sample đã phát ra, nên tăng đều theo chunk 250 ms.
3. Firefox ưu tiên `MediaElementSource`, không chứng minh được capture signal trên video cross-origin. Nhánh Firefox nay ưu tiên `captureStream`/`mozCaptureStream` có audio track, giữ native playback riêng; fallback vẫn được log RMS để fail-closed khi silent.

Trong lần tái hiện bổ sung, một luồng voice liên tục có PCM thật (3200 bytes/chunk, RMS `0.3239`, timestamp cách nhau 250 ms) chỉ tạo `TRANSCRIPT_INTERIM` rồi không có final vì mock VAD chỉ chốt câu khi gặp silence. Khi đó `RealtimePipeline` không có điều kiện phát `TRANSLATION_READY`, `SUBTITLE_EVENT` hoặc `TTS_CHUNK`. Mock STT nay chốt đoạn tối đa sau 1500 ms, reset VAD rồi tiếp tục nhận đoạn mới. Subtitle renderer cũng giữ event ngắn tối thiểu 1500 ms; trace cũ có segment 300 ms nên dễ biến mất trước khi người dùng quan sát được. Đây là sửa P0 cho mock pipeline, không phải bằng chứng rằng browser capture hoặc AI production đã hoạt động.

Các thay đổi này không biến mock thành AI production. Browser capture, renderer thật và audio decoder/playback thật vẫn cần acceptance trên Chrome/Firefox desktop.

## Ma trận diagnostic bắt buộc

| Diagnostic | Kết quả direct runtime/instrumentation | Browser thật |
| :--- | :---: | :---: |
| Backend nhận `SESSION_START` | PASS — gateway log + integration WebSocket | NOT_RUN — extension chưa được nạp |
| Nhận `AUDIO_CHUNK` | PASS — 7 chunk voice/silence qua WebSocket thật | NOT_RUN |
| PCM có dữ liệu và RMS | PASS — voice RMS `0.3239`, silence RMS `0`; chỉ log stats | NOT_RUN |
| VAD `speechStarted`/`speechEnded` | PASS — start ở chunk voice đầu, end ở silence boundary | NOT_RUN |
| Phát `TRANSCRIPT_FINAL` | PASS — `textLength` chỉ được log | NOT_RUN |
| Phát `TRANSLATION_READY` | PASS — rule-based mock, chỉ log độ dài | NOT_RUN |
| Phát `SUBTITLE_EVENT` | PASS — mode `dubbing_and_subtitle` | NOT_RUN |
| Renderer nhận/hiển thị subtitle | PASS trong pipeline/instrumentation và helper regression; test browser bị skip | BLOCKED — Chrome URL policy chặn `chrome://extensions`, Firefox không có target |
| Phát `TTS_CHUNK` | PASS — mock WAV có payload, `audioBytesApprox=70044` | NOT_RUN |
| Decoder/playback hoặc lỗi | Có log `decoded_and_played`/`decoder_or_playback_error` ở cả client path | NOT_RUN |

Session ID không ghi nguyên văn trong diagnostic log; chỉ dùng hash tương quan `sessionRef`. Không log câu transcript/translation, URL/title, token, API key, raw PCM hoặc base64 audio.

## Trace runtime đã lưu

Trace đã được rút gọn và lưu tại [2026-09-18-runtime-trace.log](2026-09-18-runtime-trace.log). Các giá trị RMS, byte length, sample count và text length là metadata; không phải nội dung audio/text.

Các event quan sát được theo thứ tự:

```text
SESSION_START → SESSION_READY → AUDIO_CHUNK → VAD speechStarted
→ VAD speechEnded → TRANSCRIPT_FINAL → TRANSLATION_READY
→ SUBTITLE_EVENT → TTS_CHUNK → SESSION_STOP → SESSION_METRICS
```

## Mock/production boundary

| Hạng mục | Trạng thái | Bằng chứng |
| :--- | :---: | :--- |
| P0 mock subtitle pipeline | PASS | Gateway runtime trace + `npm test` + integration regression |
| Real STT | NOT_IMPLEMENTED | Gateway vẫn khởi tạo `MockSTTProvider`; provider production chưa được gọi |
| Real Translation | NOT_IMPLEMENTED | `TranslationEngine.callLLM()` vẫn là stub; rule/idiom fallback không phải LLM |
| Real Vietnamese TTS | NOT_IMPLEMENTED | `VietnameseTTSEngine.implementation = mock_synthetic_wav`; WAV là sóng tổng hợp, không phải giọng người |

Không gọi provider AI, không gửi API key, không phát sinh chi phí. Kế hoạch provider/chi phí/bảo mật và tiêu chí nghiệm thu production vẫn là scope riêng trong `AI_PIPELINE_GAP_ANALYSIS.md`.

## Browser evidence

Computer Use đã mở được fixture page thật tại `http://127.0.0.1:18081/` và ảnh chụp đã được hiển thị inline trong phiên kiểm tra. Trang hiển thị video test, `STT Input Signal Level 0.0000`, `TTS Playback Level 0.0000`, chỉ có log fixture; không có `#vietdub-subtitle-container`. Đây là bằng chứng fixture không có extension graph, không phải acceptance PASS/FAIL của sản phẩm.

API browser hiện chỉ cung cấp screenshot dưới dạng ảnh inline, không có đường dẫn file local để lưu bytes screenshot. Vì vậy không tạo ảnh giả; trạng thái file screenshot persistent là `NOT_AVAILABLE_FROM_BROWSER_TOOL`. Acceptance extension thật vẫn theo [evidence trước đó](2026-09-18-p0-real-browser-acceptance.md): `BLOCKED`.

## Regression và quality gates

- `npm test`: PASS — 12 test files, 40 tests.
- `npm run test:unit`: PASS — 6 files, 22 tests.
- `npm run test:integration`: PASS — 6 files, 18 tests.
- `npm run typecheck -w @vietdub/extension`: PASS.
- `npm run build:chrome`: PASS — build và validator Chrome độc lập.
- `npm run build:firefox`: PASS — build và validator Firefox độc lập.
- `npm run build`: PASS — full build và validator hai target.
- `npm run test:e2e -w @vietdub/tests -- --project=bundle-smoke`: 2/2 PASS; các browser runtime cases vẫn BLOCKED bởi harness/browser availability.
- `git diff --check`: PASS.

CI trên commit sửa mới đã PASS: push run [35326943761](https://github.com/billy7d/ThuyetMinh-Ytb/actions/runs/35326943761) và PR run [35326947726](https://github.com/billy7d/ThuyetMinh-Ytb/actions/runs/35326947726), 9/9 jobs completed/success trên `20fc8f6c1a4d6253061d625e435dda6e2f4ac4e3`. Browser acceptance vẫn BLOCKED độc lập với CI.
