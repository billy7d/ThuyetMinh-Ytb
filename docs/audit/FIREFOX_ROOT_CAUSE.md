# Báo cáo Audit & Xác định Nguyên nhân Gốc (Root Cause Analysis) — VietDub AI

**Mã lỗi:** `❌ Could not establish connection. Receiving end does not exist.`  
**Nền tảng báo lỗi:** Mozilla Firefox Desktop (và tiềm ẩn trên Google Chrome)  
**Địa chỉ kiểm thử:** YouTube (`https://www.youtube.com/watch?v=...`)  
**Mức độ ưu tiên:** P0 — Blocker  
**Ngày thực hiện:** 17/09/2026  

---

## 1. Nguyên nhân gốc đã được xác nhận (Confirmed Root Cause)

### 🔴 Nguyên nhân cốt lõi: Build Artifact của Content Script chứa cú pháp ES Module `import` không hợp lệ trong Content Script Context

Khi kiểm tra tệp bundle thực tế sau khi biên dịch:
`packages/extension/dist/firefox/content/content.js` (dòng 1):
```javascript
import{D as b,a as C}from"../chunks/constants-DE2r3vVb.js";class M{containerEl=null;...
```
và tại `packages/extension/dist/chrome/content/content.js` (dòng 1):
```javascript
import{A as k,P as w}from"../chunks/pcm-processor-DdOtpzy9.js";import"../chunks/constants-DE2r3vVb.js";class M{...
```

### 🔬 Bằng chứng kỹ thuật (Evidence)
1. **Quy chuẩn WebExtensions:** Trong cả Manifest V3 của Firefox và Chrome, các tệp khai báo trong trường `"content_scripts"` của `manifest.json` được nạp trong **Classic Script Context (Non-module)** trong Isolated World của tab. Trình duyệt **không hỗ trợ** câu lệnh `import ... from ...` tĩnh ở đầu tệp content script.
2. **Cơ chế gây lỗi:**
   - Ngay khi tab YouTube nạp `content/content.js`, trình duyệt phân tích cú pháp (parse) dòng 1 và lập tức ném ra ngoại lệ cú pháp chết người:
     `SyntaxError: import declarations may only appear at top level of a module` (Firefox)
     hoặc `SyntaxError: Cannot use import statement outside a module` (Chrome).
   - Ngoại lệ này khiến toàn bộ quá trình thực thi của `content.js` bị dừng ngay lập tức.
   - Do bị crash tại dòng 1, dòng đăng ký lắng nghe tin nhắn:
     `chrome.runtime.onMessage.addListener(...)` **chưa bao giờ được thực thi**.
3. **Hậu quả dây chuyền:**
   - Khi người dùng bấm vào popup hoặc popup gửi tin nhắn `CHECK_VIDEO`, hoặc background gửi `FIREFOX_START_CAPTURE`, trình duyệt tìm kiếm listener đăng ký trong tab nhưng không thấy.
   - Trình duyệt trả về lỗi chuẩn của WebExtensions:
     `❌ Could not establish connection. Receiving end does not exist.`
   - Kể cả khi popup cố gắng dùng `chrome.scripting.executeScript({ files: ['content/content.js'] })`, tệp được chèn vào cũng là tệp chứa `import`, tiếp tục ném ra `SyntaxError` và thất bại hoàn toàn.

---

## 2. Các nguyên nhân phụ và rủi ro liên quan phát hiện trong đợt Audit

Bên cạnh nguyên nhân gốc ở hệ thống build, quá trình audit phát hiện 4 vấn đề kỹ thuật khác ảnh hưởng trực tiếp đến độ ổn định trên Firefox:

### 2.1. Mâu thuẫn Rate Limit giữa Client PCMProcessor và Backend CostTracker (PRD Mục 8.3)
- Tại `packages/extension/src/audio/pcm-processor.ts`:
  `bufferSize = 4096`. Khi chạy với audio context mặc định 48kHz:
  $$\text{Thời lượng 1 buffer} = \frac{4096}{48000} \approx 0.0853\text{ giây} \implies \approx 11.7\text{ chunks/giây}$$
- Trong khi tại `packages/backend/src/cost/cost-tracker.ts`:
  `rateLimitChunksPerSecond = 10`.
- **Hậu quả:** Ngay sau khi vượt qua kết nối khoảng 1 giây, backend sẽ ném ra lỗi `[CostTracker] Rate limit exceeded: 12 chunks/sec` và làm đứt kết nối phiên.
- **Giải pháp:** Cần đệm mẫu âm thanh trong `PCMProcessor` theo khung cố định 250ms (4 chunks/giây), hoàn toàn tương thích với `CHUNK_DURATION_MS = 250` và nằm an toàn dưới ngưỡng 10 chunk/giây.

### 2.2. Trạng thái Suspended của AudioContext trên Firefox
- Trên Firefox, việc khởi tạo `new AudioContext()` trong content script khi người dùng bấm vào popup (hoặc do background trigger) có thể rơi vào trạng thái `'suspended'` do chính sách Autoplay Policy của Firefox.
- **Giải pháp:** Bắt buộc gọi `await audioCtx.resume()` trước khi kết nối luồng âm thanh.

### 2.3. Thiếu Handshake PING/PONG kiểm tra tính sẵn sàng trước khi START
- Hiện tại Popup gửi lệnh START ngay khi bấm nút mà không có bước handshake xác thực Content Script đã nạp xong và đã sẵn sàng.
- **Giải pháp:** Triển khai quy trình handshake có cấu trúc:
  `Popup -> Background: START_REQUEST`
  `Background -> Content: PING`
  `Content -> Background: PONG/READY`
  `Background -> Content: START_CAPTURE`
  `Content -> Backend: SESSION_START`
  `Backend -> Content: SESSION_READY`
  `Background -> Popup: START_SUCCESS`

### 2.4. Nguy cơ Duplicate Injection và Trùng lặp Observer
- `content.ts` chưa có cờ (flag) bảo vệ idempotent. Nếu script được nạp lại, các MutationObserver và listener sẽ bị nhân đôi.
- **Giải pháp:** Bổ sung cờ `(window as any).__VIETDUB_CONTENT_INJECTED__` để đảm bảo mỗi trang chỉ chạy duy nhất một instance.

---

## 3. Các giả thuyết đã được kiểm tra và loại trừ (Eliminated Hypotheses)

| Giả thuyết | Đánh giá | Lý do loại trừ |
| :--- | :---: | :--- |
| **Backend offline hoặc crash** | ❌ Loại trừ | Backend WebSocket server hoạt động bình thường trên cổng 8080. Lỗi xảy ra bên trong nội bộ trình duyệt trước khi bất kỳ kết nối mạng nào được thiết lập. |
| **Không tìm thấy thẻ `<video>` trên YouTube** | ❌ Loại trừ | YouTube luôn có phần tử `video.video-stream.html5-main-video`. Lỗi không phải do DOM query mà do content script bị crash cú pháp nên hàm query không hề được chạy. |
| **Thiếu quyền truy cập tab trong Manifest** | ❌ Loại trừ | Manifest đã có `"activeTab"`, `"scripting"` và `"<all_urls>"`. Quyền truy cập API hợp lệ. |
| **Do timeout quá ngắn** | ❌ Loại trừ | Tăng timeout không có tác dụng vì script đã chết ngay từ khâu nạp JavaScript đầu tiên. |

---

## 4. Kế hoạch sửa đổi tối thiểu (Minimal Fix Plan)

1. **Phase 2 — Sửa hệ thống Build:**
   - Cấu hình lại Vite/Rollup để xuất `content.js` dạng **IIFE độc lập (self-contained)**, không có `import`, không có `export`, inlined toàn bộ mã nguồn phụ thuộc từ `@vietdub/shared`.
   - Tạo script `scripts/validate-extension-build.mjs` tự động kiểm tra artifact sau build, chặn đứng mọi build chứa cú pháp module trong content script.
2. **Phase 3 — Sửa Messaging & Idempotency:**
   - Thêm bảo vệ idempotent `__VIETDUB_CONTENT_INJECTED__`.
   - Chuẩn hóa luồng Handshake `PING` -> `PONG` -> `START` -> `SESSION_READY`.
3. **Phase 4 & 5 — Sửa Session Lifecycle & Audio:**
   - Khởi tạo AudioContext có `await audioCtx.resume()`.
   - Đệm chunk âm thanh 250ms trong `PCMProcessor` (4 chunk/giây), khắc phục triệt để lỗi vượt rate-limit của backend.
   - Triển khai máy trạng thái `IDLE -> INITIALIZING -> CONNECTING -> READY -> ACTIVE -> STOPPING`.
4. **Phase 6 & 7 — Sửa UI & Kiểm thử Bắt buộc:**
   - Cập nhật hiển thị trạng thái popup rõ ràng theo từng stage.
   - Viết bài kiểm thử E2E Playwright thực tế nạp extension thật trên Firefox và Chrome.
