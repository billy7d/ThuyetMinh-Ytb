# Báo cáo An toàn, Bảo mật & Quyền riêng tư — VietDub AI

**Tiêu chuẩn tuân thủ:** Chrome Web Store Developer Program Policies & Mozilla Add-on Policies.

---

## 1. Không Hardcode Khóa API (Zero Hardcoded Secrets)
- Mã nguồn extension (cả Chrome và Firefox distribution builds) hoàn toàn **không chứa bất kỳ API key, secret token hay thông tin nhạy cảm** nào.
- Mọi giao tiếp với các nhà cung cấp trí tuệ nhân tạo (STT, LLM Translation, Neural TTS) đều được định tuyến thông qua Realtime AI Backend trung gian.
- Backend quản lý khóa API thông qua biến môi trường (`process.env`) được cấu hình tại server hoặc file `.env` cục bộ (đã đưa vào `.gitignore`).

---

## 2. Quyền riêng tư của người dùng (User Privacy & Consent)
- **Chỉ thu âm khi người dùng kích hoạt:** Extension tuyệt đối không kích hoạt thu âm hay lắng nghe âm thanh ngầm trước khi người dùng bấm nút "Bắt đầu thuyết minh" trong giao diện Popup.
- **Không truy cập Microphone:** Extension chỉ thu luồng âm thanh phát ra từ tab video mà người dùng đang xem (`tabCapture` trên Chrome hoặc phần tử `<video>` trên Firefox). Quyền microphone của người dùng không bị yêu cầu.
- **Cách ly giữa các Tab:** Mỗi tab hoạt động độc lập, không có tình trạng thu âm nhầm hoặc rò rỉ âm thanh giữa các tab khác nhau.
- **Không lưu trữ vĩnh viễn âm thanh (Zero Retention):** Dữ liệu âm thanh PCM chỉ tồn tại trong bộ nhớ đệm luồng (streaming memory) để nhận diện và bị hủy ngay lập tức sau khi xử lý xong câu nói. Không có tệp âm thanh nào được lưu trữ trên ổ đĩa hay máy chủ từ xa.

---

## 3. Bảo vệ Mã nguồn & Ngăn chặn Thực thi Từ xa (No Remote Code Execution)
- Tuân thủ nghiêm ngặt quy định Manifest V3: Toàn bộ mã nguồn thực thi của Extension đều được đóng gói tĩnh (statically bundled) tại thời điểm build (`dist/chrome` và `dist/firefox`).
- Không sử dụng `eval()`, `new Function()` hay chèn script động từ máy chủ bên ngoài.
- Dữ liệu văn bản từ STT và Translation được xử lý dưới dạng văn bản thuần (`textContent`), ngăn chặn triệt để các lỗ hổng XSS (Cross-Site Scripting) khi hiển thị phụ đề trên DOM.

---

## 4. Quản lý Tài nguyên & Bảo vệ Chi phí (Budget Guard & Rate Limiting)
- Triển khai `BudgetGuard` ngắt kết nối tự động nếu chi phí phiên vượt ngưỡng an toàn ($2.00/phiên).
- Triển khai `RateLimiter` hạn chế số lượng audio chunk (tối đa 10 chunk/giây) nhằm ngăn ngừa tấn công DoS hoặc tràn bộ nhớ.
- Khi người dùng đóng tab hoặc bấm "Dừng thuyết minh", toàn bộ kết nối WebSocket và Web Audio context đều được giải phóng hoàn toàn (`cleanup()`), không gây rò rỉ tài nguyên hệ thống (RAM/CPU).
