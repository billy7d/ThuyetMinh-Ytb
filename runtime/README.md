# Worker inference local của VietDub

Thư mục này chứa worker Python cho ba contract JSONL của backend. Worker chạy
offline, không tự tải model và không fallback cloud. Model/codec, venv, pip,
Hugging Face, Torch cache và TEMP đặt ngoài checkout tại `E:\VietDub-AI`.

## Cài model đã được xác nhận

Từ root repository, build backend rồi gọi script bằng cờ xác nhận rõ ràng:

```powershell
npm run build -w @vietdub/backend
node runtime/install_models.mjs --confirm-model-selection --install-root E:\VietDub-AI
```

Script chỉ chấp nhận revision/license/kích thước đã pin trong
`models/manifest.example.json`, cộng revision codec được ghi trong dependency
của TTS. Script kiểm tra LFS SHA-256 hoặc Git blob ID qua HTTPS allow-list, luôn
tính SHA-256 local và chỉ ghi `models/manifest.json` sau khi đủ toàn bộ artifact.
Không commit manifest local, model weights, cache hoặc venv.

## Python runtime

Dùng Python 3.11 x64; tạo venv và đặt pip/TEMP/Hugging Face/Torch cache dưới
`E:\VietDub-AI` trước khi cài. Bộ lock nằm tại `runtime/requirements-lock.txt`.
PyTorch CPU wheel được cài riêng từ index CPU chính thức; các phiên bản còn lại
cài theo lock, không cài dependency tự do hay package CUDA.

`pip check` của SDK `vieneu==3.8.3` có thể báo các package metadata không cài:
Gradio (UI), librosa/soundfile/soxr (đọc/resample audio file),
`kaldi-native-fbank` (speaker encoder cho voice cloning). Worker VietDub chỉ
dùng preset voice đã có speaker embedding/reference codes, nhận văn bản, chạy
ONNX CPU và tự đóng WAV bằng thư viện chuẩn; do đó các dependency đó không nằm
trên đường preset inference. Nếu sau này thêm UI hoặc voice cloning, phải cài
và kiểm tra riêng các dependency tương ứng. Cảnh báo `pip check` không được
đổi thành PASS giả.

## Đường dẫn cài đặt trên máy VietDub

- Venv: `E:\VietDub-AI\runtime\venv`
- Manifest/model root: `E:\VietDub-AI\models`
- Worker source: `E:\ThuyetMinh-Ytb\runtime\workers\vietdub_worker.py`
- Model STT: `E:\VietDub-AI\models\stt\faster-whisper-base.en`
- Model dịch: `E:\VietDub-AI\models\translation\opus-mt-en-vi`
- TTS: `E:\VietDub-AI\models\tts\vieneu-v3-turbo`
- Codec: `E:\VietDub-AI\models\tts\vieneu-v3-turbo\codec`

Khởi chạy backend bằng `runtime/start_backend.ps1` sau khi build. Launcher chỉ
đặt TEMP/TMP/cache trong process hiện tại; Windows `TEMP/TMP` toàn hệ thống
không bị thay đổi. Cần launcher vì `dotenv` mặc định không ghi đè `TEMP/TMP`
đã được Windows cấp sẵn.

Smoke model/pipeline local, không dùng mock:

```powershell
node runtime/smoke_local_pipeline.mjs
```

Harness ghi rõ đầu vào tiếng Anh cho STT được tạo bởi model VieNeu đã chọn,
không phải bản ghi người thật. Bằng chứng/audio được ghi vào thư mục
`E:\VietDub-AI\evidence` và không commit.

Backend manifest phải giữ fail-closed: chỉ khởi tạo provider khi tất cả tệp có
đúng byte size, SHA-256, revision và quyền license đã xác minh. Worker ghi
JSONL response ra stdout; diagnostic chỉ ở stderr và không chứa transcript,
audio, token hoặc API key.

## Giới hạn bằng chứng

Model/manifest đã cài không đồng nghĩa worker inference hay browser acceptance
đã PASS. Kiểm thử từng worker bằng model thật, sau đó pipeline và browser; ghi
riêng trạng thái model load, real inference, latency và các gate chưa chạy.
