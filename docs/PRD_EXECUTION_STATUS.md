# PRD Execution Status

Ngày cập nhật: 2026-09-20

STATUS: BLOCKED / IMPLEMENTED, NOT VERIFIED
BRANCH: codex/vietdub-production-pipeline
HEAD_SHA: b71cb17c265a05dac3e98bbd0076f34b84b7e22f
PR_URL: https://github.com/billy7d/ThuyetMinh-Ytb/pull/1 — existing Draft PR, not updated automatically because it is based on a separate 16-commit reliability branch
P0_ACCEPTANCE: BLOCKED — provider credentials are absent and Firefox runtime is absent
REAL_STT: IMPLEMENTED, NOT LIVE VERIFIED — Deepgram live WebSocket adapter with nova-3 default, interim/final aggregation, dedupe, bounded reconnect and buffer limits
REAL_TRANSLATION: IMPLEMENTED, NOT LIVE VERIFIED — Gemini generateContent adapter with context, terminology, delimited untrusted transcript and fail-closed output validation
REAL_VIETNAMESE_TTS: IMPLEMENTED, NOT LIVE VERIFIED — Google Cloud Text-to-Speech vi-VN LINEAR16 adapter with parsed WAV metadata and generation cancellation
CHROME_BROWSER_E2E: SMOKE PASS 5/5 on local HTML5 fixture; not YouTube/provider-live acceptance
FIREFOX_BROWSER_E2E: BLOCKED — Playwright Firefox executable is not installed in this environment
SUBTITLE_VISIBLE: NOT VERIFIED on real browser/provider session
VIETNAMESE_VOICE_AUDIBLE: NOT VERIFIED on real browser/provider session
AUDIO_RESTORATION: NOT VERIFIED on real browser/provider session
SESSION_LIFECYCLE: IMPLEMENTED; unit/integration coverage exists, real tab-close/navigation/seek acceptance remains pending
LATENCY_P50_P95: NOT MEASURED live; old fixture numbers are invalidated and STT live timing remains unreported
TRANSLATION_QUALITY: NOT MEASURED live; 30-sample command is explicitly fixture-only and produces no production score
API_TEST_COST: 0 USD — no live provider API request was made
SECURITY: no hardcoded provider keys found; production audit reports 0 vulnerabilities; full audit reports 2 moderate Vitest dev-dependency advisories requiring a breaking upgrade
TEST_RESULTS: npm run typecheck PASS; npm run build PASS; npm test PASS (6 files, 21 tests); npm run benchmark PASS as FIXTURE_ONLY_NOT_PRODUCTION_EVIDENCE; npm run test:e2e:chrome PASS (5 tests); Firefox E2E BLOCKED by missing runtime; git diff --check PASS
CI_EXACT_HEAD: workflow added at .github/workflows/quality.yml; remote CI result not verified from this environment
EVIDENCE_PATHS: docs/TEST_REPORT.md, docs/PROVIDER_SETUP.md, docs/BROWSER_ACCEPTANCE_CHECKLIST.md, docs/BROWSER_COMPATIBILITY.md, packages/tests/unit/provider-contract.test.ts, packages/tests/integration/pipeline.test.ts
FILES_CHANGED: 55 files across the two commits below
COMMITS_PUSHED: e2c8174 feat: wire production realtime AI providers; b71cb17 docs: record PRD execution status -> origin/codex/vietdub-production-pipeline
MERGE_READY: NO
MERGED: NO
MERGE_SHA: N/A
MAIN_SHA: aa0d620c150e89807b8d97f96ffa86c1fe89fb9a
REMAINING_BLOCKERS: configure Deepgram/Gemini/Google Cloud TTS credentials on a backend host; run live provider smoke and 30-minute soak within budget; install/run Firefox; execute the full Chrome+Firefox YouTube/HTML5 acceptance checklist; capture sanitized latency and translation-quality evidence; resolve or explicitly accept the two moderate Vitest dev dependency advisories; decide whether to transplant this commit onto the existing Draft PR #1 branch.
