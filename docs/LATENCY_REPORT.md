# Latency Report Status

Ngày cập nhật: 2026-09-20

Các số liệu p50/p90/p95 cũ (318/359/368 ms) đã được gỡ khỏi evidence vì chúng là số liệu mô phỏng/fixture, không phải live local STT + translation + Vietnamese TTS.

## Trạng thái hiện tại

- Pipeline đã phát event latency theo từng segment và có các guard chống trễ vô hạn, duplicate và stale generation.
- Event STT hiện dùng timestamp wall-clock tại boundary và ánh xạ bounded tới audio end gần nhất; đây là số đo chẩn đoán, chưa phải metric monotonic end-to-end đủ tin cậy để công bố.
- Chưa có p50/p95 live, chưa chạy soak 30 phút và chưa chứng minh ngưỡng 3 giây trên browser thật.

## Evidence cần bổ sung

Bổ sung timestamp monotonic tại provider boundary (audio send, STT final, local translation response, TTS response, audio play), chạy tối thiểu dataset PRD trên model local thật và lưu p50/p95 cùng điều kiện chạy. Không đổi trạng thái sang PASS trước khi có evidence Chrome và Firefox.
