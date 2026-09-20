# Known Limitations

Ngày cập nhật: 2026-09-20

- DRM-protected media is out of scope; the extension does not bypass EME/CDM protections.
- Firefox capture of cross-origin media without suitable CORS permissions may be rejected by the browser.
- Original audio volume controls the complete original mix; source separation that preserves BGM while removing speech is not implemented.
- Live streams can accumulate provider/network delay. The client drops stale TTS work beyond the configured backlog threshold instead of playing an increasingly late queue.
- Browser acceptance, live provider quality, p50/p95 latency and 30-minute soak are not verified in the current environment.
- The current latency event schema needs provider-boundary monotonic timestamps before it can support authoritative end-to-end p50/p95 reporting.
