# Feasibility Report Status

Ngày cập nhật: 2026-09-20

Các bảng PASS trước đây dựa trên môi trường Windows và synthetic/spike checks; chúng không phải browser acceptance cho production providers và không được dùng làm P0 evidence.

## Mã nguồn đã có

- Chrome dùng offscreen capture path và relay có session ownership.
- Firefox dùng content-side capture path với native audio mute/restore guard.
- Audio gốc và TTS đi qua các gain/queue độc lập; audio gốc vẫn được gửi STT khi người dùng đặt volume về 0.
- Seek, video replacement, tab close, Stop và provider errors đều có cleanup/generation invalidation path.
- Deepgram, Gemini và Google Cloud TTS là provider thật; mock/fixture chỉ còn trong test package.

## Chưa xác minh

- Không có credential provider trong môi trường hiện tại.
- Không có Firefox executable trên máy hiện tại.
- Chưa chạy YouTube/HTML5 live acceptance trên Chrome và Firefox.
- Chưa có evidence audio restoration, Vietnamese voice audible và no-duplicate-audio từ browser thật.

Kết luận: khả thi về kiến trúc và đã có code path production, nhưng P0 vẫn `BLOCKED / NOT VERIFIED`.
