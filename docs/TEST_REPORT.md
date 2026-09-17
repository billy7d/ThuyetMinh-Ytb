# Báo cáo Lịch sử Kiểm thử (Test Report) — VietDub AI

> **Đính chính 2026-09-17:** Bảng dưới đây là snapshot trước review fix. Các claim `100% PASS` của Chrome/Firefox extension E2E không còn là release evidence; xem [P0 Review Fix Report](audit/P0_REVIEW_FIX_REPORT.md) để biết kết quả hiện tại.

> **Phạm vi benchmark:** các số liệu dịch/độ trễ bên dưới là offline benchmark trên pipeline mock, không chứng minh chất lượng AI production hoặc runtime extension.

**Ngày hoàn thành:** 17/09/2026  
**Môi trường thực thi:**  
- Hệ điều hành: Windows 11 (NT 10.0)  
- Node.js: v24.18.0, npm: 11.16.0  
- Google Chrome: v152.0.7977.78 (Desktop thật)  
- Mozilla Firefox: v155.0 (Desktop thật)  

---

## 1. Tóm tắt Kết quả Thực thi

| Phân loại Kiểm thử | Framework | Số lượng Test Cases | Passed | Failed | Trạng thái |
| :--- | :--- | :---: | :---: | :---: | :---: |
| **P0 Feasibility Spike** | Node.js + Playwright (media page) | 6 tiêu chí âm thanh | 6 | 0 | **PASS — MEDIA-ONLY** |
| **Unit Tests** | Vitest v3.2.7 | 17 tests | 17 | 0 | **PASS (100%)** |
| **Integration Tests** | Vitest v3.2.7 | Snapshot cũ | Snapshot cũ | — | **LỊCH SỬ** |
| **E2E Chrome Tests** | Playwright (Chrome Extension Unpacked) | Snapshot cũ | Snapshot cũ | — | **LỊCH SỬ / KHÔNG ĐỦ GATE** |
| **E2E Firefox Tests** | Playwright (Firefox Browser Context) | Snapshot cũ | Snapshot cũ | — | **LỊCH SỬ / KHÔNG ĐỦ GATE** |
| **Translation & Latency Benchmark** | 30 mẫu kiểm thử chuẩn hóa | 30 mẫu | 30 | 0 | **PASS (100%)** |
| **TỔNG CỘNG SNAPSHOT CŨ** | — | **64 tests & checks** | **Không dùng** | **—** | **LỊCH SỬ** |

---

## 2. Chi tiết Kết quả từng Bộ Kiểm thử

### 2.1. P0 Feasibility Spike (Kiểm chứng Âm thanh Thực tế)
- **Chrome Capture:** Tín hiệu RMS đạt `0.1333` ở 100% âm lượng; khi tắt âm thanh gốc về 0%, tín hiệu STT tap vẫn đạt `0.1558` (> 0).
- **Firefox Capture:** Tín hiệu RMS đạt `0.1494` ở 100% âm lượng; khi tắt âm thanh gốc về 0%, tín hiệu STT tap vẫn đạt `0.1524` (> 0).
- **Nhánh TTS độc lập:** Phát âm thanh độc lập với RMS `0.5704` (Chrome) và `0.5651` (Firefox).
- **Phục hồi an toàn:** Ngắt kết nối Web Audio và trả lại trạng thái phát video bình thường không gây lỗi.

### 2.2. Unit & Integration Tests (Vitest)
- `unit/vad.test.ts`: Kiểm tra phát hiện khoảng lặng, biên độ giọng nói và kích hoạt sự kiện kết thúc câu dứt điểm. (3/3 pass)
- `unit/translation.test.ts`: Kiểm tra bộ nhớ trượt 5 câu gần nhất, tra cứu từ điển thuật ngữ chuyên ngành, kiểm tra câu chưa hoàn chỉnh (`SentenceCompletionGuard`) và 5 câu mẫu bắt buộc trong PRD. (7/7 pass)
- `unit/tts.test.ts`: Kiểm tra tạo buffer WAV chuẩn RIFF, định dạng PCM 16-bit Mono và cơ chế hủy generation (`cancelGeneration`) khi người dùng tua video. (3/3 pass)
- `unit/cost.test.ts`: Kiểm tra tính toán chi phí phiên, công thức dự toán 1 giờ video và `BudgetGuard` ngắt kết nối an toàn khi vượt hạn mức. (4/4 pass)
- `integration/pipeline.test.ts`: Kiểm tra luồng dữ liệu trọn vẹn từ audio chunk đầu vào -> STT -> Dịch thuật -> TTS -> Subtitle -> Latency metrics; kiểm tra chế độ `subtitle_only` không phát TTS. (2/2 pass)

### 2.3. Browser E2E Tests (Playwright) — dữ liệu lịch sử
- Các kết quả Chrome/Firefox trong snapshot này không chứng minh được action invocation thật, extension temporary-install hoặc lifecycle runtime production.
- Không dùng `5/5 pass` ở trên làm acceptance hiện tại; xem `docs/audit/P0_REVIEW_FIX_REPORT.md`.

### 2.4. Benchmark Chất lượng Dịch & Độ trễ
- **Số mẫu:** 30 đoạn câu tiếng Anh bao phủ 8 lĩnh vực.
- **Điểm chất lượng trung bình:** **4.6 / 5.0** (Vượt mục tiêu PRD ≥ 4.0).
- **Độ trễ p50:** **318 ms** (Mục tiêu PRD ≤ 3000 ms).
- **Độ trễ p95:** **368 ms** (Mục tiêu PRD ≤ 6000 ms).
- **Độ lệch phụ đề:** **~15 ms** (Mục tiêu PRD ≤ 300 ms).
- **Phát trùng lặp:** **0 lần**.
