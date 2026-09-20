# Known Limitations

Ngày cập nhật: 2026-09-20

> **Đính chính 2026-09-17:** Bảng feasibility/media bên dưới là bằng chứng lịch sử của trang kiểm thử, không xác nhận extension runtime hiện tại. Chrome còn thiếu action invocation thật; Firefox extension E2E còn thiếu temporary-install runner. Xem [P0 Review Fix Report](audit/P0_REVIEW_FIX_REPORT.md).

---

## 1. Bảng Ma trận Kiểm thử Website Thực tế

| Website / Nền tảng | Trình duyệt | Khả năng thu âm | Thuyết minh AI | Ghi chú kỹ thuật |
| :--- | :---: | :---: | :---: | :--- |
| **HTML5 Video (Same-Origin)** | Chrome | ✅ Đạt | ✅ Hoạt động | Thu qua `tabCapture` + Offscreen. |
| **HTML5 Video (Same-Origin)** | Firefox | ✅ Đạt | ✅ Hoạt động | Thu qua `captureStream()` trên `<video>`. |
| **YouTube HTML5 Video** | Chrome | ✅ Đạt | ✅ Hoạt động | Thu âm luồng tab trực tiếp, không ảnh hưởng bởi DASH/MSE. |
| **YouTube HTML5 Video** | Firefox | ✅ Đạt | ✅ Hoạt động | Hoạt động trên phần tử video sau khi đã buffer qua MSE. |
| **Video Cross-Origin (Có CORS)** | Cả hai | ✅ Đạt | ✅ Hoạt động | Có header `Access-Control-Allow-Origin: *`. |
| **Video Cross-Origin (Không có CORS)** | Chrome | ✅ Đạt | ✅ Hoạt động | `tabCapture` ở tầng compositor nên không bị chặn bởi CORS element. |
| **Video Cross-Origin (Không có CORS)** | Firefox | ⚠️ Hạn chế | ⚠️ Cần cấp quyền | Firefox chặn capture stream từ element cross-origin không có header CORS để bảo vệ quyền riêng tư. Khi gặp trường hợp này, extension sẽ hiển thị cảnh báo hướng dẫn người dùng. |
| **Nội dung có bản quyền DRM (Netflix, Apple TV, Spotify)** | Cả hai | ❌ Không | ❌ Không | Luồng âm thanh được bảo vệ bởi Encrypted Media Extensions (EME) và giải mã tại tầng phần cứng/CDM. Extension tuyệt đối không can thiệp hay vượt qua cơ chế DRM theo đúng cam kết PRD. |
| **Livestream (HLS / DASH)** | Cả hai | ✅ Đạt | ✅ Hoạt động | Thuyết minh gần thời gian thực (độ trễ p50 ~3s). Không áp dụng tua ngược timeline cho livestream vô hạn. |

---

## 2. Phân biệt Giảm Âm lượng vs Tách Giọng Nói (Voice Separation)

- **Chức năng hiện tại của MVP:**
  - Thanh trượt "Âm thanh video gốc" (0% – 100%) và tùy chọn "Tắt hoàn toàn âm thanh gốc" sẽ làm giảm hoặc tắt **toàn bộ** âm thanh của video gốc (bao gồm giọng nói tiếng Anh, nhạc nền và hiệu ứng âm thanh).
  - Tín hiệu STT được lấy trước GainNode này nên AI vẫn nhận diện và thuyết minh tiếng Việt bình thường ngay cả khi video gốc tắt tiếng 100%.
- **Hạng mục nằm ngoài phạm vi MVP:**
  - Tính năng "Chỉ tách bỏ giọng nói người dẫn mà vẫn giữ lại nhạc nền (BGM)" đòi hỏi mô hình phân tách nguồn âm thanh (Music Source Separation / Demucs) chạy thời gian thực trên client hoặc máy chủ GPU lớn. Hạng mục này đã được thống nhất hoãn sang phiên bản tương lai.

---

## 3. Quản lý Độ trễ trên Livestream (Latency Drift Guard)

- Trong các buổi phát trực tiếp liên tục nhiều giờ (Livestream), nếu tốc độ nói của người dẫn quá nhanh hoặc mạng bị gián đoạn tạm thời, các đoạn thuyết minh có thể tích lũy độ trễ.
- Hệ thống giải quyết bằng cơ chế **Frame Dropping:** Nếu một đoạn thuyết minh bị trễ quá 6 giây so với mốc phát trực tiếp hiện tại, hệ thống sẽ ưu tiên hiển thị phụ đề và bỏ qua chunk TTS tương ứng thay vì cố phát dồn dập khiến âm thanh thuyết minh tụt lại ngày càng xa.
