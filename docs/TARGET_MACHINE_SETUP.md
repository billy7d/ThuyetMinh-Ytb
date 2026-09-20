# VietDub — Target Machine Setup and Acceptance

Tài liệu này dành cho máy đích sau khi source foundation đã được merge vào
`main`. Merge source không có nghĩa là VietDub đã có model weights, inference
workers hoặc đã đạt live browser acceptance. Không copy `node_modules`, virtual
environment, binary worker hay model weights từ máy phát triển; cài trực tiếp
trên máy đích.

## 1. Kiểm tra máy đích trước khi cài

Chỉ ghi nhận những gì lệnh kiểm tra thực tế trả về. Repository chưa có benchmark
đủ để công bố cấu hình CPU/GPU/RAM tối thiểu hoặc cam kết real-time.

### macOS / Linux

```bash
uname -a
uname -m
node --version
python3 --version
git --version
df -h .

# macOS
sysctl -n hw.memsize 2>/dev/null || true
system_profiler SPHardwareDataType 2>/dev/null || true

# Linux
free -h 2>/dev/null || true
lscpu 2>/dev/null || true

# Kiểm tra browser nếu đã cài
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --version 2>/dev/null || google-chrome --version 2>/dev/null || true
firefox --version 2>/dev/null || true
```

### Windows PowerShell

```powershell
Get-CimInstance Win32_OperatingSystem | Select-Object Caption, Version, OSArchitecture
Get-CimInstance Win32_ComputerSystem | Select-Object TotalPhysicalMemory
Get-CimInstance Win32_Processor | Select-Object Name, NumberOfCores, MaxClockSpeed
Get-PSDrive -Name C
node --version
py --version
git --version
& "$env:ProgramFiles\Google\Chrome\Application\chrome.exe" --version
& "$env:ProgramFiles\Mozilla Firefox\firefox.exe" --version
```

Source gate đã được kiểm tra với Node.js `>=20`. Python version, GPU backend,
RAM/disk profile và browser live support phải được xác nhận trên máy thực tế.

## 2. Clone đúng source từ `main`

```bash
git clone --branch main https://github.com/billy7d/ThuyetMinh-Ytb.git
cd ThuyetMinh-Ytb
git rev-parse HEAD
npm ci
npm run typecheck
npm run build
npm test
npm audit --omit=dev
git diff --check
```

`git rev-parse HEAD` phải khớp với `MAIN_SHA_AFTER` trong báo cáo handoff của
đợt merge. Không checkout lại nhánh PR sau khi `main` đã chứa source.

## 3. Kiểm tra backend model-free

```bash
cp .env.example .env
npm run start:backend
```

Ở terminal khác:

```bash
curl -i http://127.0.0.1:8080/health
```

Khi chưa có `models/manifest.json`, model files hoặc worker commands, HTTP `503`
với JSON an toàn là **mong đợi**. Backend không được crash loop, tạo transcript
giả, phát beep, hoặc gọi cloud. Mặc định phải giữ:

```env
AI_MODE=local
CLOUD_PROVIDERS_ENABLED=false
PAID_API_ALLOWED=false
MAX_EXTERNAL_API_COST_USD=0
```

## 4. Cài local inference runtime

Ba worker thật chưa được đóng gói trong source handoff:

| Thành phần | Trạng thái sau merge | Điều kiện để chuyển sang READY |
|---|---|---|
| STT | `NOT READY` | Worker JSONL thật, model đã pin/checksum/license, kiểm tra 3 video |
| Translation | `NOT READY` | Worker en→vi thật, revision/tokenizer đã pin, benchmark 30 mẫu |
| Vietnamese TTS | `NOT READY` | Worker phát WAV tiếng Việt thật, codec/voice terms đã xác minh |

Đọc [LOCAL_RUNTIME.md](LOCAL_RUNTIME.md) và [MODEL_LICENSE_REPORT.md](MODEL_LICENSE_REPORT.md)
trước khi tải bất kỳ artifact nào. Với mỗi model/code/tokenizer/codec/voice:

1. Kiểm tra upstream URL, immutable revision và quyền phân phối/thương mại.
2. Ghi byte size, SHA-256 và license vào `models/manifest.json`.
3. Có explicit consent trước khi tải.
4. Chạy worker bằng executable path tuyệt đối; không dùng shell interpolation.
5. Chỉ đổi các trường license từ `unknown` sang `verified` khi có bằng chứng.

Ví dụ cấu hình command:

```env
LOCAL_STT_WORKER_COMMAND=/absolute/path/to/vietdub-stt-worker
LOCAL_TRANSLATION_WORKER_COMMAND=/absolute/path/to/vietdub-translation-worker
LOCAL_TTS_WORKER_COMMAND=/absolute/path/to/vietdub-tts-worker
```

Không dùng fixture transcript, rule-based translation, beep hoặc synthetic sine
wave để tuyên bố inference production đã sẵn sàng.

## 5. Build và nạp extension

```bash
npm run build
```

- Chrome: mở `chrome://extensions/`, bật Developer mode, chọn **Load unpacked**
  và nạp `packages/extension/dist/chrome`.
- Firefox: mở `about:debugging#/runtime/this-firefox`, chọn **Load Temporary
  Add-on...** và nạp `packages/extension/dist/firefox/manifest.json`.

Artifact validator PASS chỉ chứng minh bundle/manifest có thể build. Nó không
thay thế live acceptance trên YouTube hoặc HTML5 video.

## 6. Acceptance bắt buộc sau khi worker đã sẵn sàng

Ghi log và phần cứng thực tế, không ghi transcript/audio nhạy cảm:

- STT thật trên ít nhất 3 video.
- Translation thật trên 30 mẫu và kiểm tra thuật ngữ/ngữ cảnh.
- TTS thật trên ít nhất 20 câu tiếng Việt.
- Cả Chrome và Firefox: 3 mode, subtitle visible, voice audible, pause/resume,
  seek cancellation, stop/audio restoration, navigation và tab close.
- YouTube và HTML5 video, cả cửa sổ thường và fullscreen.
- Đo latency p50/p95, TTS start latency, real-time factor, CPU/RAM và memory growth.
- Soak test 30 phút.

Chỉ khi các bước này có evidence thật mới được đổi:

```text
PRODUCTION_READY=YES
LOCAL_AI_ACCEPTANCE=PASS
TARGET_MACHINE_ACCEPTANCE=PASS
```

Nếu worker không theo kịp thời gian thực, giữ `REALTIME_ACCEPTANCE=BLOCKED`.

## 7. Troubleshooting

- `health` trả `503`: kiểm tra manifest, file path, SHA-256, license fields và
  cả ba worker có emit `{"event":"ready"}` hay chưa.
- `worker startup timeout`: chạy từng executable bằng tay, kiểm tra quyền thực
  thi, Python environment và model path; không tăng timeout để che lỗi khởi động.
- Không có tiếng: kiểm tra worker trả RIFF/WAVE thật, sample rate/channels và
  mode đang bật voice; không thay bằng beep.
- Không có phụ đề: kiểm tra translation worker trả `translatedText` và thử
  lại trên HTML5 trước khi kiểm tra YouTube.
- Browser E2E không chạy: xác nhận browser executable/Playwright runner của máy
  đích; ghi `BLOCKED`, không biến test bị skip thành PASS.

## 8. Handoff command

```bash
git clone --branch main https://github.com/billy7d/ThuyetMinh-Ytb.git
cd ThuyetMinh-Ytb
git rev-parse HEAD
npm ci
npm run build
```

Các bước model installation và live acceptance là công việc của giai đoạn máy
đích, không phải bằng chứng đã hoàn thành trong source merge.
