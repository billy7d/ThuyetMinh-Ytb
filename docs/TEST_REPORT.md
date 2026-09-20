# Test Report — VietDub AI

Ngày cập nhật: 2026-09-21

## Trạng thái tổng thể

`BLOCKED — LOCAL BOUNDARY IMPLEMENTED, NOT VERIFIED` — runtime mặc định đã chuyển sang worker local fail-closed, manifest/checksum/license gate, downloader có consent và zero-cost enforcement. Chưa thể công bố P0 PASS vì môi trường này không có model/worker local, Firefox runtime hoặc phần cứng/evidence live.

## Đã kiểm tra cục bộ

- TypeScript typecheck: PASS.
- Production build cho shared, backend, Chrome extension, Firefox extension và test package: PASS.
- Unit/integration/provider/local-runtime/P0 reliability contract tests: 16 test files, 53 tests PASS.
- Chrome/Firefox extension artifact validators: PASS.
- Current Chrome artifact E2E: BLOCKED before tests because the macOS harness cannot expose the unpacked MV3 service worker; an earlier 5/5 local HTML5 fixture run on the pre-merge base is not final acceptance evidence.
- Firefox smoke E2E: BLOCKED vì Playwright Firefox executable không có trong môi trường.
- `npm audit --omit=dev`: 0 production vulnerabilities. Full audit còn 2 moderate trong Vitest/@vitest/mocker; bản sửa là breaking Vitest 5 và chưa tự động áp dụng.
- Tracked-source secret scan và `git diff --check`: PASS.

## Chưa được phép gọi là PASS

- Chưa chạy STT/translation/TTS worker local thật vì môi trường không có model weights, worker binary/Python runtime hoặc hardware profile.
- Chưa đo latency p50/p95 live và chưa chạy soak 30 phút.
- Chưa có Chrome acceptance trên YouTube/HTML5 với local model thật.
- Chưa có Firefox acceptance; máy hiện không có Firefox executable.
- Chưa xác minh audio restoration bằng thao tác người dùng trên cả hai browser.
- Backend health smoke PASS: loopback server trả HTTP 503 an toàn khi manifest/worker thiếu.

## Evidence cần bổ sung để đóng P0

Hoàn thiện `models/manifest.json` và ba local workers theo `docs/LOCAL_RUNTIME.md`, sau đó chạy manual/browser acceptance checklist, lưu log không chứa dữ liệu nhạy cảm, transcript/translation/TTS evidence và latency report. Chỉ khi đủ evidence cho cả Chrome và Firefox mới đổi trạng thái P0 sang PASS.

## Ghi chú an toàn

Không commit API key hoặc model weights. Audio chỉ được gửi tới worker sau Start; backend không lưu transcript/audio theo thiết kế hiện tại. `npm audit` vẫn cần được xử lý riêng trước khi release vì dependency tree còn cảnh báo moderate.
