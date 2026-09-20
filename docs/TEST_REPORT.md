# Test Report — VietDub AI

Ngày cập nhật: 2026-09-20

## Trạng thái tổng thể

`IMPLEMENTED, NOT VERIFIED` — mã nguồn đã có ranh giới provider thật cho Deepgram STT, Gemini translation và Google Cloud TTS; chưa thể công bố P0 PASS vì môi trường hiện không có credential provider và không có Firefox cài sẵn để chạy browser acceptance thật.

## Đã kiểm tra cục bộ

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

## Evidence cần bổ sung để đóng P0

Chạy backend với các biến môi trường trong `docs/PROVIDER_SETUP.md`, sau đó chạy manual/browser acceptance checklist, lưu log không chứa secret, transcript/translation/TTS evidence và latency report. Chỉ khi đủ evidence cho cả Chrome và Firefox mới đổi trạng thái P0 sang PASS.

## Ghi chú an toàn

Không commit API key. Audio chỉ được gửi tới STT sau Start; backend không lưu transcript/audio theo thiết kế hiện tại. `npm audit` vẫn cần được xử lý riêng trước khi release vì dependency tree còn cảnh báo moderate.
