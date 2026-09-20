# Browser Acceptance Checklist

Run this checklist only with a verified local manifest/workers and a clean browser profile. Record browser version, extension build hash, backend commit, model revisions and timestamps. Never record API keys or raw audio/transcript data.

## Chrome and Firefox

- [ ] Load the corresponding unpacked extension artifact.
- [ ] Open a YouTube video and confirm the popup detects the video.
- [ ] Open a plain HTML5 video page and repeat the test.
- [ ] Start in dubbing + subtitle mode; confirm interim/final transcript events arrive.
- [ ] Confirm Vietnamese subtitle text is visible and follows the video timeline.
- [ ] Confirm Vietnamese TTS is audible and there is no duplicate TTS or synthetic beep.
- [ ] Set original volume to 0; confirm STT/TTS/subtitle continue.
- [ ] Set original volume to a non-zero value; confirm original and TTS gains remain independent.
- [ ] Pause and resume; confirm TTS does not continue while paused.
- [ ] Seek backward and forward; confirm stale subtitle/TTS generations are cancelled.
- [ ] Replace the video or navigate away; confirm the old session stops.
- [ ] Press Stop; confirm TTS stops, audio nodes are released and original mute/volume are restored.
- [ ] Close the tab; confirm the backend session closes and no audio continues.

## Evidence required for P0

Attach sanitized backend logs, browser console logs, a short screen recording or equivalent observation, and latency/quality summaries. A build or unit test alone does not satisfy this checklist.
