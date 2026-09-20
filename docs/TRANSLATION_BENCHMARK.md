# Translation Benchmark Status

Ngày cập nhật: 2026-09-20

Bộ dữ liệu benchmark 30 câu vẫn được giữ trong `packages/tests/src/benchmarks/benchmark-dataset.ts`, nhưng các điểm số cũ 4.6/5.0 không còn được coi là evidence production. Chúng được tạo bởi fixture/deterministic rules và không đo Gemini live.

## Trạng thái hiện tại

- Contract test cho Gemini kiểm tra request có transcript được đánh dấu là dữ liệu không đáng tin cậy, có context/terminology và chỉ nhận plain text output.
- Production gateway chỉ inject `GeminiTranslationProvider`; không có fallback hiển thị nguyên văn tiếng Anh như bản dịch tiếng Việt.
- Chưa có API key Gemini trong môi trường nên chưa chạy benchmark live và chưa có quality score được xác nhận.

## Điều kiện nghiệm thu

Chạy benchmark bằng Gemini model được cấu hình, lưu model/version, dataset revision, timestamp, raw metrics đã loại secret và đánh giá thủ công các câu có số liệu/tên riêng. Chỉ báo cáo score sau khi có evidence đó.
