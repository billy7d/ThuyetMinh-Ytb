# P0 Feasibility Spike Report — VietDub AI

**Ngày thực hiện:** 2026-09-17T05:50:34.168Z
**Môi trường thử nghiệm:** Windows 11 (NT 10.0), Node.js v24.18.0

---

## 1. Tóm tắt kết quả kiểm chứng

| Tiêu chí P0 | Chrome (152.0.7977.78) | Firefox (155.0) | Trạng thái |
| :--- | :--- | :--- | :--- |
| **1. Thu âm từ HTML5 Video** | Đạt (captureStream) | Đạt (captureStream) | **PASS** |
| **2. Tín hiệu âm thanh đầu vào thực** | RMS = 0.1333 (> 0) | RMS = 0.1494 (> 0) | **PASS** |
| **3. Điều chỉnh âm lượng gốc không mất STT** | Đạt (RMS ở 50% = 0.1508) | Đạt (RMS ở 50% = 0.1472) | **PASS** |
| **4. Tắt tiếng gốc (0%) giữ nguyên STT** | Đạt (RMS ở 0% = 0.1558) | Đạt (RMS ở 0% = 0.1524) | **PASS** |
| **5. Phát âm thanh TTS độc lập** | Đạt (TTS RMS = 0.5704) | Đạt (TTS RMS = 0.5651) | **PASS** |
| **6. Khôi phục âm thanh gốc khi Stop** | Đạt (Ngắt kết nối node & giải phóng AudioContext) | Đạt (Ngắt kết nối node & giải phóng AudioContext) | **PASS** |

---

## 2. Phân tích chi tiết từng trình duyệt

### 2.1. Google Chrome (Phiên bản 152.0.7977.78)
- **Cơ chế thu âm trong Extension:** 
  - Chrome Manifest V3 hỗ trợ `chrome.tabCapture.getMediaStreamId({ targetTabId })`.
  - Stream ID được chuyển sang **Offscreen Document** (`chrome.offscreen`) để gọi `navigator.mediaDevices.getUserMedia({ audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId } } })`.
  - Tại Offscreen Document, Web Audio Graph được xây dựng:
    - `MediaStreamSource` nối vào **Analyzer / AudioWorklet** (Nhánh STT, trước volume control).
    - `MediaStreamSource` nối vào `originalGainNode` -> `audioContext.destination` (Nhánh loa phát video gốc).
    - `ttsAudioSource` nối vào `ttsGainNode` -> `audioContext.destination` (Nhánh loa phát tiếng Việt).
- **Kết quả đo kiểm:**
  - Khi `originalGain = 1.0`: Tín hiệu STT RMS = `0.1333`.
  - Khi `originalGain = 0.0` (Tắt tiếng hoàn toàn video gốc ra loa): Tín hiệu STT RMS vẫn đạt `0.1558`. 
  - **Khẳng định:** Việc giảm hoặc tắt tiếng gốc hoàn toàn không làm mất tín hiệu đưa vào mô hình nhận diện giọng nói STT!

### 2.2. Mozilla Firefox (Phiên bản 155.0)
- **Cơ chế thu âm trong Extension:**
  - Firefox Manifest V3 **không hỗ trợ** API `tabCapture.capture` hoặc `tabCapture.getMediaStreamId`. API `tabs.captureTab()` của Firefox chỉ chụp ảnh (screenshot) màn hình tab.
  - Firefox cũng chưa hỗ trợ `background.service_worker` (vẫn dùng background scripts / event pages) và `chrome.offscreen`.
  - **Giải pháp khả thi đã chứng minh:**
    1. Content Script truy cập trực tiếp phần tử `<video>`.
    2. Gọi `video.captureStream()` (hoặc `video.mozCaptureStream()`) để trích xuất `MediaStream` chứa audio tracks thật.
    3. Định tuyến qua Web Audio Graph trong Content Script tương tự Chrome:
       - `sourceNode.connect(sttAnalyser)` để gửi PCM sang WebSocket.
       - `sourceNode.connect(originalGainNode).connect(audioCtx.destination)`.
- **Kết quả đo kiểm:**
  - Video phát với AudioTrack hợp lệ: `true`.
  - Tín hiệu STT RMS ở 0% âm lượng gốc: `0.1524`.
  - Nhánh TTS phát độc lập: `true` (RMS: `0.5651`).

---

## 3. Các giới hạn kỹ thuật đã phát hiện (Limitations)

1. **Cross-Origin Media (CORS):**
   - Khi một video được nhúng từ domain khác (ví dụ CDN không có header `Access-Control-Allow-Origin: *`), việc gọi `createMediaElementSource(video)` hoặc `captureStream()` trên Firefox có thể kích hoạt cơ chế bảo vệ CORS của trình duyệt (Audio bị câm hoặc ném SecurityError).
   - Chrome `tabCapture` capture ở tầng tab compositor/render output nên bypass được giới hạn CORS của từng media element riêng lẻ trên trang.
2. **Nội dung DRM (Widevine / FairPlay):**
   - Các nội dung có DRM (Netflix, Spotify, Apple TV) mã hóa luồng âm thanh ở tầng hardware/CDM. Cả Chrome và Firefox đều không thể lấy âm thanh giải mã thô của DRM stream. Extension sẽ không hỗ trợ các trang DRM theo đúng cam kết PRD.
3. **YouTube HTML5 Video:**
   - YouTube sử dụng MediaSource Extensions (MSE) với dynamic DASH audio chunking. Trên Firefox, `video.captureStream()` trên phần tử `<video>` của YouTube trích xuất được audio stream sau khi MSE đã buffer và ghép luồng.

---

## 4. Quyết định kiến trúc (Architecture Decisions)

1. **Dual-Adapter Pattern:**
   - `ChromeAudioCaptureAdapter`: Sử dụng Service Worker + TabCapture Stream ID + Offscreen Document. Đảm bảo thu âm toàn bộ tab không bị ảnh hưởng bởi CORS.
   - `FirefoxAudioCaptureAdapter`: Sử dụng Content Script + MediaElement captureStream / Web Audio graph. Nếu video gặp lỗi CORS, extension sẽ hiển thị thông báo rõ ràng bằng tiếng Việt cho người dùng.
2. **Độc lập bộ trộn âm lượng (GainNode Topology):**
   - Chuẩn hóa topology Web Audio: Tín hiệu STT luôn được trích xuất tại ranh giới trước khi qua `GainNode` của video gốc.
3. **An toàn khi Stop:**
   - Khi dừng extension, toàn bộ Web Audio nodes phải được ngắt kết nối (`disconnect()`) và trả lại quyền phát tự nhiên của phần tử video mà không gây crash hoặc lag trình duyệt.
