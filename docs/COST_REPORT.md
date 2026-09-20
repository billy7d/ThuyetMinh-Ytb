# Cost and Budget Status

Ngày cập nhật: 2026-09-20

## Implemented controls

- Backend `CostTracker` enforces a default maximum session duration of 30 minutes and a default maximum estimated session cost of 2 USD.
- Audio, translation characters and TTS characters are tracked per session.
- The gateway limits concurrent sessions and rejects oversized/invalid audio frames.
- Production provider construction fails closed when required credentials or model configuration are missing.

## Pricing evidence

The older fixed per-hour estimate has been removed from acceptance evidence. Provider pricing and model rates are external, change over time, and depend on actual speech ratio, tokenization, voice and deployment. Before release, record the provider pricing pages, configured models, measured character/token counts and the resulting estimate.

No live provider request was made in this environment, so API test cost is currently 0 USD and is not evidence of production cost.
