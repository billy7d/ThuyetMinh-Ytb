# Browser Compatibility Status

Ngày cập nhật: 2026-09-20

## Current status

| Browser | Build artifact | Live production acceptance | Status |
|---|---|---|---|
| Chrome | `packages/extension/dist/chrome` | Chưa chạy với provider thật | IMPLEMENTED, NOT VERIFIED |
| Firefox | `packages/extension/dist/firefox` | Firefox executable không có trong môi trường | BLOCKED |

The extension contains separate Chrome offscreen and Firefox content capture paths. Buildability is not browser acceptance: the PRD requires real Chrome and Firefox evidence for audio capture, subtitle visibility, Vietnamese TTS audibility, restore-on-stop and lifecycle cleanup.

## Manual acceptance prerequisites

1. Install/load the matching unpacked extension artifact in Chrome and Firefox.
2. Start the backend with the variables in `docs/PROVIDER_SETUP.md`.
3. Run the checklist in `docs/BROWSER_ACCEPTANCE_CHECKLIST.md` on both a YouTube tab and a plain HTML5 video page.
4. Save console/backend logs and screen/audio evidence without credentials.
