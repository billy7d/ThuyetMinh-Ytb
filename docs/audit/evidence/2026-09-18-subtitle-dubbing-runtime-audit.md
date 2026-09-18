# Audit runtime phụ đề và thuyết minh — 2026-09-18

## Phạm vi

- Repository: `billy7d/ThuyetMinh-Ytb`
- Branch: `fix/firefox-extension-reliability-p0`
- Phạm vi kiểm tra: Audio Capture → PCM → WebSocket → Mock STT → rule translation → mock TTS → subtitle/TTS client path.
- Evidence chính: WebSocket gateway thật trên cổng tạm, không bypass gateway/pipeline bằng unit mock; browser acceptance được ghi riêng là BLOCKED.

## Kết luận ngắn

Backend mock pipeline không bị kẹt khi nhận PCM có tín hiệu. Trace runtime trực tiếp đã đi qua `SESSION_START`, `SESSION_READY`, `AUDIO_CHUNK`, VAD, `TRANSCRIPT_FINAL`, `TRANSLATION_READY`, `SUBTITLE_EVENT`, `TTS_CHUNK` và `SESSION_METRICS`.

Nguyên nhân làm lần kiểm tra thực tế không có phụ đề/giọng đọc chưa thể quy về một lỗi duy nhất ở browser vì extension không được nạp vào Chrome surface khả dụng và Firefox không được expose. Bằng chứng hiện có khoanh vùng lỗi trước backend hoặc ở renderer: việc điều khiển volume chứng minh nhánh AudioMixer/native playback hoạt động, không chứng minh STT tap đã có PCM. Hai lỗi P0 trong code có thể làm mất/đảo điều kiện downstream đã được sửa:

1. `MockSTTProvider` gọi `SimpleVAD.process()` hai lần cho cùng một chunk, làm sai stateful VAD và mốc speech end.
2. `PCMProcessor` lấy timestamp từ `AudioContext.currentTime`; nhiều chunk sinh trong cùng callback có thể trùng timestamp. Timestamp nay tính theo số sample đã phát ra, nên tăng đều theo chunk 250 ms.
3. Firefox ưu tiên `MediaElementSource`, không chứng minh được capture signal trên video cross-origin. Nhánh Firefox nay ưu tiên `captureStream`/`mozCaptureStream` có audio track, giữ native playback riêng; fallback vẫn được log RMS để fail-closed khi silent.

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
| Renderer nhận/hiển thị subtitle | Instrumentation + artifact regression đã thêm; test browser bị skip | BLOCKED — Chrome URL policy chặn `chrome://extensions`, Firefox không có target |
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

- `npm test`: PASS — 11 test files, 35 tests.
- `npm run test:unit`: PASS — 5 files, 18 tests.
- `npm run test:integration`: PASS — 6 files, 17 tests.
- `npm run typecheck -w @vietdub/extension`: PASS.
- `npm run build`: PASS — build và validator độc lập cho Chrome/Firefox.
- `npm run test:e2e`: 2 bundle-smoke PASS; 9 browser runtime cases SKIPPED/BLOCKED bởi harness/browser availability.
- `git diff --check`: PASS.

`CI_QUALITY` của commit mới chỉ được gọi là PASS sau khi push và workflow mới hoàn tất; run CI cũ trên commit trước không được dùng làm bằng chứng cho thay đổi này.
