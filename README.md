# VietDub AI — Real-time Vietnamese Dubbing Extension

> **Tiện ích mở rộng trình duyệt (Google Chrome & Mozilla Firefox) cho pipeline thuyết minh tiếng Việt và phụ đề video tiếng Anh theo thời gian thực.**

> **VietDub Local AI Foundation — Source Integrated, Inference Setup Pending.** Source foundation đã được tích hợp để clone trực tiếp từ `main`; backend mặc định local/offline và fail-closed. Chưa có model weights hoặc inference workers thật trong repository, nên backend trả `503` khi chưa cấu hình và không fallback cloud. Xem [hướng dẫn bàn giao máy đích](docs/TARGET_MACHINE_SETUP.md) và [PRD execution status](docs/PRD_EXECUTION_STATUS.md).

VietDub AI cung cấp pipeline để xem trực tiếp video tiếng Anh trên trình duyệt (YouTube, tài liệu khoa học, tin tức, khóa học trực tuyến) với phụ đề đồng bộ và đường truyền audio thời gian thực, không cần tải video về máy hay tạo video mới.

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

4. **Pipeline AI cục bộ, không phí API:**
   - **Streaming STT local:** Worker chạy trên máy người dùng, có Voice Activity Detection (VAD) và bounded queue.
   - **Context-aware Translation local:** Worker dịch `en → vi` offline, duy trì bộ nhớ ngữ cảnh 5 câu gần nhất và đảm bảo tính nhất quán thuật ngữ trong phạm vi model.
   - **Vietnamese TTS local:** Worker phát audio WAV thật, kiểm tra metadata và hủy (`cancelGeneration`) khi người dùng tua video hoặc tạm dừng.

5. **Đo lường & Kiểm chứng Thực tế:**
   - Feasibility/media spike lịch sử đã chạy trên Google Chrome (152+) và Mozilla Firefox (155+); đây không phải bằng chứng runtime extension hiện tại.
   - Benchmark fixture 30 mẫu chỉ kiểm tra harness; không có số liệu latency/quality production cho đến khi operator chạy provider thật.
   - Ma trận runtime và các gate còn thiếu được cập nhật trong [P0 Review Fix Report](docs/audit/P0_REVIEW_FIX_REPORT.md).

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
- **Node.js:** Phiên bản >= 20.x (CI source integration dùng Node.js v24.18.0).
- **Trình duyệt:** Google Chrome hoặc Mozilla Firefox để nghiệm thu live; artifact build không cần model weights.
- **Local AI runtime:** cài ba worker STT/dịch/TTS tương thích JSONL và model weights đã được kiểm SHA-256 theo [LOCAL_RUNTIME.md](docs/LOCAL_RUNTIME.md). Không có worker/model thì backend giữ trạng thái `503`, không fallback sang cloud.
- Kiểm tra chi tiết CPU/GPU/RAM/disk, Python, browser và các bước clean-clone trong [TARGET_MACHINE_SETUP.md](docs/TARGET_MACHINE_SETUP.md).

### 2. Cài đặt Phụ thuộc & Biên dịch Dự án
Mở Terminal tại thư mục dự án và chạy:

```bash
# Cài đặt đúng dependency tree đã khóa
npm ci

# Biên dịch toàn bộ các packages
npm run build
```

Sau khi hoàn tất:
- Thư mục nạp Chrome: `packages/extension/dist/chrome`
- Thư mục nạp Firefox: `packages/extension/dist/firefox`

---

## 📖 Hướng dẫn Khởi chạy & Sử dụng Chi tiết trên Trình duyệt

### BƯỚC 1: Cài local models và khởi động Realtime AI Backend

Trước khi bật extension trên trình duyệt, khởi động server WebSocket xử lý AI:

```bash
# Tạo cấu hình local từ mẫu và điền đường dẫn worker/model manifest.
cp .env.example .env
# Xem giao thức worker, consent, checksum và setup Windows/macOS:
# docs/LOCAL_RUNTIME.md
npm run start:backend
```
> Backend chỉ báo ready sau khi `models/manifest.json` hợp lệ, cả ba model có checksum/license đã xác minh và cả ba worker local trả `{"event":"ready"}`. Không nhập API key cho chế độ mặc định.

Kiểm tra readiness:

```bash
curl http://127.0.0.1:8080/health
```

Khi Terminal xuất hiện thông báo:
> `[VietDub Backend] WebSocket AI Gateway listening on port 8080`
> tức là Backend đã sẵn sàng nhận luồng âm thanh **chỉ sau khi** manifest và cả ba worker local đã sẵn sàng. Khi chưa cài inference runtime, HTTP `503` là trạng thái fail-closed mong đợi.

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

> E2E runtime hiện ghi nhận rõ `BLOCKED` khi môi trường không cung cấp Chrome action invocation hoặc Firefox temporary-install runner; test không dùng mock để biến blocker thành `PASS`. Xem [P0 Review Fix Report](docs/audit/P0_REVIEW_FIX_REPORT.md).

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
- [Cấu hình provider production](docs/PROVIDER_SETUP.md)
- [Trạng thái thực thi PRD](docs/PRD_EXECUTION_STATUS.md)
- [Các giới hạn đã biết](docs/KNOWN_LIMITATIONS.md)

---

## 🔒 Bản quyền & Giấy phép
Dự án VietDub AI được phát triển tuân thủ các quy chuẩn kỹ thuật của Chrome Web Store và Mozilla Add-ons.
