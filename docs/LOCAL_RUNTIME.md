# Local runtime — VietDub zero-cost mode

`AI_MODE=local` is the default. The backend does not create, contact or fall back to Deepgram, Gemini or Google Cloud TTS in this mode. It starts a local worker only after the model manifest, checksums, license fields and worker commands are ready.

The repository intentionally does not commit model weights, Python environments or a voice model. Those artifacts are large, hardware-dependent and have distribution terms that must be checked by the operator. The checked-in `models/manifest.example.json` is a validation template, not a ready manifest.

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
{"op":"audio_chunk","sessionId":"...","pcmBase64":"...","timestampMs":1234,"durationMs":250,"sampleRate":16000,"channels":1}
{"op":"end_stream","sessionId":"..."}
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

TTS request/result:

```json
{"op":"synthesize","modelPath":"...","segmentId":"seg_1","generation":1,"text":"Xin chào.","startMs":0,"endMs":1200}
{"audioBase64":"<RIFF/WAVE base64>","mimeType":"audio/wav","sampleRate":24000,"channels":1,"durationMs":800}
```

Production TTS output must be real Vietnamese speech. Synthetic sine waves, beeps, fixture transcripts and rule-based translation are test-only and are prohibited in the configured production workers; the adapter validates the protocol and WAV metadata but cannot infer the acoustic provenance of an arbitrary worker output.

## Manifest and one-time setup

1. Read the upstream code, model, tokenizer, codec and voice terms for each selected revision. Confirm redistribution and commercial-use rights independently.
2. Show the user the source, revision, expected download size, checksum and license notice; obtain explicit consent before downloading.
3. Download to a local model directory. Use the checked-in `downloadVerifiedModel` helper or another process that verifies HTTPS, pinned size and SHA-256 before renaming the file into place.
4. Copy `models/manifest.example.json` to `models/manifest.json`, replace every placeholder, list every artifact checksum and mark both distribution and commercial-use fields `verified` only when evidence exists.
5. Run the backend health check:

```bash
npm run build
npm run start:backend
curl http://127.0.0.1:8080/health
```

The endpoint must report `mode: "local"`, `configured: true`, and all three component statuses as `ready`. Missing files, a hash mismatch, an unverified license or a missing worker command keeps the service at HTTP 503.

## Hardware profiles

Do not label Light/Balanced/Quality or real-time support until measured on the target machine. Record OS, CPU/GPU, RAM, model revision/size, worker versions, STT real-time factor, p50/p95 subtitle latency, TTS start latency and memory growth. If the target machine cannot keep up, report `REALTIME_ACCEPTANCE=BLOCKED`.

## Windows and macOS

Use an absolute executable path in `.env` on both platforms. PowerShell example:

```powershell
$env:LOCAL_STT_WORKER_COMMAND = "C:\vietdub\worker\vietdub-stt-worker.exe"
$env:LOCAL_TRANSLATION_WORKER_COMMAND = "C:\vietdub\worker\vietdub-translation-worker.exe"
$env:LOCAL_TTS_WORKER_COMMAND = "C:\vietdub\worker\vietdub-tts-worker.exe"
npm run start:backend
```

macOS example:

```bash
export LOCAL_STT_WORKER_COMMAND="$PWD/runtime/bin/vietdub-stt-worker"
export LOCAL_TRANSLATION_WORKER_COMMAND="$PWD/runtime/bin/vietdub-translation-worker"
export LOCAL_TTS_WORKER_COMMAND="$PWD/runtime/bin/vietdub-tts-worker"
npm run start:backend
```

These are setup procedures, not platform acceptance evidence. A platform remains `UNVERIFIED` until a real Chrome/Firefox run and the required soak/quality measurements are recorded.

## Security and privacy

The backend binds to `127.0.0.1` by default, restricts WebSocket origins to browser extension schemes or loopback pages, caps frame size, validates session ownership and uses bounded worker queues. Raw audio/transcript data is not persisted by the gateway. Worker stderr is truncated and is not returned to the browser.
