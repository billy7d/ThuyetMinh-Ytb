# Local provider setup — VietDub AI

The production default is `AI_MODE=local`. STT, translation and Vietnamese TTS are separate local workers owned by the user. The backend does not ask for API keys, does not start cloud adapters, and does not fall back to cloud when a local worker fails.

Read [LOCAL_RUNTIME.md](LOCAL_RUNTIME.md) for the JSONL protocol, model manifest, explicit-consent download helper, checksum verification, and Windows/macOS setup.

## Required environment

```env
AI_MODE=local
CLOUD_PROVIDERS_ENABLED=false
PAID_API_ALLOWED=false
MAX_EXTERNAL_API_COST_USD=0
LOCAL_MODEL_MANIFEST=models/manifest.json
LOCAL_MODEL_ROOT=models
LOCAL_STT_WORKER_COMMAND=/absolute/path/to/stt-worker
LOCAL_TRANSLATION_WORKER_COMMAND=/absolute/path/to/translation-worker
LOCAL_TTS_WORKER_COMMAND=/absolute/path/to/tts-worker
```

Workers are long-lived processes. They must load their model once, emit a JSONL `ready` event, accept bounded requests, and return real inference output. They must not use an HTTP inference provider, cloud API, fixture transcript, rule-based translation or synthetic audio.

## Readiness

```bash
npm ci
npm run build
npm run start:backend
curl http://127.0.0.1:8080/health
```

Readiness is `503` until all three manifest entries exist, every artifact size/SHA-256 matches, distribution and commercial-use fields are verified, and all three worker commands are configured. The health response lists component status and safe missing names only; it never returns credentials or transcript data.

## Explicit cloud diagnostics

The previous Deepgram/Gemini/Google adapters are retained only for an explicit, separately authorized diagnostic mode:

```env
AI_MODE=cloud
CLOUD_PROVIDERS_ENABLED=true
PAID_API_ALLOWED=true
```

This mode is not part of the zero-cost acceptance path. It is never selected automatically and is not used as a recovery path for local errors. Do not add these credentials to the extension or commit them.
