# VietDub AI — Integration Test Report

Ngày cập nhật: 2026-09-20

## Kết luận

`BLOCKED — IMPLEMENTED, LOCAL GATES PASS, LIVE ACCEPTANCE PENDING`.

The integration worktree contains the P0 reliability line plus the production provider line. Production startup is fail-closed: it never substitutes deterministic fixtures when provider configuration is absent. Fixtures are injected only by tests.

## Local evidence

| Gate | Kết quả | Ghi chú |
| --- | --- | --- |
| `npm ci` | PASS | Fresh dependency installation in the integration worktree |
| `npm run typecheck` | PASS | Shared package is built before extension typecheck |
| `npm run build` | PASS | Shared, backend, Chrome, Firefox, tests; both artifact validators pass |
| `npm test` | PASS | 15 files, 47 tests |
| Bundle smoke | PASS | Chrome 1/1, Firefox 1/1 |
| Fixture benchmark | PASS as fixture-only | 30 samples; output is explicitly `FIXTURE_ONLY_NOT_PRODUCTION_EVIDENCE` |
| `npm audit --omit=dev` | PASS | 0 production vulnerabilities |
| `npm audit --audit-level=high` | PASS at high/critical threshold | 2 moderate Vitest dev advisories remain; fix requires breaking Vitest 5 upgrade |
| Secret scan + `git diff --check` | PASS | No provider key material detected |
| Firefox acceptance | BLOCKED / skipped | Firefox executable is absent; no false PASS recorded |
| Chrome extension acceptance | BLOCKED | macOS Chrome starts, but headless harness does not expose the unpacked MV3 service worker |

## Test inventory retained

The original P0 unit/integration/browser specs remain in the branch, including audio mixer, extension communication/session lifecycle, subtitle relay/renderer, VAD, pipeline and bundle checks. The continuous-speech mock-STT regression is retained and now calls VAD exactly once per PCM chunk while finalizing long voice runs at a bounded segment duration.

Provider contract coverage adds:

- production factory fails closed when Deepgram/Gemini/Google TTS configuration is missing;
- Gemini receives delimited untrusted transcript data and rejects invalid output;
- Google Cloud TTS requires and parses real RIFF/WAVE metadata instead of guessing format.

The gateway integration test uses a test-only fixture provider factory. It does not alter production provider wiring.

## Live acceptance status

No Deepgram, Gemini or Google Cloud TTS request was made because the backend environment has no live credentials. Consequently there is no live STT/translation/TTS quality score, p50/p95 latency, 30-sample human evaluation or 30-minute soak evidence. Chrome YouTube/HTML5 and Firefox YouTube/HTML5 acceptance remain pending operator-run browser sessions with real providers.

See [Provider Setup](PROVIDER_SETUP.md), [Browser Acceptance Checklist](BROWSER_ACCEPTANCE_CHECKLIST.md) and [PRD execution status](PRD_EXECUTION_STATUS.md) for the exact operator actions and release blockers.
