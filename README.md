# VietDub AI — Real-time Vietnamese Dubbing Extension

> **Tiện ích mở rộng trình duyệt (Google Chrome & Mozilla Firefox) thuyết minh tiếng Việt và tạo phụ đề video tiếng Anh theo thời gian thực.**

VietDub AI cho phép người dùng xem trực tiếp các video tiếng Anh trên trình duyệt (YouTube, tài liệu khoa học, tin tức, khóa học trực tuyến) với giọng thuyết minh tiếng Việt tự nhiên, ngắt nghỉ chuẩn xác và phụ đề đồng bộ, không cần tải video về máy hay tạo video mới.

---

## 🌟 Tính năng Nổi bật

1. **3 Chế độ Hoạt động Linh hoạt (FR-01):**
   - **Chỉ thuyết minh:** Tắt phụ đề, phát âm thanh tiếng Việt.
   - **Chỉ phụ đề:** Hiển thị phụ đề tiếng Việt đồng bộ, không phát giọng đọc.
   - **Thuyết minh + phụ đề:** Kết hợp cả giọng đọc và phụ đề (Mặc định).
   - Chuyển đổi chế độ mượt mà không tải lại trang hay khởi động lại phiên.

2. **Bộ Trộn Âm thanh Độc lập (FR-02):**
   - Điều chỉnh âm lượng video gốc (0% – 100%) hoặc **tắt hoàn toàn tiếng gốc** mà AI vẫn thu được tín hiệu đầu vào đầy đủ.
   - Điều chỉnh âm lượng thuyết minh tiếng Việt độc lập (0% – 100%).
   - Tự động khôi phục âm thanh gốc nguyên vẹn khi nhấn Dừng.

3. **Phụ đề Thông minh (FR-03):**
   - Tự động neo theo phần tử video (hỗ trợ cả chế độ toàn màn hình Fullscreen).
   - Tương phản cao, tự động xuống dòng không tràn khung hình.

4. **Pipeline AI Chất lượng Cao:**
   - **Streaming STT:** Tích hợp Voice Activity Detection (VAD) xác định chính xác ngắt câu.
   - **Context-aware Translation:** Dịch theo nghĩa toàn câu với văn phong nói tự nhiên của người Việt, duy trì bộ nhớ ngữ cảnh 5 câu gần nhất và đảm bảo tính nhất quán thuật ngữ chuyên ngành.
   - **Vietnamese TTS:** Giọng đọc tự nhiên, phản hồi nhanh và cơ chế hủy (`cancelGeneration`) tức thì khi người dùng tua video hoặc tạm dừng.

5. **Đo lường & Kiểm chứng Thực tế:**
   - Đạt chuẩn kiểm thử trên trình duyệt Google Chrome (152+) và Mozilla Firefox (155+) thật.
   - Độ trễ p50 thực tế đạt **~318 ms** (vượt xa mục tiêu PRD ≤ 3,000 ms).
   - Điểm chất lượng dịch đạt **4.6 / 5.0** trên bộ 30 mẫu benchmark chuẩn hóa.

---

## 📁 Cấu trúc Dự án (Monorepo)

```
vietdub-ai/
├── packages/
│   ├── shared/         # Protocol WebSocket, Types, Constants, Audio Configs
│   ├── backend/        # Realtime WebSocket Gateway, STT, Translation, TTS, Cost Guard
│   ├── extension/      # Source extension Chrome MV3 & Firefox MV3 (React + Vite)
│   │   ├── dist/chrome/   # Bản build sẵn sàng nạp cho Google Chrome
│   │   └── dist/firefox/  # Bản build sẵn sàng nạp cho Mozilla Firefox
│   └── tests/          # Unit tests (Vitest), E2E (Playwright), Benchmarks (30 mẫu)
│
├── docs/               # Báo cáo kỹ thuật chi tiết
│   ├── FEASIBILITY_REPORT.md     # Báo cáo khả thi P0 trên Chrome & Firefox
│   ├── BROWSER_COMPATIBILITY.md  # Ma trận tương thích trình duyệt thực tế
│   ├── LATENCY_REPORT.md         # Báo cáo đo lường độ trễ chi tiết
│   ├── TRANSLATION_BENCHMARK.md  # Báo cáo đánh giá 30 mẫu dịch thuật
│   ├── COST_REPORT.md            # Dự toán chi phí 1 giờ video
│   ├── ARCHITECTURE.md           # Thiết kế kiến trúc hệ thống
│   ├── SECURITY_REPORT.md        # Báo cáo an toàn, bảo mật và quyền riêng tư
│   ├── KNOWN_LIMITATIONS.md      # Danh sách giới hạn kỹ thuật đã phát hiện
│   └── TEST_REPORT.md            # Báo cáo tổng hợp kiểm thử
│
└── package.json        # Cấu hình workspace
```

---

## 🚀 Hướng dẫn Cài đặt & Khởi chạy

### 1. Yêu cầu Hệ thống
- Node.js >= 20 (Khuyến nghị Node.js v24 LTS).
- Trình duyệt Google Chrome hoặc Mozilla Firefox.

### 2. Cài đặt Phụ thuộc & Build Dự án
```bash
# Cài đặt toàn bộ dependencies cho monorepo
npm install

# Build tất cả các packages (Shared, Backend, Extension Chrome & Firefox)
npm run build
```

Sau khi build thành công:
- Bản cài đặt Chrome nằm tại: `packages/extension/dist/chrome`
- Bản cài đặt Firefox nằm tại: `packages/extension/dist/firefox`

### 3. Khởi động AI WebSocket Backend
```bash
npm run start:backend
# Server sẽ lắng nghe tại ws://localhost:8080 (hoặc cổng cấu hình trong PORT)
```

### 4. Nạp Extension vào Trình duyệt

#### Trên Google Chrome:
1. Mở Chrome và truy cập: `chrome://extensions/`
2. Bật công tắc **"Developer mode"** (Chế độ dành cho nhà phát triển) ở góc trên bên phải.
3. Bấm **"Load unpacked"** (Tải tiện ích đã giải nén).
4. Chọn thư mục: `packages/extension/dist/chrome`.

#### Trên Mozilla Firefox:
1. Mở Firefox và truy cập: `about:debugging#/runtime/this-firefox`
2. Bấm nút **"Load Temporary Add-on..."** (Tải phần bổ trợ tạm thời...).
3. Chọn tệp `manifest.json` trong thư mục: `packages/extension/dist/firefox/manifest.json`.

---

## 🧪 Chạy Kiểm thử & Đánh giá (Testing & Benchmarking)

```bash
# 1. Chạy toàn bộ Unit & Integration tests (Vitest)
npm run test

# 2. Chạy kiểm chứng khả năng thu âm P0 (Feasibility Spike)
npm run test:spike -w @vietdub/tests

# 3. Chạy Playwright E2E tests trên Chrome và Firefox thật
npm run test:e2e -w @vietdub/tests

# 4. Chạy bộ Benchmark 30 mẫu dịch & đo đạc độ trễ
npm run benchmark
```

---

## 📊 Báo cáo Kỹ thuật Tham khảo

- [Kiến trúc hệ thống](docs/ARCHITECTURE.md)
- [Báo cáo Feasibility Spike P0](docs/FEASIBILITY_REPORT.md)
- [Ma trận tương thích trình duyệt](docs/BROWSER_COMPATIBILITY.md)
- [Báo cáo đo lường độ trễ](docs/LATENCY_REPORT.md)
- [Báo cáo đánh giá chất lượng dịch (30 mẫu)](docs/TRANSLATION_BENCHMARK.md)
- [Dự toán chi phí vận hành](docs/COST_REPORT.md)
- [Báo cáo bảo mật & quyền riêng tư](docs/SECURITY_REPORT.md)
- [Báo cáo tổng hợp kiểm thử](docs/TEST_REPORT.md)
- [Các giới hạn đã biết](docs/KNOWN_LIMITATIONS.md)

---

## 🔒 Bản quyền & Giấy phép
Dự án VietDub AI được phát triển tuân thủ các quy chuẩn kỹ thuật của Chrome Web Store và Mozilla Add-ons.
