# Báo cáo Đánh giá Bảo mật & Độ Ổn định Mở rộng (Security & Reliability Audit) — VietDub AI

**Dự án:** VietDub AI — Real-time Vietnamese Dubbing Extension  
**Mục tiêu:** Rà soát kiến trúc WebExtensions, tương tác DOM/Audio trên các trang video bên thứ ba (YouTube, Vimeo, Bilibili), quản lý tài nguyên bộ nhớ, bảo vệ hạn mức ngân sách và xử lý ràng buộc Cross-Origin.  
**Ngày thực hiện:** 17/09/2026  
**Trạng thái:** Snapshot audit lịch sử; runtime extension hiện tại còn gate browser độc lập

> **Đính chính 2026-09-17:** Các kết luận media/cleanup và test rate-limit trong tài liệu này không thay thế browser extension E2E. Chrome capture còn cần action invocation thật; Firefox temporary-install E2E chưa chạy được trong host. Evidence hiện tại nằm trong [P0 Review Fix Report](P0_REVIEW_FIX_REPORT.md).

---

## 1. Content Security Policy (CSP) & Rủi ro Inline Script (Mục 8.1)

### 1.1. Kiến trúc thực thi trong Isolated World
- Content scripts của extension chạy trong một không gian riêng biệt (**Isolated World**) của tab trình duyệt.
- Isolated World có cây DOM chung với trang YouTube, nhưng có không gian biến JavaScript (`window`) độc lập với các script của YouTube.
- **Rủi ro rò rỉ mã độc:** Không có việc chèn mã inline (`eval` hoặc inline `<script>` tags). Toàn bộ mã extension được đóng gói thành các tệp tĩnh đã được bundler làm sạch và kiểm định (`validate-extension-build.mjs`).

### 1.2. Chính sách kết nối mạng (CSP `connect-src` và WebSocket)
- **Trên Google Chrome (MV3):**
  - Toàn bộ lưu lượng mạng AI (kết nối WebSocket tới `ws://localhost:8080`) được thực hiện trong **Offscreen Document**.
  - Offscreen Document tuân thủ CSP của extension (`extension_pages`), không bị chi phối bởi header `Content-Security-Policy` của trang web (YouTube).
  - Điều này loại bỏ hoàn toàn nguy cơ kết nối bị chặn bởi CSP của bên thứ ba.
- **Trên Mozilla Firefox:**
  - Firefox MV3 chưa hỗ trợ Chrome Offscreen Documents. Do đó, kết nối WebSocket được khởi tạo trực tiếp từ Content Script (hoặc Background Script).
  - Khi khởi tạo từ Content Script, trình duyệt Firefox áp dụng quyền của WebExtension (`host_permissions: ["<all_urls>"]`). Nhờ đó, kết nối WebSocket tới `ws://localhost:8080` không bị chặn bởi header CSP của YouTube.
  - **Khuyến nghị dự phòng đường dài:** Trong trường hợp các phiên bản Firefox tương lai thắt chặt quyền kết nối từ content script, kiến trúc đã sẵn sàng phương án chuyển tiếp (relay): Content Script gửi binary audio chunks qua `browser.runtime.port` về Background Script, và Background Script kết nối WebSocket tới backend AI.

---

## 2. Quản lý Rò rỉ Bộ nhớ & Dọn dẹp Tài nguyên (Mục 8.2)

### 2.1. Đồ thị Web Audio (Web Audio Graph)
Web Audio API nếu không được ngắt kết nối đúng cách sẽ giữ lại tham chiếu phần cứng và bộ nhớ đệm luồng âm thanh trên hệ điều hành.
- **Các thành phần được rà soát:**
  - `AudioContext`
  - `MediaElementAudioSourceNode` / `MediaStreamAudioSourceNode`
  - `GainNode` (`originalGainNode`, `ttsGainNode`, `sttTapNode`)
  - `ScriptProcessorNode` (`processorNode`)
- **Cơ chế dọn dẹp đã triển khai (`stopCapture()` / `cleanupFirefoxSession()`):**
  1. `PCMProcessor.stop()`: Gọi `processorNode.disconnect()` và gán `onaudioprocess = null` để garbage collector thu hồi buffer.
  2. `AudioMixer.disconnect()`: Ngắt kết nối tất cả các GainNodes và SourceNode khỏi audio destination.
  3. `AudioContext.close()`: Đóng luồng âm thanh phần cứng, giải phóng thread xử lý âm thanh thời gian thực.
  4. Trên Chrome Offscreen: Gọi `mediaStream.getTracks().forEach(t => t.stop())` để trả lại quyền capture của tab.

### 2.2. Vòng đời WebSocket & Phòng tránh Zombie Connections
- Khi người dùng bấm "Dừng thuyết minh": Client chủ động gửi thông điệp `SESSION_STOP` kèm `sessionId` trước khi gọi `ws.close()`.
- Nếu kết nối mạng gián đoạn, client có timeout 7 giây để tự hủy phiên, không duy trì socket treo.
- Khi đóng tab hoặc điều hướng sang URL mới:
  - Cả Chrome Background và Firefox Background đều lắng nghe sự kiện `chrome.tabs.onRemoved` và `chrome.tabs.onUpdated`.
  - Khi tab đang thu âm bị đóng hoặc chuyển trang, background gọi `sessionManager.stop()`, giải phóng socket và tài nguyên offscreen/content script.

### 2.3. Dọn dẹp Giao diện DOM
- Subtitle overlay (`#vietdub-subtitle-container`) được tạo động bên trong container của video YouTube.
- Khi dừng hoặc chuyển video, hàm `SubtitleRenderer.detach()`:
  - Xóa toàn bộ timer hiển thị phụ đề (`clearTimeout(this.hideTimeout)`).
  - Gỡ bỏ hoàn toàn element khỏi cây DOM (`parentElement.removeChild`).
  - Gán `null` các tham chiếu DOM element.

---

## 3. Quản lý Tần suất Dữ liệu & Kiểm soát Ngân sách (Mục 8.3)

### 3.1. Khắc phục Xung đột Tần suất Chunk (Rate Limiting Fix)
- **Vấn đề trước đây:** `PCMProcessor` gửi buffer 4096 mẫu ở tần số 48kHz, phát sinh ~11.7 chunks/giây, vượt ngưỡng chặn của `CostTracker` (`rateLimitChunksPerSecond = 10`), gây ngắt kết nối đột ngột sau 1 giây.
- **Đã khắc phục:** Đưa vào bộ đệm tích lũy mẫu (chunk accumulator) phát ra chính xác 4000 mẫu ở tần số 16kHz tương đương khung 250ms (4 chunks/giây).
- **Kết quả kiểm thử offline/integration:** Tốc độ 4 chunks/giây thấp hơn 60% so với ngưỡng giới hạn. Đây không phải đo runtime browser end-to-end.

### 3.2. Giới hạn Ngân sách Tự động (Budget Guard)
- `CostTracker` được cấu hình ngưỡng ngân sách mặc định `$0.50` cho mỗi phiên (tương đương ~22 phút thuyết minh liên tục nếu dùng cloud API cao cấp).
- Khi chạm ngưỡng, hệ thống tự động phát cờ ngắt an toàn và thông báo người dùng, ngăn chặn tình trạng phát sinh chi phí ngoài tầm kiểm soát khi người dùng quên tắt extension.

---

## 4. Ràng buộc Thu Âm Đa Miền (Cross-Origin Media Constraints) (Mục 8.4)

### 4.1. Nguy cơ CORS Taint trên thẻ Video HTML5
- Khi một video được phân phối từ CDN có domain khác với trang hiện tại (ví dụ: `googlevideo.com` trên `youtube.com`) và thiếu header `Access-Control-Allow-Origin: *`, việc gọi `audioCtx.createMediaElementSource(video)` có thể khiến trình duyệt kích hoạt cơ chế bảo mật CORS taint, dẫn đến việc luồng âm thanh bị đưa về mức 0 (im lặng hoàn toàn).

### 4.2. Giải pháp Đa Tầng Đã Triển khai
1. **Đối với Firefox:**
   - Implementation hiện tại ưu tiên `createMediaElementSource(video)` để điều khiển đúng đường loa gốc.
   - Nếu media element source thất bại, implementation fallback sang `video.captureStream()` hoặc `video.mozCaptureStream()` và điều chỉnh volume native của video; khả năng CORS vẫn cần browser validation thực tế.
2. **Đối với Chrome:**
   - Chrome sử dụng `chrome.tabCapture.getMediaStreamId()`. Cơ chế này hoạt động ở cấp độ renderer của cả tab trình duyệt (Browser-level capture), hoàn toàn độc lập và miễn nhiễm với các ràng buộc CORS của từng phần tử DOM.
