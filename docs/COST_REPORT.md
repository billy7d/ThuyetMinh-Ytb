# Cost and Budget Status

Ngày cập nhật: 2026-09-20

## Implemented controls

- Backend `CostTracker` enforces a default maximum session duration of 30 minutes. The production default selects `costMode=local`, so external API cost is hard-coded to `0` in session metrics; the historical cloud pricing path remains available only for explicit diagnostics.
- Audio, translation characters and TTS characters are tracked per session.
- The gateway limits concurrent sessions and rejects oversized/invalid audio frames.
- Local provider construction fails closed when the manifest, checksums/licenses or worker commands are missing. Cloud provider construction requires `AI_MODE=cloud`, `CLOUD_PROVIDERS_ENABLED=true` and `PAID_API_ALLOWED=true`.

## Pricing evidence

The older fixed per-hour estimate has been removed from acceptance evidence. Provider pricing and model rates are external, change over time, and depend on actual speech ratio, tokenization, voice and deployment. Before release, record the provider pricing pages, configured models, measured character/token counts and the resulting estimate.

No live provider request was made in this environment. The local runtime's zero is enforced by code and does not imply CPU/GPU, electricity, disk or model-download cost is zero.
