# Security and Privacy Status

Ngày cập nhật: 2026-09-20

## Implemented controls

- Provider keys are backend-only environment variables; no key is bundled into either extension artifact.
- The extension does not start capture until the user starts a session. Audio is streamed to STT and transcript text is sent to translation only while the session is active.
- There is no application-level audio/transcript persistence in the current backend path.
- Subtitle text is inserted with `textContent`, not HTML interpolation.
- Session ownership, bounded audio buffering, generation cancellation, rate limiting and budget guards are implemented.
- Stop, navigation, video replacement, tab close and provider error paths attempt to close streams and release Web Audio resources.

## Verification still required

- Run a secret scan against source and built artifacts using sanitized output.
- Verify CSP/manifest permissions and store-policy review for the final browser packages.
- Run browser-level checks for cross-tab isolation, audio restoration and no audio after stop.
- `npm audit` currently reports two moderate dependency advisories; these are not silently auto-fixed because dependency changes need review.

Status: `IMPLEMENTED, NOT VERIFIED` for production release.
