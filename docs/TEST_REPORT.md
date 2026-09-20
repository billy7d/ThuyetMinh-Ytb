# Báo cáo Lịch sử Kiểm thử (Test Report) — VietDub AI

> **Đính chính 2026-09-17:** Bảng dưới đây là snapshot trước review fix. Các claim `100% PASS` của Chrome/Firefox extension E2E không còn là release evidence; xem [P0 Review Fix Report](audit/P0_REVIEW_FIX_REPORT.md) để biết kết quả hiện tại.

> **Phạm vi benchmark:** các số liệu dịch/độ trễ bên dưới là offline benchmark trên pipeline mock, không chứng minh chất lượng AI production hoặc runtime extension.

Ngày cập nhật: 2026-09-20

## Trạng thái tổng thể

`IMPLEMENTED, NOT VERIFIED` — mã nguồn đã có ranh giới provider thật cho Deepgram STT, Gemini translation và Google Cloud TTS; chưa thể công bố P0 PASS vì môi trường hiện không có credential provider và không có Firefox cài sẵn để chạy browser acceptance thật.

| Phân loại Kiểm thử | Framework | Số lượng Test Cases | Passed | Failed | Trạng thái |
| :--- | :--- | :---: | :---: | :---: | :---: |
| **P0 Feasibility Spike** | Node.js + Playwright (media page) | 6 tiêu chí âm thanh | 6 | 0 | **PASS — MEDIA-ONLY** |
| **Unit Tests** | Vitest v3.2.7 | 17 tests | 17 | 0 | **PASS (100%)** |
| **Integration Tests** | Vitest v3.2.7 | Snapshot cũ | Snapshot cũ | — | **LỊCH SỬ** |
| **E2E Chrome Tests** | Playwright (Chrome Extension Unpacked) | Snapshot cũ | Snapshot cũ | — | **LỊCH SỬ / KHÔNG ĐỦ GATE** |
| **E2E Firefox Tests** | Playwright (Firefox Browser Context) | Snapshot cũ | Snapshot cũ | — | **LỊCH SỬ / KHÔNG ĐỦ GATE** |
| **Translation & Latency Benchmark** | 30 mẫu kiểm thử chuẩn hóa | 30 mẫu | 30 | 0 | **PASS (100%)** |
| **TỔNG CỘNG SNAPSHOT CŨ** | — | **64 tests & checks** | **Không dùng** | **—** | **LỊCH SỬ** |

- TypeScript typecheck: PASS.
- Production build cho shared, backend, Chrome extension, Firefox extension và test package: PASS.
- Unit/integration/provider contract tests: 6 test files, 21 tests PASS.
- Chrome smoke E2E dùng local HTML5 fixture: 5 tests PASS; đây chưa phải YouTube/provider-live acceptance.
- Firefox smoke E2E: BLOCKED vì Playwright Firefox executable không có trong môi trường.
- `npm audit --omit=dev`: 0 production vulnerabilities. Full audit còn 2 moderate trong Vitest dev dependency; bản sửa đề xuất là breaking change và chưa tự động áp dụng.

## Chưa được phép gọi là PASS

- Chưa gọi live Deepgram, Gemini hoặc Google Cloud TTS vì không có credential trong môi trường.
- Chưa đo latency p50/p95 live và chưa chạy soak 30 phút.
- Chưa có Chrome acceptance trên YouTube/HTML5 với provider thật.
- Chưa có Firefox acceptance; máy hiện không có Firefox executable.
- Chưa xác minh audio restoration bằng thao tác người dùng trên cả hai browser.

### 2.2. Unit & Integration Tests (Vitest)
- `unit/vad.test.ts`: Kiểm tra phát hiện khoảng lặng, biên độ giọng nói và kích hoạt sự kiện kết thúc câu dứt điểm. (3/3 pass)
- `unit/translation.test.ts`: Kiểm tra bộ nhớ trượt 5 câu gần nhất, tra cứu từ điển thuật ngữ chuyên ngành, kiểm tra câu chưa hoàn chỉnh (`SentenceCompletionGuard`) và 5 câu mẫu bắt buộc trong PRD. (7/7 pass)
- `unit/tts.test.ts`: Kiểm tra tạo buffer WAV chuẩn RIFF, định dạng PCM 16-bit Mono và cơ chế hủy generation (`cancelGeneration`) khi người dùng tua video. (3/3 pass)
- `unit/cost.test.ts`: Kiểm tra tính toán chi phí phiên, công thức dự toán 1 giờ video và `BudgetGuard` ngắt kết nối an toàn khi vượt hạn mức. (4/4 pass)
- `integration/pipeline.test.ts`: Kiểm tra luồng dữ liệu trọn vẹn từ audio chunk đầu vào -> STT -> Dịch thuật -> TTS -> Subtitle -> Latency metrics; kiểm tra chế độ `subtitle_only` không phát TTS. (2/2 pass)

### 2.3. Browser E2E Tests (Playwright) — dữ liệu lịch sử
- Các kết quả Chrome/Firefox trong snapshot này không chứng minh được action invocation thật, extension temporary-install hoặc lifecycle runtime production.
- Không dùng `5/5 pass` ở trên làm acceptance hiện tại; xem `docs/audit/P0_REVIEW_FIX_REPORT.md`.

## Ghi chú an toàn

Không commit API key. Audio chỉ được gửi tới STT sau Start; backend không lưu transcript/audio theo thiết kế hiện tại. `npm audit` vẫn cần được xử lý riêng trước khi release vì dependency tree còn cảnh báo moderate.
