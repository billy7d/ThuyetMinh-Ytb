# Translation Benchmark Status

Ngày cập nhật: 2026-09-20

Bộ dữ liệu benchmark 30 câu vẫn được giữ trong `packages/tests/src/benchmarks/benchmark-dataset.ts`, nhưng các điểm số cũ 4.6/5.0 không còn được coi là evidence production. Chúng được tạo bởi fixture/deterministic rules và không đo Gemini live.

## Trạng thái hiện tại

- Contract test cho provider boundary kiểm tra transcript không được trở thành instruction, có context/terminology và chỉ nhận plain text output.
- Production gateway mặc định inject `LocalTranslationProvider`; không có fallback hiển thị nguyên văn tiếng Anh như bản dịch tiếng Việt.
- Chưa có local model/worker trong môi trường nên chưa chạy benchmark live và chưa có quality score được xác nhận.

## Điều kiện nghiệm thu

Chạy benchmark bằng model local đã pin trong manifest, lưu model/revision, dataset revision, timestamp, raw metrics đã loại dữ liệu nhạy cảm và đánh giá thủ công các câu có số liệu/tên riêng. Chỉ báo cáo score sau khi có evidence đó.
