# Browser Compatibility Matrix — VietDub AI

| Nền tảng | Trình duyệt & Phiên bản | Cơ chế thu âm (Capture Method) | Độc lập âm lượng gốc | TTS tiếng Việt độc lập | Hỗ trợ thực tế | Ghi chú kỹ thuật |
| :--- | :--- | :--- | :---: | :---: | :---: | :--- |
| **Chrome HTML5 Video** | Chrome 152+ (Win11) | `tabCapture` + Offscreen Web Audio | ✅ Có | ✅ Có | **Toàn diện (Full)** | Hoạt động ổn định, không bị giới hạn CORS media. |
| **Chrome YouTube** | Chrome 152+ (Win11) | `tabCapture` + Offscreen Web Audio | ✅ Có | ✅ Có | **Toàn diện (Full)** | Thu âm trực tiếp từ tab audio stream. |
| **Firefox HTML5 Video** | Firefox 155+ (Win11) | `captureStream()` + Content Web Audio | ✅ Có | ✅ Có | **Toàn diện (Full)** | Thu âm trực tiếp từ element trên cùng origin. |
| **Firefox YouTube** | Firefox 155+ (Win11) | `captureStream()` / MediaElementSource | ✅ Có | ✅ Có | **Khả thi (Verified)** | Trích xuất audio từ player MSE sau buffering. |
| **Video Cross-Origin (No CORS)** | Chrome 152+ | `tabCapture` | ✅ Có | ✅ Có | **Hỗ trợ** | Tab audio capture bỏ qua giới hạn CORS của element. |
| **Video Cross-Origin (No CORS)** | Firefox 155+ | MediaElement Capture | ❌ Hạn chế | ✅ Có | **Cần cấp quyền/CORS** | Browser bảo vệ origin, có thể cần prompt quyền. |
| **Video có bản quyền (DRM)** | Cả hai trình duyệt | Encrypted Media Extensions (EME) | ❌ Không | ❌ Không | **Không hỗ trợ** | Tuân thủ chính sách bảo vệ DRM của PRD. |
| **Livestream (HLS/DASH)** | Cả hai trình duyệt | Continuous Buffer Capture | ✅ Có | ✅ Có | **Hỗ trợ** | Thuyết minh liên tục với độ trễ có kiểm soát. |
