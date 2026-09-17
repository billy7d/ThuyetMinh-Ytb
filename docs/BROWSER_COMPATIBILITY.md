# Browser Compatibility Matrix — VietDub AI

> **Đính chính 2026-09-17:** Ma trận này mô tả feasibility/media capability lịch sử, không phải xác nhận runtime extension hiện tại. Chrome capture còn cần action invocation thật; Firefox extension E2E chưa chạy được temporary-install runner. Xem [P0 Review Fix Report](audit/P0_REVIEW_FIX_REPORT.md).

| Nền tảng | Trình duyệt & Phiên bản | Cơ chế thu âm (Capture Method) | Độc lập âm lượng gốc | TTS tiếng Việt độc lập | Hỗ trợ thực tế | Ghi chú kỹ thuật |
| :--- | :--- | :--- | :---: | :---: | :---: | :--- |
| **Chrome HTML5 Video** | Chrome 152+ (Win11) | `tabCapture` + Offscreen Web Audio | Có trong media spike | Có trong media spike | **Chưa xác nhận runtime** | Cần action toolbar invocation trước `tabCapture`. |
| **Chrome YouTube** | Chrome 152+ (Win11) | `tabCapture` + Offscreen Web Audio | Có trong media spike | Có trong media spike | **Chưa xác nhận runtime** | Cần chạy bằng Chrome action thật và verify lifecycle. |
| **Firefox HTML5 Video** | Firefox 155+ (Win11) | `captureStream()` + Content Web Audio | Có trong media spike | Có trong media spike | **Chưa xác nhận runtime** | Firefox extension temporary-install E2E chưa chạy trong host. |
| **Firefox YouTube** | Firefox 155+ (Win11) | `captureStream()` / MediaElementSource | Có trong media spike | Có trong media spike | **Chưa xác nhận runtime** | Cần verify player MSE sau buffering trên Firefox extension thật. |
| **Video Cross-Origin (No CORS)** | Chrome 152+ | `tabCapture` | ✅ Có | ✅ Có | **Hỗ trợ** | Tab audio capture bỏ qua giới hạn CORS của element. |
| **Video Cross-Origin (No CORS)** | Firefox 155+ | MediaElement Capture | ❌ Hạn chế | ✅ Có | **Cần cấp quyền/CORS** | Browser bảo vệ origin, có thể cần prompt quyền. |
| **Video có bản quyền (DRM)** | Cả hai trình duyệt | Encrypted Media Extensions (EME) | ❌ Không | ❌ Không | **Không hỗ trợ** | Tuân thủ chính sách bảo vệ DRM của PRD. |
| **Livestream (HLS/DASH)** | Cả hai trình duyệt | Continuous Buffer Capture | ✅ Có | ✅ Có | **Hỗ trợ** | Thuyết minh liên tục với độ trễ có kiểm soát. |
