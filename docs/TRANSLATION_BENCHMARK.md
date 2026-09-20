# Translation Benchmark Status

> **Phạm vi quan trọng:** Đây là benchmark offline dùng `MockSTT`/`TranslationEngine` rule-based và tiêu chí chấm điểm tự động, không phải đánh giá human hoặc AI production. Điểm số không đóng browser/runtime release gate; xem [P0 Review Fix Report](audit/P0_REVIEW_FIX_REPORT.md).

**Quy mô kiểm thử:** 30 đoạn mẫu tiếng Anh chuẩn hóa theo PRD Mục 10.4  
**Phạm vi bao phủ:** 8 lĩnh vực (Hội thoại, Khoa học, Tin tức, Công nghệ, Tài chính, Tốc độ nói nhanh, Giọng vùng miền, Môi trường ồn)  
**Tiêu chí chấm điểm:** Thang điểm 1 đến 5 (Mục tiêu PRD: Trung bình ≥ 4.0/5.0)  

Bộ dữ liệu benchmark 30 câu vẫn được giữ trong `packages/tests/src/benchmarks/benchmark-dataset.ts`, nhưng các điểm số cũ 4.6/5.0 không còn được coi là evidence production. Chúng được tạo bởi fixture/deterministic rules và không đo Gemini live.

## Trạng thái hiện tại

- Contract test cho Gemini kiểm tra request có transcript được đánh dấu là dữ liệu không đáng tin cậy, có context/terminology và chỉ nhận plain text output.
- Production gateway chỉ inject `GeminiTranslationProvider`; không có fallback hiển thị nguyên văn tiếng Anh như bản dịch tiếng Việt.
- Chưa có API key Gemini trong môi trường nên chưa chạy benchmark live và chưa có quality score được xác nhận.

## Điều kiện nghiệm thu

Chạy benchmark bằng Gemini model được cấu hình, lưu model/version, dataset revision, timestamp, raw metrics đã loại secret và đánh giá thủ công các câu có số liệu/tên riêng. Chỉ báo cáo score sau khi có evidence đó.
