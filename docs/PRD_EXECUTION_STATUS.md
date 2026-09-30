# PRD Execution Status — VietDub Local AI

Ngày cập nhật: 2026-09-24

STATUS: IN PROGRESS — PINNED MODELS INSTALLED; REAL WORKER AND LOCAL GATEWAY TESTS PASS; BROWSER ACCEPTANCE AND SOAK PENDING
SOURCE_BRANCH: main
SOURCE_BASE_SHA: 116d6dda2dbf226b87fe300fd8a9881e64abf223
WORKTREE: DIRTY — local implementation and documentation changes are uncommitted
COMMIT / PUSH / NEW_PR / MERGE: NOT_RUN

## Audit máy đích

- Registry đọc được: `ProductName=Windows 10 Pro`, `DisplayVersion=25H2`,
  `CurrentBuild=26200`, x64 environment. Nhãn Windows và build/DisplayVersion
  không khớp rõ ràng; giữ dữ liệu thô, không suy diễn. WMI/CIM bị từ chối trong
  sandbox ở lượt audit này.
- CPU Intel Core i5-9400F, 6C/6T, 2.90 GHz; NVIDIA GTX 1660 SUPER 6 GiB,
  driver 591.86. RAM vật lý đọc được 17,122,738,176 bytes (~16 GiB).
- Ổ C: còn 13,459,668,992 bytes (~12.54 GiB), ổ E: còn 336,242,540,544 bytes
  (~313.2 GiB). Runtime, model, cache, profile browser và evidence đặt trên E:.
- Node 24.18.0, npm 11.16.0, Python 3.11.9, FFmpeg build 2026-06-15. Chrome
  file version 153.0.8010.54; lệnh mở Chrome để đọc version bị profile
  ProcessSingleton/ACL chặn. Không tìm thấy Firefox ở các vị trí chuẩn đã dò.
- Python 3.11.9 tại `E:\DevTools\Python311`, Node 24.18.0 tại `D:\nodeJS`,
  FFmpeg tại `D:\ffmpeg-essentials_build`. Chrome stable file version
  153.0.8010.54 đã mở với profile acceptance riêng; chưa nạp extension. Firefox
  chưa cài và chưa có xác nhận cài.
- Inference chọn CPU 6 threads; không dùng GTX 1660 SUPER. VieNeu chạy ONNX
  fp32 vì i5-9400F không có VNNI. `pip check` còn cảnh báo các gói UI/voice
  cloning tùy chọn không thuộc preset inference.

## Triển khai hiện tại

AI_DEFAULT_MODE: local/offline; cloud fallback: DISABLED; no paid API
P0_SOURCE: PRESERVED — không sửa luồng capture/browser P0; sửa adapter STT và
  tạo adapter state riêng cho mỗi pipeline session
STT_WORKER: PASS — faster-whisper base.en CPU JSONL; synthetic speech input
TRANSLATION_WORKER: PASS — OPUS-MT en→vi CPU JSONL; 30/30 benchmark samples
VIETNAMESE_TTS_WORKER: PASS — VieNeu v3 Turbo ONNX fp32 + OpenMOSS codec JSONL;
  20/20 benchmark outputs hợp lệ
MODEL_REVISIONS: PASS — đúng revisions pin trong `runtime/MODEL_SELECTION.md`
MODEL_LICENSE_REVIEW: PASS — MIT/Apache-2.0 metadata trong manifest local
MODEL_DOWNLOAD: PASS — 25 artifacts, 1,005,369,274 bytes, đặt tại
  `E:\VietDub-AI\models`, ngoài repository
LOCAL_SHA256 / UPSTREAM_DIGESTS: PASS — local size/hash và upstream identity đã
  xác minh; backend model manager báo cả ba component `ready`
PYTHON_DEPENDENCIES: PASS_WITH_OPTIONAL_WARNING — preset inference import và
  chạy thật; `pip check` chỉ cảnh báo extras VieNeu UI/audio-cloning bị bỏ qua
BACKEND_HEALTH: PASS — HTTP 200, mode local, workers STT/translation/TTS ready
LOCAL_GATEWAY: PASS_REAL_MODELS_SYNTHETIC_AUDIO — 2 phiên WebSocket liên tiếp;
  phụ đề tiếng Việt, WAV mono PCM16 48 kHz, zero cost

## Acceptance chưa đạt

P0_ACCEPTANCE: PENDING_OPERATOR — Chrome extension chưa được nạp trong profile
  thử nghiệm, nên chưa chạy action popup/tabCapture trên trang video thật
STT_3_SAMPLE: PASS — 3/3 synthetic VieNeu English speech samples; đây không phải
  bản ghi người thật hoặc 3 video YouTube
TRANSLATION_30_SAMPLE: PASS — 30/30 Vietnamese outputs; p50 169 ms, p95 204 ms
TTS_20_SAMPLE: PASS — 20/20 WAV outputs; p50 1,375 ms, p95 1,620 ms
STT_RTF: PASS — 3 synthetic samples; p50 0.1319, p95 0.1333
GATEWAY_LATENCY: 2 observed samples; STT 1,087–1,107 ms, translation 127 ms,
  TTS 1,015–1,168 ms, pipeline total 1,144–1,299 ms
CHROME_EXTENSION_E2E: PENDING_OPERATOR — profile acceptance đã chờ 30 phút nhưng
  extension chưa được nạp; Chrome đã đóng khi hết thời gian. Evidence:
  `E:\VietDub-AI\evidence\chrome-acceptance-1790256455236.json`. Cần bật
  Developer mode/Load unpacked từ `packages/extension/dist/chrome`, sau đó click
  extension thật và bấm Bắt đầu để cấp tabCapture
FIREFOX_EXTENSION_E2E: NOT_RUN — chưa cài Firefox; cài đặt cần xác nhận riêng
SUBTITLE_VISIBLE / VIETNAMESE_AUDIO_AUDIBLE: NOT_VERIFIED IN BROWSER
30_MINUTE_SOAK: NOT_RUN
CONTEXT_TRANSLATION: NOT_IMPLEMENTED BY CURRENT OPUS-MT WORKER — provider context/terminology fields are not passed to the model
MERGE_READY: NO

TEST_RESULTS: typecheck PASS; build + Chrome/Firefox validators PASS; npm test
16 files/58 tests PASS (unit/integration suite includes fixtures); independent
real model benchmarks and local WebSocket pipeline PASS only for synthetic audio.
`pip check` WARNING for optional VieNeu extras. Browser E2E, live human speech and
30-minute soak remain NOT_RUN.
NODE_DEPENDENCY_AUDIT: BLOCKED — npm registry advisory endpoint/cache ACL error;
not a vulnerability result.

Model and worker evidence is stored outside Git under `E:\VietDub-AI\evidence`.
See [`TEST_REPORT.md`](TEST_REPORT.md) for exact benchmark/smoke boundaries. Do
not promote synthetic audio, fixture tests or an unloaded browser profile to
human-audio/browser acceptance.
