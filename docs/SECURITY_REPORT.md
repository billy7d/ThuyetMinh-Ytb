# Security and Privacy Status

Ngày cập nhật: 2026-09-20

## Implemented controls

- The default provider factory is local-only; cloud adapters require explicit mode and opt-in flags. No key is bundled into either extension artifact.
- The extension does not start capture until the user starts a session. Audio is streamed to STT and transcript text is sent to translation only while the session is active.
- There is no application-level audio/transcript persistence in the current backend path.
- Subtitle text is inserted with `textContent`, not HTML interpolation.
- Loopback binding, extension/loopback origin checks, session ownership, bounded WebSocket frames/worker queues, generation cancellation, rate limiting and budget guards are implemented.
- Stop, navigation, video replacement, tab close and provider error paths attempt to close streams and release Web Audio resources.
- A tracked-source secret scan found no API-key/token matches; built-artifact CSP and browser permission review remain release gates.

## Verification still required

- Run the final sanitized secret scan against built artifacts as part of release CI.
- Verify CSP/manifest permissions and store-policy review for the final browser packages.
- Run browser-level checks for cross-tab isolation, audio restoration and no audio after stop.
- `npm audit --omit=dev` reports 0 production vulnerabilities. Full `npm audit` reports two moderate Vitest/@vitest/mocker advisories; the available fix is a breaking Vitest 5 upgrade and was not applied without compatibility review.

Status: `IMPLEMENTED, NOT VERIFIED` for production release.
