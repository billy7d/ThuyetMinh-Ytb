# P0 Review Fix Report — Firefox Extension Reliability

**Dự án:** VietDub AI
**Ngày kiểm chứng:** 2026-09-18
**Nhánh:** `fix/firefox-extension-reliability-p0`
**Phạm vi:** sửa build artifact, handshake content script, session lifecycle, audio graph, popup state, regression tests và audit runtime phụ đề/thuyết minh.

**LOCAL_QUALITY:** PASS — `npm test` 40/40; unit 22/22; integration 18/18; build/validator Chrome+Firefox độc lập và full build PASS; typecheck PASS; bundle smoke 2/2 PASS.
**CI_QUALITY:** PENDING — đang chờ workflow mới trên commit sửa mock continuous speech/subtitle display; CI canonical trước đó là 9/9 PASS trên commit `e6fa01c9c22936d3d1c0c83074717d138c273a27`.
**BROWSER_ACCEPTANCE:** BLOCKED — Chrome page mở được sau khi user khởi động, nhưng policy chặn `chrome://extensions`; Firefox vẫn không được expose
**MERGE_READY:** NO
**PR:** [Draft PR #1](https://github.com/billy7d/ThuyetMinh-Ytb/pull/1)

## Addendum — missing subtitles/dubbing runtime audit

Kết quả mới nhất và trace rút gọn nằm tại [2026-09-18-subtitle-dubbing-runtime-audit.md](evidence/2026-09-18-subtitle-dubbing-runtime-audit.md) và [2026-09-18-runtime-trace.log](evidence/2026-09-18-runtime-trace.log).

- Direct WebSocket runtime đã PASS toàn bộ mock path từ `SESSION_START` tới `SUBTITLE_EVENT`, `TTS_CHUNK` và `SESSION_METRICS` khi PCM có RMS `0.3239`; silence có RMS `0` và VAD phát hiện speech boundary.
- Không được kết luận browser capture PASS từ việc volume thay đổi. AudioMixer có thể điều khiển native playback trong khi STT tap vẫn silent hoặc chưa gửi chunk.
- Hai lỗi P0 đã sửa: VAD stateful bị gọi hai lần trên cùng chunk; PCM timestamp có thể trùng khi một callback tạo nhiều chunk. Firefox capture nay ưu tiên `captureStream`/`mozCaptureStream` có audio track và log RMS/source mode.
- Tái hiện runtime cho thấy mock VAD không chốt câu nếu voice liên tục không có silence; vì vậy không có downstream `TRANSLATION_READY`, `SUBTITLE_EVENT` hoặc `TTS_CHUNK`. Mock STT nay chốt đoạn tối đa 1500 ms và reset VAD. Subtitle renderer giữ segment ngắn tối thiểu 1500 ms để event không biến mất gần như ngay lập tức.
- Renderer/decoder browser thật chưa có evidence vì Chrome URL policy chặn `chrome://extensions` và Firefox không xuất hiện. Vì vậy nguyên nhân browser-specific cuối cùng vẫn là `NOT_RUN`, không suy diễn thành PASS.
- `P0 mock pipeline: PASS`; `Real STT: NOT_IMPLEMENTED`; `Real Translation: NOT_IMPLEMENTED`; `Real Vietnamese TTS: NOT_IMPLEMENTED`.

## Trạng thái nghiệm thu

| Gate | Kết quả hiện tại | Bằng chứng |
| :--- | :---: | :--- |
| Typecheck shared/extension/backend/tests | PASS | Local clean checkout và CI job [typecheck workspaces](https://github.com/billy7d/ThuyetMinh-Ytb/actions/runs/35252585548/job/105308275948) |
| Extension build + artifact validator | PASS | Local target độc lập/full build và CI jobs [build Firefox](https://github.com/billy7d/ThuyetMinh-Ytb/actions/runs/35252585548/job/105308276186), [build Chrome](https://github.com/billy7d/ThuyetMinh-Ytb/actions/runs/35252585548/job/105308276168), [full build](https://github.com/billy7d/ThuyetMinh-Ytb/actions/runs/35252585548/job/105308276585) |
| Unit tests | PASS | 6 files, 22 tests; local full regression |
| Integration tests | PASS | 6 files, 18 tests, gồm session race/handshake/audio graph/pipeline continuous speech/build regression |
| Bundle smoke | PASS | 2 tests, Chrome/Firefox content bundle parse được như IIFE |
| Chrome extension artifact — PING | PASS (Edge Chromium fallback) | Nạp artifact unpacked thật, service worker/content script thật; không dùng `page.addScriptTag` hay mock `chrome` |
| Chrome native extension install/toolbar | BLOCKED | YouTube page thật mở được, nhưng browser URL policy chặn `chrome://extensions`; chưa thể nạp artifact hoặc invoke toolbar |
| Chrome capture lifecycle | BLOCKED | `tabCapture` trả `PERMISSION_DENIED`: action toolbar chưa được invoke trong CDP harness; 3 case được skip có lý do, không tính PASS |
| Firefox media page smoke | BLOCKED | Playwright Firefox trong host hiện không tạo được page (`browserContext.newPage` lỗi nội bộ) |
| Firefox extension runtime E2E | BLOCKED | Firefox không xuất hiện trong browser inventory, không có executable chuẩn và chưa có `web-ext`/temporary-install runner; không giữ lại test injection giả |
| CI/PR checks | PASS | Push [Quality run #35307275840](https://github.com/billy7d/ThuyetMinh-Ytb/actions/runs/35307275840) và PR [Quality run #35307278052](https://github.com/billy7d/ThuyetMinh-Ytb/actions/runs/35307278052), 9/9 jobs PASS trên `e6fa01c9c22936d3d1c0c83074717d138c273a27` |

## CI quality evidence

Workflow: `.github/workflows/quality.yml` — trigger `pull_request`, push branch `fix/firefox-extension-reliability-p0` và `workflow_dispatch`; mỗi job dùng Node `24.18.0`, npm cache, `npm ci`, timeout hữu hạn và `contents: read`.

Current canonical runs: push [Quality #35307275840](https://github.com/billy7d/ThuyetMinh-Ytb/actions/runs/35307275840) và PR [Quality #35307278052](https://github.com/billy7d/ThuyetMinh-Ytb/actions/runs/35307278052). Cả hai đều `completed/success` trên `e6fa01c9c22936d3d1c0c83074717d138c273a27`; baseline cũ chỉ giữ để tham chiếu lịch sử.

| Job | Kết quả |
| :--- | :---: |
| git diff check | PASS |
| build shared and backend | PASS |
| build Firefox independently | PASS |
| build Chrome independently | PASS |
| full build and artifact validation | PASS |
| typecheck workspaces | PASS |
| unit tests | PASS |
| integration tests | PASS |
| extension bundle smoke | PASS |

CI phát hiện dependency order không tái lập trên clean checkout: extension cần `@vietdub/shared/dist`, còn tests cần `@vietdub/backend/dist`. Commit `c3df169` loại trailing whitespace trong diff P0 để `git diff --check` chạy được; commit `7a1b734` thêm lifecycle hooks tối thiểu cho shared/backend/extension/tests. Sau đó local clean regression và cả 9 CI jobs đều PASS.

Chrome `tabCapture` bắt buộc extension phải được invoke trên tab hiện tại, tương tự `activeTab`; đây là giới hạn của harness headless/CDP, không phải lý do để nới quyền hoặc coi capture đã chạy. Xem [Chrome tabCapture API](https://developer.chrome.com/docs/extensions/reference/api/tabCapture).

## Review findings

| Finding | Xử lý hiện tại |
| :--- | :--- |
| Chrome offscreen HTML bị source copy ghi đè | Đã để Vite sở hữu HTML compile, thêm regression test và validator asset path. |
| `build:firefox`/`build:chrome` phụ thuộc artifact target khác | Đã tách validator theo `--target`; mỗi lệnh build chỉ kiểm tra target của nó. |
| Popup inject/retry và session race | Popup chỉ gửi START; background có handshake single-flight, `SessionManager`, generation và cleanup idempotent. |
| Firefox audio capture có nguy cơ double playback/mất STT | `captureStream`/`mozCaptureStream` được ưu tiên khi có audio track; `MediaElementSource` chỉ là fallback. STT tap nằm trước gain, TTS độc lập và native playback không bị nối lại vào destination. |
| Mock VAD state bị đọc hai lần | `MockSTTProvider` dùng đúng một kết quả `vad.process()` cho mỗi chunk; regression test đếm số lần gọi và vẫn chốt final transcript. |
| PCM timestamp có thể trùng | `PCMProcessor` tính timestamp theo số sample đã phát ra; regression test kiểm tra chuỗi `0,250,500,750` khi một callback tạo nhiều chunk. |
| Test cũ mô phỏng extension bằng injection | Đã bỏ fake messaging tests; thêm production integration, bundle smoke và artifact extension E2E fail-closed. |
| Test phụ thuộc backend/cổng cố định | E2E tự build backend, health-check và dùng cổng động; cleanup process/profile theo test. |
| UI suy đoán video hoặc ACTIVE/retry sai | `hasVideo` mặc định false, popup lấy snapshot background, phân loại lỗi và không tự retry permission/video error. |

## Test evidence và regression

- `npm run build`: PASS từ trạng thái đã bỏ toàn bộ generated package artifacts; `npm run build:firefox` và `npm run build:chrome` PASS độc lập khi target còn lại không tồn tại; validator target-specific PASS.
- Baseline trước runtime audit: `npm test` 32/32; unit 17/17; integration 15/15. Current results: `npm test` 40/40; unit 22/22; integration 18/18.
- `npm run test:e2e`: bundle smoke 2/2 PASS; 9 case browser runtime SKIPPED có annotation `BLOCKED`, 0 fake extension PASS.
- Chrome/Edge artifact smoke: PING thật PASS trên Edge Chromium fallback; Chrome capture lifecycle BLOCKED bởi `activeTab` action invocation.
- Audio graph regression: 2/2 integration PASS cho capture-stream không double playback, STT tap, TTS branch và restoration.
- Audio restoration runtime browser, Firefox extension E2E và YouTube smoke: `BLOCKED`/`NOT_RUN`, không suy diễn từ media spike.
- Validator negative test: tạm di chuyển Chrome `src/offscreen/offscreen.html` làm validator trả exit code 1, sau đó khôi phục artifact.
- `npm ci`: PASS trên Node `v24.18.0`/npm `11.16.0`; không commit `dist`, `node_modules` hoặc browser profile.

## Browser validation

| Browser gate | Trạng thái | Ghi chú |
| :--- | :---: | :--- |
| Chrome extension install/service worker/content PING | PASS trên Edge Chromium fallback | Đây chỉ là artifact fallback, không phải Chrome acceptance; không dùng `page.addScriptTag` hoặc mock `chrome`. |
| Chrome native extension install/toolbar | BLOCKED | Chrome YouTube page mở được sau khi user khởi động, nhưng `chrome://extensions/` bị Browser URL Policy chặn. |
| Chrome `tabCapture` → `SESSION_READY` → `ACTIVE` → `STOP` | BLOCKED | Harness CDP không tạo được action toolbar invocation thật. |
| Firefox extension install → lifecycle | BLOCKED | Firefox không xuất hiện trong inventory; chưa có temporary-install runner khả dụng. |
| Chrome YouTube smoke | NOT_RUN | Cần desktop action invocation và YouTube thực. |
| Firefox YouTube smoke | NOT_RUN | Cần Firefox temporary-install runner và YouTube thực. |

Evidence mới của lần kiểm tra desktop này nằm tại [2026-09-18-p0-real-browser-acceptance.md](E:/ThuyetMinh-Ytb/docs/audit/evidence/2026-09-18-p0-real-browser-acceptance.md). Sau khi user khởi động Chrome, Computer Use đã đọc được YouTube page thật; tuy nhiên thao tác mở `chrome://extensions/` bị Browser URL Policy từ chối. Firefox vẫn không xuất hiện trong inventory. Vì vậy hard-stop xảy ra trước bước cài extension/toolbar, không có screenshot/console/backend log browser acceptance hoặc audio trace hợp lệ để thu thập và không được chuyển các mục đó thành PASS.

## Remaining risks

1. Cần reviewer chạy manual toolbar invocation trên Chrome và temporary-install trên Firefox để đóng browser runtime gates.
2. Backend hiện dùng MockSTT/TTS theo phạm vi PRD; các test này không chứng minh AI production quality.

## Merge readiness

**NOT READY — P0 browser evidence còn thiếu.** Với thay đổi hiện tại, `CI_QUALITY=PASS`, `BROWSER_ACCEPTANCE=BLOCKED`: Chrome capture action invocation, Firefox extension lifecycle và YouTube smoke chưa có evidence desktop. Theo phạm vi PRD, branch chưa merge, chưa deploy và chưa xóa.

## PR #1 và quyền GitHub

`gh auth status` đã chạy nhưng không thực hiện được vì môi trường không có GitHub CLI: `gh: The term 'gh' is not recognized as a name of a cmdlet, function, script file, or executable program.` Không thử lách xác thực hoặc tự nhập thông tin đăng nhập. PR #1 vẫn phải giữ `open`, `draft=true`; trạng thái head và CI mới sẽ được cập nhật sau khi push.

Vì không có authenticated write channel, mô tả PR chưa được cập nhật trực tiếp. Operator có thể dán nội dung sau vào PR #1 và giữ nguyên trạng thái Draft:

```markdown
## Mục tiêu P0

Ổn định Firefox/Chrome extension runtime, xử lý handshake content script, session lifecycle và audio cleanup mà không mở rộng sang AI production.

## Root cause và thay đổi chính

- Firefox trước đây có race giữa popup/background/content script, dẫn tới `Could not establish connection. Receiving end does not exist`; content handshake mới dùng PING/injection single-flight và fail-closed.
- Chrome offscreen document được Vite compile sở hữu, không còn bị copy HTML nguồn ghi đè; artifact validator kiểm tra resource path và compiled JavaScript.
- `SessionManager` tập trung lifecycle, session ID, duplicate START coalescing, cancellation/stale guard, STOP và cleanup idempotent.
- Audio lifecycle tách STT tap khỏi original gain, giữ TTS độc lập, tránh double playback trong capture-stream và khôi phục volume/mute khi STOP.
- YouTube video node/URL thay đổi, seek, reload, tab close và WebSocket disconnect được xử lý fail-closed.

## CI

- Thêm `.github/workflows/quality.yml` cho pull request (kể cả Draft), push branch và workflow dispatch.
- CI dùng Node 24.18.0, npm cache, `npm ci`, `contents: read`, timeout và concurrency.
- Quality gates: shared/backend build, Firefox/Chrome build độc lập, full build + artifact validator, typecheck, unit, integration, bundle smoke và `git diff --check`.
- Current canonical runs: [push #35307275840](https://github.com/billy7d/ThuyetMinh-Ytb/actions/runs/35307275840) và [PR #35307278052](https://github.com/billy7d/ThuyetMinh-Ytb/actions/runs/35307278052) — 9/9 jobs PASS trên `e6fa01c9c22936d3d1c0c83074717d138c273a27`. Baseline cũ chỉ giữ để tham chiếu lịch sử.

## Test đã xác minh

- `npm test`: 32/32 PASS.
- Unit: 17/17 PASS; integration: 15/15 PASS; bundle smoke: 2/2 PASS.
- Build/validator Chrome và Firefox PASS độc lập và full build PASS từ clean generated state.

## Browser acceptance còn BLOCKED

- Chrome extension artifact PING PASS trên Edge Chromium fallback; Chrome tabCapture lifecycle vẫn BLOCKED vì CDP harness không invoke được action toolbar thật.
- Firefox extension runtime E2E BLOCKED vì chưa có temporary-install/web-ext runner khả dụng; Playwright Firefox page harness trên host lỗi nội bộ.
- Chrome/Firefox YouTube smoke, SESSION_READY → ACTIVE → STOP bằng toolbar thật, audio restoration thực tế và backend disconnect trên desktop chưa được nghiệm thu.
- Các ca browser chưa chạy không được tính là PASS.

## Known limitations

Backend hiện vẫn dùng MockSTT/TTS theo phạm vi P0; CI và test không chứng minh chất lượng AI production.

## Điều kiện merge

`CI_QUALITY=PASS`, `BROWSER_ACCEPTANCE=BLOCKED`, `MERGE_READY=NO`. Chỉ xem xét merge sau khi có bằng chứng desktop Chrome/Firefox toolbar, tab capture, lifecycle audio và YouTube smoke; giữ PR ở Draft cho tới lúc đó.
```

## Nguyên nhân gốc và thay đổi

1. Build trước đây copy lại `src/offscreen/offscreen.html` sau Vite, làm artifact production còn `offscreen.ts`. Build mới để Vite sở hữu HTML compile và validator resolve resource theo đúng thư mục HTML.
2. Content script được build IIFE độc lập. `ContentScriptHandshake` dùng một flight theo tab: PING, inject nhiều nhất một lần, rồi PING xác nhận; lỗi permission/restricted được fail-closed.
3. `SessionManager` tập trung state `IDLE → INITIALIZING → READY → CONNECTING → ACTIVE`, `STOPPING`, `ERROR`, tạo session ID UUID, coalescing duplicate START, hủy bằng `AbortController`, chặn stale response và cleanup idempotent.
4. Chrome dùng `tabCapture` + Offscreen; Firefox content-side ưu tiên `captureStream`/`mozCaptureStream` có audio track và chỉ fallback sang `MediaElementSource`. Nhánh STT tách trước gain, TTS độc lập, `captureStream` không được nối lại vào destination gây double playback, và volume/mute được khôi phục khi stop.
5. Popup chỉ đọc trạng thái và gửi một START duy nhất; background mới điều phối handshake/injection. Không còn tự inject/retry ngầm trong popup và không suy đoán có video từ URL/title.
6. Content lifecycle xử lý video node/URL thay đổi trong YouTube SPA, tab đóng/navigate, WebSocket disconnect, seek generation và dọn AudioContext/PCM/WebSocket.

Về cơ sở kỹ thuật của fallback, [W3C Media Capture from DOM Elements](https://www.w3.org/TR/mediacapture-fromelement/) mô tả `captureStream()` là capture output của media element và ghi rõ volume/mute của element không làm thay đổi volume audio đã capture; đây là cơ sở của việc tách capture khỏi native playback, nhưng không thay thế kiểm chứng Firefox runtime trên host này.

## Checklist manual còn lại

Reviewer cần chạy trên browser desktop có action toolbar thật:

1. Build bằng `npm run build`, nạp `packages/extension/dist/chrome` hoặc `packages/extension/dist/firefox`.
2. Mở video HTML5/YouTube đang phát, bấm icon VietDub AI trên toolbar rồi bấm `Bắt đầu thuyết minh`.
3. Xác nhận `SESSION_READY → ACTIVE`, STT vẫn nhận tín hiệu khi giảm/tắt âm thanh gốc, TTS phát độc lập và Stop khôi phục đúng `volume`/`muted`.
4. Thử double-click, Stop trong lúc Connecting, backend disconnect, reload/navigate SPA và đóng tab.
5. Với Firefox, dùng [web-ext](https://extensionworkshop.com/documentation/develop/getting-started-with-web-ext/) hoặc `about:debugging` để temporary-install; không dùng page injection để thay thế extension install.

## Release boundary

Đã chuẩn bị code/test/report trên branch review. CI đã PASS trên đúng HEAD; chưa merge, chưa xóa branch và chưa deploy production. Manual toolbar invocation, Firefox temporary-install, audio restoration thực tế và YouTube smoke vẫn là gate độc lập cần evidence trước khi gọi P0 hoàn tất.
