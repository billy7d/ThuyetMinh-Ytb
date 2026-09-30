# Known Limitations

Ngày cập nhật: 2026-09-24

- DRM-protected media is out of scope; the extension does not bypass EME/CDM protections.
- Firefox capture of cross-origin media without suitable CORS permissions may be rejected by the browser.
- Original audio volume controls the complete original mix; source separation that preserves BGM while removing speech is not implemented.
- Live streams can accumulate provider/network delay. The client drops stale TTS work beyond the configured backlog threshold instead of playing an increasingly late queue.
- Browser acceptance, live human-speech quality and 30-minute soak are not verified. Offline worker benchmarks and two short synthetic-audio gateway runs have passed, but they do not establish real browser latency or audibility.
- The three Python JSONL workers (faster-whisper, OPUS-MT, VieNeu) have loaded the pinned models and completed real CPU inference. The gateway has passed only with English speech synthesized locally by VieNeu, not a human recording.
- Model/code/codec/voice licenses, immutable upstream revisions and local artifact hashes are recorded in the operator manifest at `E:\VietDub-AI\models\manifest.json`; weights/cache/evidence stay outside Git. A fresh machine still needs its own approved download and verification.
- The translation worker currently translates `sourceText` as a standalone input; context and terminology fields from the provider boundary are not applied by this OPUS-MT worker. Context-aware translation quality is therefore not verified.
- The current latency event schema needs provider-boundary monotonic timestamps before it can support authoritative end-to-end p50/p95 reporting.
