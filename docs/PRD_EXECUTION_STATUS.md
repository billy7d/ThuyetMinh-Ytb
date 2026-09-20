# PRD Execution Status

Ngày cập nhật: 2026-09-21

STATUS: BLOCKED / LOCAL BOUNDARY IMPLEMENTED, NOT VERIFIED
BRANCH: fix/firefox-extension-reliability-p0 (PR #1 target; local integration branch is codex/vietdub-production-pipeline)
HEAD_SHA: 0c608f3253329f111bd73ad5e0f69bae90f2bd16 (implementation merge pushed to PR #1 branch; this report is a follow-up documentation commit)
PR_URL: https://github.com/billy7d/ThuyetMinh-Ytb/pull/1 — PR state/mergeability could not be queried because `gh` is not installed in this environment
P0_ACCEPTANCE: BLOCKED — no local model/worker runtime, Firefox executable missing and no live hardware evidence
P0_AND_PRODUCTION_ANCESTRY: PASS — merge commit 0c608f3 has parents a51f7f9 (local runtime) and f98d7ea (PR #1 P0 line)
AI_DEFAULT_MODE: local; cloud adapters require AI_MODE=cloud, CLOUD_PROVIDERS_ENABLED=true and PAID_API_ALLOWED=true
ZERO_COST_ENFORCEMENT: PASS in code/tests — local CostTracker reports 0 external API cost and the default factory never constructs cloud adapters
LOCAL_STT: IMPLEMENTED ADAPTER, NOT LIVE VERIFIED — bounded JSONL worker boundary; whisper.cpp is the documented candidate
LOCAL_TRANSLATION: IMPLEMENTED ADAPTER, NOT LIVE VERIFIED — bounded JSONL en→vi worker boundary; OPUS-MT candidate and license evidence recorded
LOCAL_VIETNAMESE_TTS: IMPLEMENTED ADAPTER, NOT LIVE VERIFIED — bounded JSONL WAV boundary with parsed metadata; VieNeu candidate retained pending exact rights/revision
MODEL_MANAGER: IMPLEMENTED, NOT READY — manifest schema, SHA-256/size/license verification and explicit-consent downloader are present; example manifest is intentionally unverified
CHROME_BROWSER_E2E: BLOCKED — current P0 artifact harness cannot expose the unpacked MV3 service worker; an earlier 5/5 fixture smoke on the pre-merge base is not final local-model/YouTube evidence
FIREFOX_BROWSER_E2E: BLOCKED — Playwright Firefox executable is not installed in this environment
SUBTITLE_VISIBLE: NOT VERIFIED on real local-model browser session
VIETNAMESE_VOICE_AUDIBLE: NOT VERIFIED on real local-model browser session
AUDIO_RESTORATION: UNIT/LIFECYCLE CODE PRESENT, NOT VERIFIED by Chrome and Firefox operator actions
SESSION_LIFECYCLE: IMPLEMENTED with bounded final queue, generation cancellation and backend-disconnect cleanup; real tab-close/navigation acceptance pending
LATENCY_P50_P95: NOT MEASURED live; current STT event is only a bounded wall-clock diagnostic, provider-boundary evidence is required
TRANSLATION_QUALITY: NOT MEASURED live; fixture output is not production evidence
API_TEST_COST: 0 USD — no live cloud request was made
SECURITY: loopback bind, origin/session/frame checks and no-cloud default implemented; production audit 0 vulnerabilities; full audit has 2 moderate Vitest dev advisories with a breaking fix
TEST_RESULTS: npm run typecheck PASS; npm run build PASS including Chrome/Firefox artifact validators; npm test PASS (16 files, 53 tests); npm run benchmark PASS as 30-sample fixture-only output; current Chrome artifact E2E BLOCKED before tests because MV3 service worker is unavailable in the macOS harness; Firefox E2E BLOCKED by missing Playwright Firefox; health smoke PASS with safe 503; tracked-source secret scan PASS; git diff --check PASS; npm audit --omit=dev PASS
CI_EXACT_HEAD: not verified from this environment
EVIDENCE_PATHS: docs/LOCAL_RUNTIME.md, docs/MODEL_LICENSE_REPORT.md, docs/TEST_REPORT.md, docs/BROWSER_ACCEPTANCE_CHECKLIST.md, docs/audit/P0_REVIEW_FIX_REPORT.md, packages/tests/unit/local-runtime.test.ts, packages/tests/unit/provider-contract.test.ts
MERGE_READY: NO
MERGED: NO
MERGE_SHA: N/A
MAIN_SHA: aa0d620c150e89807b8d97f96ffa86c1fe89fb9a
PR_DESCRIPTION_UPDATED: NO — `gh` is not installed; branch was pushed but PR title/body/state and mergeability could not be queried or edited
COMMITS_PUSHED: 0c608f3 implementation merge and a07e22a report history are pushed to `fix/firefox-extension-reliability-p0` fast-forward; current branch head is the same report history
REMAINING_BLOCKERS: install/verify local workers and models; fill exact manifest revisions/checksums/licenses; run STT 3-video, translation 30-sample and TTS 20-sentence evidence; run Chrome+Firefox YouTube/HTML5 3-mode acceptance; run 30-minute soak; measure p50/p95/RTF/CPU/RAM; obtain CI exact-head status; review the two moderate Vitest advisories; update PR #1 body/state (gh is unavailable)
