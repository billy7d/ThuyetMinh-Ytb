# VietDub AI — Real-time Vietnamese Dubbing Extension

> **Tiện ích mở rộng trình duyệt (Google Chrome & Mozilla Firefox) cho pipeline thuyết minh tiếng Việt và phụ đề video tiếng Anh theo thời gian thực.**

> **VietDub Local AI — model local đã cài trên target; browser acceptance còn chờ thao tác operator.** Ba worker JSONL STT/dịch en→vi/TTS đã chạy inference CPU và gateway smoke bằng tiếng Anh do VieNeu tổng hợp; chưa nghiệm thu giọng người/video thật trên Chrome/Firefox. Model/cache/evidence ở `E:\VietDub-AI`, ngoài repo. Mặc định không gọi cloud, không fallback. Xem [hướng dẫn máy đích](docs/TARGET_MACHINE_SETUP.md), [runtime](docs/LOCAL_RUNTIME.md) và [trạng thái PRD](docs/PRD_EXECUTION_STATUS.md).

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
   - **Translation local:** Worker dịch `en → vi` offline bằng OPUS-MT. Hiện worker chỉ đưa `sourceText` vào model; context/terminology chưa được áp dụng hoặc nghiệm thu.
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

## 🚀 Bắt đầu nhanh (4 bước)

Tóm tắt: **build → bật backend → nạp extension → bấm Play rồi bấm Bắt đầu.** Làm lần lượt từng bước bên dưới.

### Bước 0 — Chuẩn bị (làm một lần)

| Cần có | Ghi chú |
| :--- | :--- |
| **Node.js 20 trở lên** | Kiểm tra bằng `node --version`. |
| **Chrome** hoặc **Firefox** | Dùng bản mới. Có thể cài cả hai. |
| **Model AI chạy trên máy** (STT, dịch, giọng đọc) | Cài theo [LOCAL_RUNTIME.md](docs/LOCAL_RUNTIME.md) và [TARGET_MACHINE_SETUP.md](docs/TARGET_MACHINE_SETUP.md). Model nằm ngoài repo (trên máy này là `E:\VietDub-AI`). Chưa cài thì backend sẽ báo lỗi 503 và extension không chạy được. |

### Bước 1 — Build extension (làm một lần, và làm lại mỗi khi sửa code)

Mở Terminal tại thư mục dự án:

```bash
npm ci
npm run build
```

Build xong sẽ có hai thư mục, mỗi trình duyệt dùng một thư mục riêng:

| Trình duyệt | Thư mục / tệp cần chọn khi nạp |
| :--- | :--- |
| Chrome | thư mục `packages/extension/dist/chrome` |
| Firefox | tệp `packages/extension/dist/firefox/manifest.json` |

### Bước 2 — Bật backend (luôn phải chạy khi dùng extension)

Backend là chương trình chạy trên máy bạn, xử lý nhận dạng giọng nói, dịch và đọc tiếng Việt. **Không bật backend thì extension không làm được gì.**

```bash
# Lần đầu: tạo file cấu hình từ mẫu rồi điền đường dẫn model/worker
cp .env.example .env

# Windows (nên dùng, đã đặt sẵn thư mục cache trên ổ E):
powershell -ExecutionPolicy Bypass -File runtime/start_backend.ps1

# Hoặc dùng lệnh chung:
npm run start:backend
```

Kiểm tra backend đã sẵn sàng bằng cách mở địa chỉ này (hoặc chạy `curl`):

```
http://127.0.0.1:8080/health
```

- **Thấy `HTTP 200`** và ba worker `ready` → sẵn sàng, qua bước 3.
- **Thấy `503`** → model hoặc worker chưa cài đúng. Xem [LOCAL_RUNTIME.md](docs/LOCAL_RUNTIME.md).
- Dòng "listening on port 8080" trong Terminal **chưa đủ** để kết luận backend sẵn sàng; hãy nhìn `/health`.
- **Để cửa sổ Terminal này mở** trong lúc xem video. Muốn tắt backend thì bấm `Ctrl+C`.

### Bước 3 — Nạp extension vào trình duyệt

#### 🟢 Chrome

1. Gõ `chrome://extensions` vào thanh địa chỉ rồi Enter.
2. Bật công tắc **Developer mode** (Chế độ dành cho nhà phát triển) ở góc trên bên phải.
3. Bấm **Load unpacked** (Tải tiện ích đã giải nén).
4. Chọn **thư mục** `packages/extension/dist/chrome` (chọn cả thư mục, không chọn từng tệp).
5. Bấm biểu tượng mảnh ghép 🧩 trên thanh công cụ và **ghim** VietDub AI ra ngoài để dễ bấm.

> Chrome nhớ extension này sau khi tắt mở lại, bạn chỉ nạp một lần. Sau khi **build lại**, vào `chrome://extensions` và bấm nút ⟳ trên thẻ VietDub AI.

#### 🟠 Firefox — cài cố định (nên dùng)

Firefox bản thường chỉ giữ lại sau khi tắt mở những tiện ích **đã được Mozilla ký**. Ký miễn phí, tự động, ở kênh *unlisted*: tiện ích **không** hiện công khai trên
addons.mozilla.org (AMO), chỉ bạn có tệp `.xpi`. Mã của bản build được gửi lên AMO để kiểm tra tự động.

**Lần đầu (một lần):**

1. Đăng nhập (hoặc tạo tài khoản Firefox) ở <https://addons.mozilla.org/developers/>, chấp nhận thỏa thuận nhà phát triển.
2. Mở <https://addons.mozilla.org/developers/addon/api/key/>, bấm **Generate new credentials**.
3. Thêm hai dòng vào tệp `.env` ở gốc repo (tệp này không được commit; đừng chia sẻ secret):

   ```
   WEB_EXT_API_KEY=<JWT issuer, dạng user:12345:678>
   WEB_EXT_API_SECRET=<JWT secret>
   ```

**Ký và cài:**

```bash
npm run sign:firefox
```

Lệnh này build bản Firefox, kiểm tra bằng bộ kiểm tra của AMO, gửi đi ký (thường vài phút) rồi lưu tệp đã ký vào
`packages/extension/dist/firefox-signed/vietdub-ai-firefox.xpi`. Sau đó trong Firefox: `about:addons` → biểu tượng bánh răng ⚙ →
**Install Add-on From File...** → chọn tệp `.xpi` trên → **Add**. Nếu đang có bản tạm thời ở `about:debugging`, bấm **Remove** bản đó trước.

> **Cập nhật sau khi sửa code:** chạy lại `npm run sign:firefox` rồi cài tệp `.xpi` mới theo cách trên. Mỗi lần ký tự đóng dấu một số phiên bản mới
> (theo ngày giờ) nên Firefox cập nhật đè lên bản cũ, giữ nguyên cài đặt. Muốn kiểm tra trước mà không gửi gì đi: `npm run lint:firefox`.

#### 🟠 Firefox — nạp tạm thời (khi đang sửa code)

1. Gõ `about:debugging#/runtime/this-firefox` vào thanh địa chỉ rồi Enter.
2. Bấm **Load Temporary Add-on...** (Tải phần bổ trợ tạm thời).
3. Chọn **tệp** `packages/extension/dist/firefox/manifest.json`.
4. Thấy VietDub AI xuất hiện trong danh sách là xong.

> ⚠️ **Firefox chỉ giữ add-on tạm thời cho đến khi bạn đóng Firefox.** Mỗi lần mở lại Firefox, bạn phải làm lại bước 1–3 ở trên. Sau khi build lại, bấm **Reload** trên thẻ VietDub AI trong trang `about:debugging`.

### Bước 4 — Dùng trên một video

1. Mở trang có video tiếng Anh (YouTube, TED, khóa học...). Nếu bạn vừa nạp hoặc reload extension, **nhấn F5 để tải lại trang**.
2. **Bấm Play trên video trước.** Đây là bước dễ quên nhất: Firefox (và đôi khi Chrome) chỉ cho extension phát âm thanh sau khi bạn đã bấm vào trang.
3. Bấm biểu tượng **VietDub AI** trên thanh công cụ (đừng mở popup thành một tab riêng, như vậy sẽ không có quyền truy cập trang).
4. Chọn chế độ (mặc định *Thuyết minh + phụ đề*) rồi bấm **Bắt đầu thuyết minh**.
5. Đợi vài giây cho tới khi trạng thái là **Đang thuyết minh**. Bạn có thể đóng popup, phiên vẫn chạy.
6. Muốn dừng: mở popup, bấm nút đỏ **Dừng thuyết minh**. Âm thanh gốc của video được trả lại như cũ.

> **YouTube có phụ đề tiếng Anh (Firefox):** extension tự lấy phụ đề đó, dịch và đọc trước khoảng 45 giây, rồi phát giọng Việt
> **đúng lúc câu gốc bắt đầu** (không phải chờ nghe hết câu như bình thường). Không cần bật CC; extension tự trả nút CC về như cũ.
> Ưu tiên phụ đề do người làm. Video chỉ có phụ đề tự động thì backend thêm dấu câu bằng một mô hình nhỏ rồi mới tách câu
> (cần `--punct-model-path` trong worker dịch, xem `.env.example`; thiếu thì dùng nhận dạng giọng nói như cũ). Câu đang nói dở lúc bấm
> Bắt đầu không kịp đọc; các câu sau đúng mốc. Video không có phụ đề vẫn nhận dạng giọng nói như trước.
> Nếu lúc bấm Bắt đầu đang chạy quảng cáo, extension thuyết minh bằng nhận dạng giọng nói trước rồi tự chuyển khi lấy được phụ đề.
> Chrome chưa có chế độ này.

### Gặp lỗi? Tra nhanh ở đây

| Bạn thấy | Nguyên nhân | Cách xử lý |
| :--- | :--- | :--- |
| Popup báo không kết nối được máy chủ / mãi ở "Đang kết nối" | Backend chưa chạy hoặc đang nạp model | Làm Bước 2, đợi `/health` trả `HTTP 200`, rồi bấm lại Bắt đầu. |
| "Trình duyệt đang chặn âm thanh" | Chưa bấm vào trang | Bấm Play trên video (hoặc bấm vào trang), rồi bấm Bắt đầu lại. |
| "Không tìm thấy video trong tab" | Video chưa tải xong hoặc nằm trong iframe khác nguồn | F5 tải lại trang, bấm Play, rồi mở popup. |
| Vừa build hoặc sửa code nhưng không thấy khác | Trình duyệt vẫn dùng bản cũ | Chrome: bấm ⟳ ở `chrome://extensions`. Firefox bản tạm thời: bấm Reload ở `about:debugging`; bản cài cố định: `npm run sign:firefox` rồi cài tệp `.xpi` mới. Rồi F5 trang video. |
| Đã khởi động lại backend nhưng popup vẫn lỗi | Phiên cũ đã mất kết nối | F5 trang video, bấm Play, rồi Bắt đầu lại. |
| Netflix, Spotify... không thu được âm thanh | Nội dung có DRM | Không hỗ trợ. |
| Không nghe tiếng Việt | Âm lượng thuyết minh 0% hoặc đang ở chế độ "Chỉ phụ đề" | Chuyển sang *Thuyết minh + phụ đề* và kéo âm lượng thuyết minh lên. |

---

## 📖 Chi tiết cách dùng trên Trình duyệt

### Giao diện và các chế độ

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
