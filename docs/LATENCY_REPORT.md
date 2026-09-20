# Latency Report Status

Ngày cập nhật: 2026-09-20

Các số liệu p50/p90/p95 cũ (318/359/368 ms) đã được gỡ khỏi evidence vì chúng là số liệu mô phỏng/fixture, không phải live Deepgram + Gemini + Google Cloud TTS.

## Trạng thái hiện tại

- Pipeline đã phát event latency theo từng segment và có các guard chống trễ vô hạn, duplicate và stale generation.
- STT latency chưa được báo cáo là số đo thật: provider result hiện chưa mang monotonic timestamp của audio frame cuối được gửi đi, nên metric STT được đặt 0 để tránh tạo số liệu giả.
- Chưa có p50/p95 live, chưa chạy soak 30 phút và chưa chứng minh ngưỡng 3 giây trên browser thật.

## Evidence cần bổ sung

Bổ sung timestamp monotonic tại provider boundary (audio send, STT final, Gemini response, TTS response, audio play), chạy tối thiểu dataset PRD trên provider thật và lưu p50/p95 cùng điều kiện chạy. Không đổi trạng thái sang PASS trước khi có evidence Chrome và Firefox.
