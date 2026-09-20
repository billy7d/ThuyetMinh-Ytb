# Provider setup — VietDub AI

The production gateway is fail-closed. It does not start a mock provider when a credential or model setting is missing. Copy `.env.example` to `.env` in the repository root and fill the values on the backend host only.

## Streaming STT

VietDub uses Deepgram's live WebSocket API with `nova-3`, `en-US`, raw `linear16`, mono, 16 kHz PCM, interim results, punctuation, endpointing and bounded reconnect attempts. `DEEPGRAM_MODEL` is configurable so the operator can select a currently supported account model without rebuilding the extension.

## Contextual translation

VietDub calls Gemini `generateContent` through the backend. Set `GEMINI_MODEL` to a model currently supported by the account. The transcript is delimited as untrusted data, while the backend validates the returned text, rejects empty/commentary output and never falls back to displaying English as Vietnamese.

## Vietnamese TTS

VietDub calls Google Cloud Text-to-Speech `text:synthesize` with `vi-VN` and `LINEAR16`. The response is required to contain a RIFF/WAVE header; the backend parses the actual sample rate, channels, byte rate and duration before sending the audio metadata to the extension. `vi-VN-Standard-A` is the default configurable voice.

Cloud TTS authentication can use `GOOGLE_CLOUD_TTS_ACCESS_TOKEN` or an API key accepted by the configured project. Keep either credential in the backend environment. Do not put it in `packages/extension`, browser storage or a screenshot.

## Run

```bash
npm ci
npm run build
npm run start:backend
```

The backend health endpoint reports `200` only when all three production provider groups are configured. With missing credentials it returns `503` and a list of missing variable names, never their values.

Live provider tests are intentionally not run automatically by the default test command because they can incur provider charges. Run them only after confirming credentials, quotas and the PRD's two-dollar test budget.
