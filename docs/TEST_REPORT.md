# Test Report — VietDub Local AI

Ngày cập nhật: 2026-09-24

## Kết quả trong working tree hiện tại

- `npm run typecheck`: PASS.
- `npm run build`: PASS; build artifact Chrome và Firefox, validator của cả hai
  PASS.
- `npm test`: PASS — 16 test files, 58 tests. Một số integration pipeline dùng
  fixture/mock; kết quả này xác minh contract/source, không thay inference thật.
- Worker thật dùng `faster-whisper 1.2.0`, `transformers 4.57.6`, `torch 2.8.0`,
  `onnxruntime 1.22.1`, `vieneu 3.8.3` và `sea-g2p 0.10.0`; ba model đã load
  local và đã chạy benchmark/inference.
- `python -m pip check`: WARN/NOT CLEAN — SDK VieNeu khai báo Gradio, librosa,
  soundfile, soxr và kaldi-native-fbank; lock preset-only không cài các gói
  không dùng cho luồng bundled-voice ONNX. Những đường UI/voice-cloning chưa
  được hỗ trợ/kiểm thử.
- Backend `/health`: HTTP 200; mode `local`, manifest và cả ba worker `ready`.
- `npm run benchmark`: command PASS với 30 fixture rows nhưng trạng thái
  `FIXTURE_ONLY_NOT_PRODUCTION_EVIDENCE`; STT latency là `null`.
- `npm audit --omit=dev`: BLOCKED trong lần thử hiện tại — bulk advisory request
  tới npm registry lỗi và npm không ghi được log vào cache do quyền thư mục.
  Đây không phải kết quả `0 vulnerabilities` và cũng không chứng minh có lỗ hổng.
- `git diff --check`: PASS. Manifest mẫu trong repo không chứa weights; manifest
  thực tế và file model nằm ngoài repo tại `E:\VietDub-AI`.

## Chưa chạy / không được gọi là PASS

- Model weights đã được tải theo consent; 25 artifact, 1,005,369,274 bytes.
  Local checksums/upstream identity đã xác minh; không có weights trong Git.
- Benchmark thật: translation 30/30, p50 169 ms/p95 204 ms; TTS 20/20 WAV,
  p50 1,375 ms/p95 1,620 ms; STT 3/3 synthetic speech, RTF p50 0.1319/p95
  0.1333. Nguồn STT do VieNeu local tổng hợp, không phải tiếng người.
- Hai gateway WebSocket run liên tiếp qua ba model thật đều tạo phụ đề tiếng
  Việt, WAV mono PCM16 48 kHz có tín hiệu và zero cost. Backend metric: STT
  1,087–1,107 ms, dịch 127 ms, TTS 1,015–1,168 ms, total 1,144–1,299 ms.
- Chrome stable 153.0.8010.54 đã mở profile acceptance riêng 30 phút tại
  `chrome://extensions`, nhưng extension chưa được nạp nên phiên đã timeout và
  Chrome hiện đã đóng. Evidence:
  `E:\VietDub-AI\evidence\chrome-acceptance-1790256455236.json`. Chrome popup,
  tabCapture, YouTube/HTML5, subtitle hiển thị, audio restoration và audibility
  chưa verify. Firefox chưa cài; không cài vì cần xác nhận riêng.
- Chưa thực hiện soak 30 phút hoặc browser acceptance với tiếng người/video thật.
- Chưa commit, push, tạo PR hoặc merge.

## Gate tiếp theo

Trong profile Chrome thử nghiệm trên E:, bật Developer mode và Load unpacked từ
`packages/extension/dist/chrome`; sau đó click biểu tượng VietDub thật và bấm
Bắt đầu để cấp `tabCapture`. Chạy kiểm thử extension trên trang video thật, xác
nhận subtitle/TTS/pause/seek/mode/stop/restore, rồi mới chạy soak 30 phút. Không
coi synthetic speech hay fixture/mock là bằng chứng human-audio/browser PASS.
Chưa commit, push, tạo PR hoặc merge cho tới khi các gate này có evidence.
