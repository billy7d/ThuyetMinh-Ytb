# Local runtime — VietDub zero-cost mode

`AI_MODE=local` is the default. The backend does not create, contact or fall back to Deepgram, Gemini or Google Cloud TTS in this mode. It starts a local worker only after the model manifest, checksums, license fields and worker commands are ready.

The repository includes three roles in `runtime/workers/vietdub_worker.py` and a pinned Python dependency set. It intentionally does not commit model weights or the target machine's `.venv`. The checked-in `models/manifest.example.json` is a template, not a ready manifest. On the current target, the user approved the pinned set and installed the verified operator manifest/models at `E:\VietDub-AI`; a fresh machine must obtain its own consent and verify its own files.

## Runtime contract

Configure one executable for each component:

```env
LOCAL_STT_WORKER_COMMAND=/absolute/path/to/vietdub-stt-worker
LOCAL_TRANSLATION_WORKER_COMMAND=/absolute/path/to/vietdub-translation-worker
LOCAL_TTS_WORKER_COMMAND=/absolute/path/to/vietdub-tts-worker
```

Optional arguments are JSON arrays, for example:

```env
LOCAL_STT_WORKER_ARGS=["--role","stt"]
```

Commands are passed to `child_process.spawn` with `shell:false`; transcript text, audio and browser URLs are never interpolated into a shell command.

Each worker is a long-lived JSON-lines process:

1. Load the pinned local model and emit `{"event":"ready"}` once.
2. Read request objects from stdin, each containing a unique `id`.
3. Reply with `{"id":"...","ok":true,"result":{...}}` or `{"id":"...","ok":false,"error":"..."}`.

STT requests:

```json
{"op":"start_stream","sessionId":"...","modelPath":"...","sampleRate":16000,"channels":1}
{"op":"audio_chunk","sessionId":"...","modelPath":"...","pcmBase64":"...","timestampMs":1234,"durationMs":250,"sampleRate":16000,"channels":1}
{"op":"end_stream","sessionId":"...","modelPath":"..."}
```

An `audio_chunk` result may contain ordered events:

```json
{"events":[{"kind":"interim","segmentId":"...","text":"...","startMs":1234,"endMs":1484,"confidence":0.91}]}
```

Use `kind:"final"` for an utterance that is ready for translation. The worker owns VAD/sliding-window assembly and must not emit text for silence. It must keep the model loaded instead of starting a process for every 250 ms chunk.

Translation request/result:

```json
{"op":"translate","modelPath":"...","sourceText":"...","startMs":0,"endMs":1200,"context":[],"terminology":{},"speakerTone":"natural"}
{"translatedText":"...","tokensUsed":42}
```

The current OPUS-MT worker only consumes `sourceText`; `context`, `terminology`
and `speakerTone` are accepted by the adapter but are not sent into the model.
Do not claim contextual translation or term consistency until that path is
implemented and measured.

TTS request/result:

```json
{"op":"synthesize","modelPath":"...","segmentId":"seg_1","generation":1,"text":"Xin chào.","startMs":0,"endMs":1200}
{"audioBase64":"<RIFF/WAVE base64>","mimeType":"audio/wav","sampleRate":48000,"channels":1,"durationMs":800}
```

Production TTS output must be real Vietnamese speech. Synthetic sine waves, beeps, fixture transcripts and rule-based translation are test-only and are prohibited in the configured production workers; the adapter validates the protocol and WAV metadata but cannot infer the acoustic provenance of an arbitrary worker output.

## Manifest and one-time setup

1. Read the upstream code, model, tokenizer, codec and voice terms for each selected revision. Confirm redistribution and commercial-use rights independently.
2. Show the user the source, revision, expected download size, checksum and license notice; obtain explicit consent before downloading.
3. Download to a local model directory. Use the checked-in `downloadVerifiedModel` helper or another process that verifies HTTPS, pinned size and SHA-256 before renaming the file into place. For redirects, pass an exact allow-list containing the source host and approved CDN host; only HTTPS/default-port redirects are followed (maximum five), and the helper rejects unapproved hosts before downloading the redirected body.
4. For a fresh install, create an operator-owned `models/manifest.json`, replace every placeholder, list every artifact checksum and mark both distribution and commercial-use fields `verified` only when evidence exists. The current machine instead uses `E:\VietDub-AI\models\manifest.json`; do not commit it or its weights.
5. Run the backend health check:

```bash
npm run build
npm run start:backend
curl http://127.0.0.1:8080/health
```

The endpoint must report `mode: "local"`, `configured: true`, and all three component statuses as `ready`. The current target returns HTTP 200. On an unconfigured fresh install, missing files, a hash mismatch, an unverified license or a missing worker command keeps the service at HTTP 503.

## Hardware profiles

Do not label Light/Balanced/Quality or real-time support until measured on the target machine. This target has a real-worker benchmark in `E:\VietDub-AI\evidence\local-worker-benchmark-1790253519893.json`; results are for synthetic speech and do not replace human-speech/browser acceptance. Record OS, CPU/GPU, RAM, model revision/size, worker versions, STT real-time factor, p50/p95 subtitle latency, TTS start latency and memory growth. If the target machine cannot keep up, report `REALTIME_ACCEPTANCE=BLOCKED`.

## Windows and macOS

On Windows, the `.env.example` uses `python` from PATH and passes the worker
script and role as a JSON argument array. If needed, set each command to the
absolute path of the Python executable, then retain the corresponding args.
Example for the current target:

```powershell
$env:LOCAL_STT_WORKER_COMMAND = "E:\VietDub-AI\runtime\venv\Scripts\python.exe"
$env:LOCAL_TRANSLATION_WORKER_COMMAND = "E:\VietDub-AI\runtime\venv\Scripts\python.exe"
$env:LOCAL_TTS_WORKER_COMMAND = "E:\VietDub-AI\runtime\venv\Scripts\python.exe"
npm run start:backend
```

Use the role-specific `LOCAL_*_WORKER_ARGS` from `.env.example`; do not pass
audio/text in command-line arguments.

macOS example:

```bash
export LOCAL_STT_WORKER_COMMAND="$(command -v python3)"
export LOCAL_TRANSLATION_WORKER_COMMAND="$(command -v python3)"
export LOCAL_TTS_WORKER_COMMAND="$(command -v python3)"
npm run start:backend
```

These are setup procedures, not platform acceptance evidence. A platform remains `UNVERIFIED` until a real Chrome/Firefox run and the required soak/quality measurements are recorded.

## Security and privacy

The backend binds to `127.0.0.1` by default, restricts WebSocket origins to browser extension schemes or loopback pages, caps frame size, validates session ownership and uses bounded worker queues. Raw audio/transcript data is not persisted by the gateway. Worker stderr is truncated and is not returned to the browser.
