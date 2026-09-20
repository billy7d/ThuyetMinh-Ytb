# Kiến trúc Kỹ thuật Hệ thống — VietDub AI

VietDub AI là tiện ích mở rộng trình duyệt (Chrome & Firefox) cung cấp giải pháp thuyết minh tiếng Việt và phụ đề theo thời gian thực cho video tiếng Anh, giữ nguyên trải nghiệm xem trực tiếp không cần tải video về máy.

---

## 1. Kiến trúc Tổng thể (High-Level Architecture)

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           BROWSER EXTENSION                             │
│                                                                         │
│  ┌─────────────────┐       ┌─────────────────┐       ┌────────────────┐ │
│  │    Popup UI     │       │ Subtitle Engine │       │   Video Sync   │ │
│  │ (React/Tailwind)│       │  (DOM Overlay)  │       │   Controller   │ │
│  └────────┬────────┘       └────────▲────────┘       └───────┬────────┘ │
│           │                         │                        │          │
│           ▼                         │                        ▼          │
│  ┌─────────────────┐                │              ┌──────────────────┐ │
│  │ Session Manager │────────────────┼──────────────┤  HTML5 Video     │ │
│  └────────┬────────┘                │              └────────┬─────────┘ │
│           │                         │                       │           │
│  ┌────────▼─────────────────────────┴───────────────────────▼─────────┐ │
│  │                    Audio Capture & Mixer Engine                    │ │
│  │                                                                    │ │
│  │  [Chrome: tabCapture + Offscreen]    [Firefox: Content Script]     │ │
│  │                                                                    │ │
│  │                 Audio Input (MediaStream / Video)                  │ │
│  │                               │                                    │ │
│  │          ┌────────────────────┴─────────────────────┐              │ │
│  │          │ (STT Tap - Trước Volume Control)         │              │ │
│  │          ▼                                          ▼              │ │
│  │   PCM Processor (16kHz)                     Original GainNode      │ │
│  │   (Base64 Audio Chunks)                             │ (0% - 100%)  │ │
│  │          │                                          ▼              │ │
│  │          │                                     Destination (Loa)   │ │
│  │          │                                          ▲              │ │
│  │          │                                          │ (0% - 100%)  │ │
│  │          │                                    TTS GainNode         │ │
│  │          │                                          ▲              │ │
│  │          │                                          │              │ │
│  └──────────┼──────────────────────────────────────────┼──────────────┘ │
└─────────────┼──────────────────────────────────────────┼────────────────┘
              │ WSS                                      │ Decoded Audio
              ▼                                          │
┌────────────────────────────────────────────────────────┴────────────────┐
│                           REALTIME AI BACKEND                           │
│                                                                         │
│  ┌─────────────────────────┐             ┌───────────────────────────┐  │
│  │    WebSocket Gateway    │────────────▶│       Local STT Worker     │  │
│  │ (loopback/origin/session│             │ (VAD + Interim/Final TX)  │  │
│  └─────────────────────────┘             └─────────────┬─────────────┘  │
│                 ▲                                      │                │
│                 │                                      ▼                │
│                 │                        ┌───────────────────────────┐  │
│                 │                        │ Context Translation Engine│  │
│                 │                        │ (local en→vi model,       │  │
│                 │                        │  Context Memory + terms) │  │
│                 │                        └─────────────┬─────────────┘  │
│                 │                                      │                │
│                 │                                      ▼                │
│                 │                        ┌───────────────────────────┐  │
│                 └────────────────────────┤   Vietnamese TTS Engine   │  │
│                     Audio & Subtitle     │ (local worker + Cancel on │  │
│                          Events          │  Seek/Pause Generation)   │  │
│                                          └───────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Các Thành phần Cốt lõi

### 2.1. Audio Capture & Mixer
- **Độc lập hai kênh:** Tín hiệu STT được trích xuất (tap) trước `OriginalGainNode`. Khi người dùng kéo âm lượng video gốc về 0% (hoặc tích chọn "Tắt hoàn toàn âm thanh gốc"), đầu vào STT vẫn duy trì 100% tín hiệu.
- **Chrome Adapter:** Kết hợp Service Worker gọi `chrome.tabCapture.getMediaStreamId()` và chuyển sang Offscreen Document để tạo `MediaStreamSource`.
- **Firefox Adapter:** Sử dụng Content Script tương tác trực tiếp với thẻ `<video>` thông qua `video.captureStream()` và Web Audio graph.

### 2.2. Voice Activity Detection & Streaming STT
- Sử dụng thuật toán tính toán năng lượng RMS trên frame PCM 16kHz Mono.
- Phát hiện khoảng lặng (silence >= 650ms) để xác định điểm kết thúc câu nói (utterance boundary).
- Hỗ trợ trả về Interim results để cập nhật giao diện trước khi chốt Final transcript.
- Production gateway dùng local worker JSONL; `whisper.cpp` là ứng viên STT và worker phải giữ model trong tiến trình lâu dài. Mock STT chỉ được phép trong unit/integration tests.

### 2.3. Context-Aware Translation Engine
- **7 Quy tắc vàng:**
  1. Dịch theo nghĩa toàn câu, tự nhiên theo văn nói tiếng Việt.
  2. Giữ nguyên số liệu, ngày tháng, tên riêng, thuật ngữ.
  3. Tránh dịch máy từng từ (word-by-word) gây cứng nhắc.
  4. Tuyệt đối không bịa đặt hoặc tự tiện thêm bớt thông tin.
  5. Giữ nhất quán thuật ngữ chuyên ngành trong suốt phiên xem video.
  6. Phong cách thuyết minh truyền cảm, dễ nghe.
  7. Tự động kiểm tra tính trọn vẹn ngữ nghĩa (`SentenceCompletionGuard`) để tránh dịch nửa câu.
- **Context Manager:** Duy trì sliding window 5 câu gần nhất kèm bản dịch tiếng Việt để giữ mạch văn thống nhất.

### 2.4. Vietnamese TTS Engine & Sync Controller
- Production gateway gọi local Vietnamese TTS worker và kiểm tra metadata WAV thực tế; synthetic WAV chỉ là test fixture.
- **Generation Tracking:** Mỗi khi người dùng tua video (seek) hoặc pause, generation ID được tăng lên, lập tức hủy bỏ (cancel) các yêu cầu sinh audio cũ đang chờ và làm sạch hàng đợi phát lại.
- **Subtitle Overlay:** Tự động gắn lên video container, hỗ trợ toàn màn hình (fullscreen), tương phản cao, tự xuống dòng không che khuất nội dung chính.

### 2.5. Chi phí & Giới hạn Ngân sách (Cost & Budget Guard)
- Công thức tính toán thời gian thực:
  $$\\text{Tổng chi phí} = \\text{STT} + \\text{Translation} + \\text{TTS} + \\text{Hạ tầng}$$
- Tự động ngắt kết nối khi chi phí phiên chạm ngưỡng an toàn (mặc định $2.00/phiên).
