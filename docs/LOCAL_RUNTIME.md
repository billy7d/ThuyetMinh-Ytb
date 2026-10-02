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

### Realtime behaviour and backpressure

- **Utterance assembly (STT worker):** audio is analysed in 20 ms frames with an adaptive energy threshold (noise floor tracking), so background music does not keep an utterance open forever. An utterance is flushed after `--silence-ms` (default 500 ms; 300 ms cut sentences at ordinary mid-sentence pauses and Whisper then adds a false full stop) of quiet, cut at the quietest point once it reaches `--soft-max-utterance-ms` (3.5 s), and force-cut at `--max-utterance-ms` (5 s, previously a hard 10 s). Whisper returns every sentence of an utterance only when the utterance ends, so shorter utterances directly lower subtitle latency. The remainder after a cut starts the next utterance so no words are lost. Whisper runs with the bundled Silero VAD filter, temperature fallback on high compression ratio, `no_repeat_ngram_size=3`, and `sanitize_transcript` collapses repetition loops ("English English English…") and caps text length by audio duration.
- **Backpressure:** while the STT worker is busy the backend coalesces audio (≤ `LOCAL_STT_MAX_REQUEST_MS` per request). When more than `LOCAL_STT_MAX_BUFFERED_MS` is waiting, the oldest audio is dropped and a single non-fatal `STT_OVERLOADED` warning is sent. Only `STT_UNAVAILABLE` (start failure or 5 consecutive failed requests) is fatal. TTS requests queue instead of throwing.
- **Subtitles are synchronised with the dubbed voice:** translation does not wait for TTS of earlier sentences (TTS runs on its own queue, max 3 pending). In `dubbing_and_subtitle` mode the backend sends `SUBTITLE_EVENT` with `syncWithTts:true` immediately before the matching `TTS_CHUNK`; the audio side (Firefox content script / Chrome offscreen) shows it exactly when that voice starts playing (`sync/tts-subtitle-sync.ts`) and keeps it for the voice duration + 0.4 s. If a sentence gets no voice (stale > 6 s, queue full, TTS error, decode failure, or no TTS within 1.5 s) its subtitle is shown immediately, so no subtitle is lost. `subtitle_only` mode still shows subtitles as soon as translation is ready.
- **Keeping the dub on the video timeline:** the browser speeds a voice up (max 1.3×, starting once 0.5 s is queued) when it is longer than the original sentence + 0.6 s or when playback is behind, and skips a sentence when more than 3.5 s of speech is already queued (a diagnostic `tts_mixer.backlog_skipped`, not a console warning; its subtitle is still shown). Translations are capped at 2× the source length (OPUS-MT sometimes invents text for sentence fragments, producing voices several times longer than the original). A fragment without final punctuation is merged only with sentences returned by the same Whisper call (150 ms window); otherwise it is translated alone, because waiting for the next utterance measured ≥1 s extra delay. Fragments of ≤4 words ("There will be a") are never translated alone (OPUS-MT returns nonsense for them): they wait for the continuation and are dropped if the next sentence starts more than 3 s later.
- **Translation quality layer (`runtime/workers/text_rules.py`):** OPUS-MT runs with beam search (4 beams, ~+120 ms/sentence). Fillers (um/uh/hmm, "you know,") are stripped before STT output is used. A small table rewrites phrases the model translates word-for-word ("subscribe" → "sign up", "like button", "blown away", "what I mean", "game changer") and fixes known Vietnamese errors afterwards ("nút thích hợp", "kênh liên lạc", archaic/gendered pronouns such as "Ta … ngươi", "hắn", "anh" for "you"), only when the English source confirms the person. The table is intentionally small and evidence-based; it does not replace a better translation model.
- **Cancellation:** each STT stream and TTS adapter has its own worker key. On seek/stop/reload the backend sends `{"op":"cancel","sessionId":…}` (optionally `beforeGeneration`), which the worker handles immediately on its stdin reader thread; queued requests for cancelled keys are answered with `{"ok":false,"cancelled":true}` without running inference, so a new session never waits behind an old one.
- **Readiness:** the gateway sends `SESSION_READY` only after all three workers are ready (waits up to 45 s; the extension waits 60 s). Otherwise it returns a fatal `LOCAL_RUNTIME_WARMING` (retryable) or `LOCAL_RUNTIME_NOT_READY`.
- **Error semantics:** the extension stops a session only for `ERROR` messages with `fatal: true`; non-fatal errors are shown as a warning in the popup while the session continues. Non-fatal warnings of the same code are rate-limited to one per 10 s.
- **Diagnostics:** worker stderr (including Python tracebacks) is appended to `worker-<role>.log` under `LOCAL_WORKER_LOG_DIR` (default: `logs` next to the model root; rotated at 5 MB). `LATENCY_METRIC.videoLagMs` reports the real lag behind the video, which the popup shows.
- **Thread budget:** keep the sum of `--threads` across the three workers at or below the CPU core count (this 6-core target: STT 3, translation 1, TTS 2). `runtime/start_backend.ps1` limits OpenMP/MKL pools to 2 threads per worker.

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

### Measured target profile (2026-10-02): i5-9400F 6C/6T, 16 GB, GTX 1660 SUPER 6 GB

| Stage | Engine / device | Measured |
| --- | --- | --- |
| STT | faster-whisper `small.en`, CUDA `int8_float16` (`--device auto`) | 0.42 s per 3.5 s utterance (base.en on CPU: 0.69 s; small.en on CPU: 2.1 s) |
| STT fallback | `--cpu-model-path` base.en, CPU int8 | used automatically when CUDA cannot load |
| Translation | `vinai/vinai-translate-en2vi-v2` (mBART, AGPL-3.0) converted to CTranslate2 (`--ct2-model-path`), CUDA `int8_float16`, beam 4 | 126 ms p50 / 204 ms p95 on 40 test sentences, 114 ms p50 in the live pipeline; clearly fewer errors than OPUS-MT (105 ms) in the A/B. OPUS-MT stays the repository default (CC-BY-4.0) and the CPU fallback profile |
| TTS | VieNeu ONNX, CPU, `--threads 4` | RTF 0.51 (2 threads: 0.59); GPU needs `onnxruntime-gpu`, not installed |

GPU support needs an NVIDIA driver with CUDA 12 and `pip install -r runtime/requirements-gpu.txt` (cuBLAS 12 + cuDNN 9,
~1.3 GB). CTranslate2 loads those DLLs through `PATH` at first inference, so the worker adds the venv `nvidia/*/bin`
directories itself and runs a warm-up inference at start-up (GPU errors appear there and trigger the CPU fallback).
STT accuracy options (`--beam-size 3`, `--glossary-file`): beam 3 costs no measurable latency on the GPU. The glossary (`runtime/glossary.example.json`, copy it outside the repo and edit) fixes misheard domain terms after recognition by fuzzy matching ("elastik search" -> "Elasticsearch", "tensor RT" -> "TensorRT"); it never changes words that are not within 2 characters of a term and never merges across sentence boundaries. Whisper `initial_prompt` (previous sentence as context) and `hotwords` were measured and rejected: the first makes Whisper repeat the previous sentence (9.4% word errors vs 5.0%), the second fixes terms but inserts extra words elsewhere.
Source-rewrite rules are per model (`text_rules.REWRITE_PROFILES`: vinai skips the `subscribe`/`what I mean` rewrites that OPUS-MT needs). The worker picks the profile from the model's `config.json` (`model_type: mbart` → vinai). Loading an 11.8 GB `model.safetensors` through memory mapping crashed this machine's Python (access violation); `madlad400-3b-mt` had to be read with plain file reads to convert it, which is why it is only kept as an evaluated candidate.
The CTranslate2 translation model is derived data: `runtime/convert_translation_ct2.py` writes `vietdub-conversion.json`
(source size + SHA-256) and the worker refuses a conversion whose source size does not match the installed model.

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
