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

5. **Trạng thái kiểm chứng:**
   - Chrome/Firefox artifacts đã build được; browser acceptance production vẫn cần chạy trên cả hai trình duyệt.
   - Các số liệu latency/quality cũ từ fixture đã bị loại khỏi evidence; chưa báo cáo p50/p95 live.
   - Xem [TEST_REPORT.md](docs/TEST_REPORT.md), [BROWSER_ACCEPTANCE_CHECKLIST.md](docs/BROWSER_ACCEPTANCE_CHECKLIST.md) và [PROVIDER_SETUP.md](docs/PROVIDER_SETUP.md) trước khi nghiệm thu.

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

## 🚀 Hướng dẫn Cài đặt & Chuẩn bị Môi trường

### 1. Yêu cầu Hệ thống
- **Node.js:** Phiên bản >= 20.x (Khuyến nghị Node.js v24 LTS).
- **Trình duyệt:** Google Chrome (>= 116+) hoặc Mozilla Firefox (>= 109+).

### 2. Cài đặt Phụ thuộc & Biên dịch Dự án
Mở Terminal tại thư mục dự án và chạy:

```bash
# Cài đặt tất cả dependencies
npm install

# Biên dịch toàn bộ các packages
npm run build
```

Sau khi hoàn tất:
- Thư mục nạp Chrome: `packages/extension/dist/chrome`
- Thư mục nạp Firefox: `packages/extension/dist/firefox`

---

## 📖 Hướng dẫn Khởi chạy & Sử dụng Chi tiết trên Trình duyệt

### BƯỚC 1: Khởi động Realtime AI Backend

Trước khi bật extension trên trình duyệt, khởi động server WebSocket xử lý AI:

```bash
npm run start:backend
```
> Khi Terminal xuất hiện thông báo:
> `[VietDub Backend] WebSocket AI Gateway listening on port 8080`
> tức là Backend đã sẵn sàng nhận luồng âm thanh.

---

### BƯỚC 2: Cài đặt (Nạp) Extension vào Trình duyệt

#### 🟢 Nạp vào Google Chrome:
1. Mở Chrome, truy cập vào đường dẫn:
   ```
   chrome://extensions/
   ```
2. Bật công tắc **"Developer mode"** (Chế độ dành cho nhà phát triển) ở góc trên bên phải màn hình.
3. Bấm vào nút **"Load unpacked"** (Tải tiện ích đã giải nén) ở góc trên bên trái.
4. Chọn thư mục:
   ```
   E:\ThuyetMinh-Ytb\packages\extension\dist\chrome
   ```
5. Tiện ích **VietDub AI** sẽ xuất hiện. Bạn bấm vào biểu tượng **"Mảnh ghép" (Extensions)** trên thanh công cụ và chọn **Ghim (Pin)** biểu tượng VietDub AI ra ngoài để thao tác thuận tiện.

#### 🟠 Nạp vào Mozilla Firefox:
1. Mở Firefox, truy cập vào đường dẫn:
   ```
   about:debugging#/runtime/this-firefox
   ```
2. Bấm vào nút **"Load Temporary Add-on..."** (Tải phần bổ trợ tạm thời...).
3. Điều hướng và chọn tệp `manifest.json` tại đường dẫn:
   ```
   E:\ThuyetMinh-Ytb\packages\extension\dist\firefox\manifest.json
   ```
4. Tiện ích **VietDub AI** sẽ được kích hoạt ngay lập tức trên Firefox.

---

### BƯỚC 3: Hướng dẫn Sử dụng Khi Xem Video

```
  ┌──────────────────────────────────────────────┐
  │                 VietDub AI                   │
  │ Thuyết minh tiếng Việt       [Đang thuyết minh]│
  ├──────────────────────────────────────────────┤
  │ Chế độ hoạt động:                            │
  │  (•) Thuyết minh + phụ đề                    │
  │  ( ) Chỉ thuyết minh                         │
  │  ( ) Chỉ phụ đề                              │
  ├──────────────────────────────────────────────┤
  │ Bộ trộn âm thanh:                            │
  │  Âm thanh video gốc:     [====|--------] 25% │
  │  [ ] Tắt hoàn toàn âm thanh gốc              │
  │  Âm lượng thuyết minh:   [=============] 100%│
  ├──────────────────────────────────────────────┤
  │ [          DỪNG THUYẾT MINH (STOP)         ] │
  └──────────────────────────────────────────────┘
```

1. **Mở Video tiếng Anh cần xem:**
   - Mở bất kỳ trang web chứa video (YouTube, TED, BBC, Coursera, video khóa học, tài liệu...).
   - Bấm nút Play trên video.

2. **Mở giao diện VietDub AI:**
   - Nhấp vào biểu tượng **VietDub AI** trên thanh công cụ trình duyệt.
   - Popup sẽ tự động quét và nhận diện phần tử video đang phát trên tab hiện tại.

3. **Chọn Chế độ Hoạt động:**
   - **Thuyết minh + phụ đề** *(Khuyến nghị / Mặc định)*: Vừa nghe giọng đọc AI vừa xem phụ đề tiếng Việt đồng bộ ở chân video.
   - **Chỉ thuyết minh**: Tắt phụ đề, tập trung nghe giọng đọc tiếng Việt.
   - **Chỉ phụ đề**: Xem phụ đề tiếng Việt dịch theo ngữ cảnh, không phát giọng đọc.

4. **Tùy chỉnh Bộ Trộn Âm Thanh Độc Lập:**
   - **Âm thanh video gốc:** Kéo thanh trượt về mức mong muốn (ví dụ 15% – 25% để nghe thoang thoảng tiếng gốc và nhạc nền).
   - **Tắt hoàn toàn âm thanh gốc:** Tích vào ô này nếu muốn tắt hẳn 100% tiếng video gốc và chỉ nghe tiếng thuyết minh. *(Lưu ý: Tín hiệu âm thanh đưa vào AI vẫn được bảo toàn nguyên vẹn 100%)*.
   - **Âm lượng thuyết minh:** Điều chỉnh độ to/nhỏ của giọng đọc AI (0% – 100%).

5. **Kích hoạt Thuyết minh:**
   - Nhấp nút **"Bắt đầu thuyết minh"** (màu xanh).
   - Trạng thái chuyển sang **"Đang thuyết minh"**.
   - Bạn có thể **đóng popup** lại để thưởng thức video, phiên thuyết minh vẫn sẽ chạy liên tục trên trang.

6. **Các Tình Huống Tương Tác Trong Lúc Xem:**
   - **Tạm dừng (Pause):** Giọng đọc thuyết minh lập tức dừng lại cùng khung hình.
   - **Phát tiếp (Resume):** Thuyết minh tự động tiếp tục chuẩn xác theo thời gian video.
   - **Tua video (Seek):** Khi bạn tua tiến hoặc tua lùi, hệ thống lập tức hủy bỏ (cancel) toàn bộ các câu thuyết minh cũ trong hàng đợi và chỉ thuyết minh từ vị trí thời gian mới, không bị phát trễ hay đọc đè.
   - **Toàn màn hình (Fullscreen):** Phụ đề tự động điều chỉnh hiển thị nổi trên toàn màn hình.
   - **Dừng lại (Stop):** Mở popup và bấm nút đỏ **"Dừng thuyết minh"**, toàn bộ âm thanh gốc của video sẽ được phục hồi nguyên vẹn ngay lập tức.

---

### ⚠️ Xử lý Sự cố Thường gặp (Troubleshooting)

| Tình huống | Nguyên nhân | Hướng xử lý |
| :--- | :--- | :--- |
| **Báo lỗi "Không tìm thấy video trong tab hiện tại"** | Trang web chưa tải xong video hoặc video nằm sâu trong iframe cross-origin. | Tải lại trang video hoặc bấm Play video trước khi mở popup extension. |
| **Báo lỗi "Không thể kết nối đến máy chủ WebSocket"** | Backend chưa được khởi động tại cổng 8080. | Mở Terminal và chạy lệnh `npm run start:backend`. |
| **Không nghe thấy tiếng thuyết minh tiếng Việt** | Âm lượng thuyết minh đang để ở mức 0% hoặc đang chọn chế độ "Chỉ phụ đề". | Mở popup, chuyển sang chế độ "Thuyết minh + phụ đề" và tăng thanh trượt "Âm lượng thuyết minh" lên 100%. |
| **Video có bản quyền DRM (Netflix, Spotify)** | DRM mã hóa luồng âm thanh ở tầng phần cứng bảo vệ. | Hệ thống tuân thủ chính sách bản quyền DRM, không thể thu âm các trang web có DRM. |

---

## 🧪 Chạy Kiểm thử & Đánh giá (Testing & Benchmarking)

```bash
# 1. Chạy toàn bộ Unit & Integration tests (Vitest)
npm run test -w @vietdub/tests

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
