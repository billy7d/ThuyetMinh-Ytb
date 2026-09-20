# VietDub PRD Integration / CI / Live Acceptance / Merge Status

Ngày cập nhật: 2026-09-20

STATUS: BLOCKED — IMPLEMENTED, LOCAL GATES PASS, LIVE ACCEPTANCE PENDING
REPO: https://github.com/billy7d/ThuyetMinh-Ytb
BASE_MAIN_SHA: aa0d620c150e89807b8d97f96ffa86c1fe89fb9a
P0_ORIGINAL_SHA: d6dbe837754a9cd704c14a4acce58046ef6c5516
PRODUCTION_ORIGINAL_SHA: d6e342b6a1b0229fc9f73a6c817ba5d28cfe4e4b
INTEGRATION_BRANCH: codex/pr1-production-integration
INTEGRATION_HEAD_SHA: f9f24f1d525bb8e306135088d86a6ef75a6ffc62 (pre-final verification)
P0_AND_PRODUCTION_ANCESTRY: PASS — both backup refs are ancestors of the non-fast-forward integration merge
CONFLICTS_AND_RESOLUTIONS: Preserved P0 session/lifecycle, VAD continuous-speech finalization, PCM/audio timestamps, Firefox capture/audio restoration, subtitle generation guards and diagnostics; integrated fail-closed Deepgram/Gemini/Google Cloud TTS providers, budget limits and provider metadata. Repaired merge damage in gateway, pipeline, translation/TTS wrappers, benchmark harness and client protocol fields.
P0_TEST_CASES_RETAINED: 17 original P0 unit/integration/browser-spec files retained; continuous-speech VAD regression remains covered.
NEW_PROVIDER_TEST_CASES: 3 provider contract tests covering fail-closed configuration, Gemini untrusted-input/output validation and Google TTS WAV metadata validation; fixture provider factory is test-only.
LOCAL_CLEAN_BUILD: PASS — fresh npm ci; npm run typecheck; npm run build; Chrome and Firefox artifact validators PASS.
LOCAL_TEST_TOTAL_AND_SKIPS: PASS — npm test 15 files / 47 tests; bundle smoke 2/2; Firefox media/extension suite 4 skipped because Firefox runtime is unavailable; Chrome extension suite blocked before tests because headless macOS Chrome did not expose the unpacked MV3 service worker.
CI_EXACT_HEAD_URL_AND_RESULT: Pending push of final integration head; workflow now includes diff check, ordered shared/backend/extension/tests build, full test inventory, Chrome/Firefox artifact builds, bundle smoke, production audit and secret scan.
STT_LIVE: BLOCKED — DEEPGRAM_API_KEY is not configured; live request was not attempted.
TRANSLATION_LIVE: BLOCKED — GEMINI_API_KEY/GEMINI_MODEL are not configured; live request was not attempted.
VIETNAMESE_TTS_LIVE: BLOCKED — Google Cloud TTS credential is not configured; live request was not attempted.
CHROME_YOUTUBE_AND_HTML5: BLOCKED — local Chrome exists, but the headless macOS harness did not expose the extension service worker; no YouTube/provider-live claim is made.
FIREFOX_YOUTUBE_AND_HTML5: BLOCKED — Firefox executable is not installed; Playwright acceptance skipped fail-closed.
SUBTITLE_VISIBLE: NOT VERIFIED on a real provider/browser session; fixture renderer assertions remain in source but did not become production acceptance evidence.
VOICE_AUDIBLE: NOT VERIFIED on a real provider/browser session.
ORIGINAL_AUDIO_RESTORE: NOT VERIFIED on a real provider/browser session; code path and unit/integration assertions are retained.
LIVE_LATENCY_P50_P95: NOT MEASURED — no live provider request; fixture benchmark explicitly emits FIXTURE_ONLY_NOT_PRODUCTION_EVIDENCE.
TRANSLATION_30_SAMPLE_EVALUATION: NOT MEASURED live — 30-sample command runs deterministic fixtures only and does not produce a production quality score.
SOAK_30_MINUTES: BLOCKED — requires operator-configured provider credentials and a real browser session.
COST_AND_QUOTA: $0 live API cost; no provider request was made. Production budget guard remains configured at the backend boundary.
SECURITY_AND_DEPENDENCY_AUDIT: Secret scan clean; npm audit --omit=dev reports 0 vulnerabilities; npm audit --audit-level=high exits 0 but reports 2 moderate Vitest dev-dependency advisories whose automated fix is breaking (Vitest 5), so no force upgrade was applied.
PR_1_URL_AND_STATE: https://github.com/billy7d/ThuyetMinh-Ytb/pull/1 — existing Draft PR; must remain Draft while live/Firefox/quality gates are blocked.
COMMITS_PUSHED: Not yet pushed from the integration worktree at the time of this report.
MERGE_READY: NO
MERGED: NO
MERGE_SHA: N/A
MAIN_SHA_AFTER_MERGE: N/A
BLOCKERS_WITH_OPERATOR_ACTIONS: Configure backend-only Deepgram, Gemini model/key and Google Cloud TTS credential; run live smoke, 30-sample human quality review and 30-minute soak within the $2 budget; provide/install Firefox and run temporary-install acceptance; provide a supported headed Chrome extension harness or operator-run Chrome YouTube/HTML5 acceptance; decide risk acceptance or a compatible Vitest upgrade for the two moderate dev advisories.
EVIDENCE_PATHS: docs/PRD_EXECUTION_STATUS.md; docs/TEST_REPORT.md; docs/PROVIDER_SETUP.md; docs/BROWSER_ACCEPTANCE_CHECKLIST.md; packages/tests/unit/provider-contract.test.ts; packages/tests/integration/pipeline.test.ts; packages/tests/integration/websocket-gateway.test.ts; packages/tests/src/benchmarks/run-benchmarks.ts
