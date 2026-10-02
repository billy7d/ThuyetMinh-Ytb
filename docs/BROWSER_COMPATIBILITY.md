# Browser Compatibility Status

Ngày cập nhật: 2026-09-24

## Current status

| Browser | Build artifact | Live production acceptance | Status |
|---|---|---|---|
| Chrome | `packages/extension/dist/chrome` | Build/validator PASS; current extension was not loaded or run. Launching Chrome for version inspection hit profile ACL/ProcessSingleton; computer-use inventory failed to initialize. | BLOCKED / NOT VERIFIED |
| Firefox | `packages/extension/dist/firefox` | Build/validator PASS; Firefox executable was not found in the standard install paths checked. | BLOCKED |

Model weights are not installed yet, so local AI browser acceptance cannot begin.
Buildability is not browser acceptance: the PRD requires real Chrome and Firefox
evidence for audio capture, subtitle visibility, Vietnamese TTS audibility,
restore-on-stop and lifecycle cleanup.

## Manual acceptance prerequisites

1. Obtain user approval for the pinned models, download and verify local files.
2. Start the verified local backend; require health `configured: true`.
3. Install/load the matching unpacked extension artifact in Chrome and Firefox.
4. Run [`BROWSER_ACCEPTANCE_CHECKLIST.md`](BROWSER_ACCEPTANCE_CHECKLIST.md) on a
   YouTube tab and a plain HTML5 video page.
5. Save console/backend logs and screen/audio evidence without credentials,
   transcript text or raw audio.

Historical feasibility/media spikes are retained in `docs/audit/`; they are not
live local-model acceptance evidence.
