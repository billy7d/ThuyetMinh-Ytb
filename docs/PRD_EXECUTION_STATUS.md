# PRD Execution Status

Ngày cập nhật: 2026-09-21

STATUS: BLOCKED / LOCAL BOUNDARY IMPLEMENTED, NOT VERIFIED
BRANCH: codex/vietdub-production-pipeline
HEAD_SHA: pending final commit
PR_URL: https://github.com/billy7d/ThuyetMinh-Ytb/pull/1 — PR state/mergeability could not be queried because `gh` is not installed in this environment
P0_ACCEPTANCE: BLOCKED — no local model/worker runtime, Firefox executable missing and no live hardware evidence
AI_DEFAULT_MODE: local; cloud adapters require AI_MODE=cloud, CLOUD_PROVIDERS_ENABLED=true and PAID_API_ALLOWED=true
ZERO_COST_ENFORCEMENT: PASS in code/tests — local CostTracker reports 0 external API cost and the default factory never constructs cloud adapters
LOCAL_STT: IMPLEMENTED ADAPTER, NOT LIVE VERIFIED — bounded JSONL worker boundary; whisper.cpp is the documented candidate
LOCAL_TRANSLATION: IMPLEMENTED ADAPTER, NOT LIVE VERIFIED — bounded JSONL en→vi worker boundary; OPUS-MT candidate and license evidence recorded
LOCAL_VIETNAMESE_TTS: IMPLEMENTED ADAPTER, NOT LIVE VERIFIED — bounded JSONL WAV boundary with parsed metadata; VieNeu candidate retained pending exact rights/revision
MODEL_MANAGER: IMPLEMENTED, NOT READY — manifest schema, SHA-256/size/license verification and explicit-consent downloader are present; example manifest is intentionally unverified
CHROME_BROWSER_E2E: SMOKE PASS 5/5 on local HTML5 fixture outside sandbox; not local-model/YouTube acceptance
FIREFOX_BROWSER_E2E: BLOCKED — Playwright Firefox executable is not installed in this environment
SUBTITLE_VISIBLE: NOT VERIFIED on real local-model browser session
VIETNAMESE_VOICE_AUDIBLE: NOT VERIFIED on real local-model browser session
AUDIO_RESTORATION: UNIT/LIFECYCLE CODE PRESENT, NOT VERIFIED by Chrome and Firefox operator actions
SESSION_LIFECYCLE: IMPLEMENTED with bounded final queue, generation cancellation and backend-disconnect cleanup; real tab-close/navigation acceptance pending
LATENCY_P50_P95: NOT MEASURED live; current STT event is only a bounded wall-clock diagnostic, provider-boundary evidence is required
TRANSLATION_QUALITY: NOT MEASURED live; fixture output is not production evidence
API_TEST_COST: 0 USD — no live cloud request was made
SECURITY: loopback bind, origin/session/frame checks and no-cloud default implemented; production audit 0 vulnerabilities; full audit has 2 moderate Vitest dev advisories with a breaking fix
TEST_RESULTS: npm run typecheck PASS; npm run build PASS; npm test PASS (7 files, 27 tests); Chrome smoke PASS 5/5; Firefox E2E BLOCKED by missing Playwright Firefox; Chrome/Firefox build PASS; health smoke PASS with safe 503; tracked-source secret scan PASS; git diff --check PASS; npm audit --omit=dev PASS
CI_EXACT_HEAD: not verified from this environment
EVIDENCE_PATHS: docs/LOCAL_RUNTIME.md, docs/MODEL_LICENSE_REPORT.md, docs/TEST_REPORT.md, docs/BROWSER_ACCEPTANCE_CHECKLIST.md, packages/tests/unit/local-runtime.test.ts, packages/tests/unit/provider-contract.test.ts
MERGE_READY: NO
MERGED: NO
MERGE_SHA: N/A
MAIN_SHA: aa0d620c150e89807b8d97f96ffa86c1fe89fb9a
REMAINING_BLOCKERS: install/verify local workers and models; fill exact manifest revisions/checksums/licenses; run STT 3-video, translation 30-sample and TTS 20-sentence evidence; run Chrome+Firefox YouTube/HTML5 3-mode acceptance; run 30-minute soak; measure p50/p95/RTF/CPU/RAM; obtain CI exact-head status; review the two moderate Vitest advisories; inspect/update Draft PR #1 with final commit
