# P0 Review Fix Report — Firefox Extension Reliability

**Dự án:** VietDub AI
**Ngày kiểm chứng:** 2026-09-17
**Nhánh:** `fix/firefox-extension-reliability-p0`
**Phạm vi:** sửa build artifact, handshake content script, session lifecycle, audio graph, popup state và regression tests.

## Trạng thái nghiệm thu

| Gate | Kết quả hiện tại | Bằng chứng |
| :--- | :---: | :--- |
| Typecheck shared/extension/backend/tests | PASS | `npm run build -w @vietdub/shared`, `npm run typecheck -w @vietdub/extension`, `npm run build -w @vietdub/backend`, `npm run build -w @vietdub/tests` |
| Extension build + artifact validator | PASS | `npm run build:chrome`, `npm run build:firefox`; popup/offscreen HTML trỏ tới JS đã compile, không còn `.ts` |
| Unit tests | PASS | 4 files, 17 tests |
| Integration tests | PASS | 5 files, 15 tests, gồm session race/handshake/audio graph/build regression |
| Bundle smoke | PASS | 2 tests, Chrome/Firefox content bundle parse được như IIFE |
| Chrome extension artifact — PING | PASS (Edge Chromium fallback) | Nạp artifact unpacked thật, service worker/content script thật; không dùng `page.addScriptTag` hay mock `chrome` |
| Chrome capture lifecycle | BLOCKED | `tabCapture` trả `PERMISSION_DENIED`: action toolbar chưa được invoke trong CDP harness; 3 case được skip có lý do, không tính PASS |
| Firefox media page smoke | BLOCKED | Playwright Firefox trong host hiện không tạo được page (`browserContext.newPage` lỗi nội bộ) |
| Firefox extension runtime E2E | BLOCKED | Chưa có `web-ext`/temporary-install runner; không giữ lại test injection giả |
| CI/PR checks | PENDING | Sẽ được xác nhận trên PR sau push; chưa dùng làm release gate |

Chrome `tabCapture` bắt buộc extension phải được invoke trên tab hiện tại, tương tự `activeTab`; đây là giới hạn của harness headless/CDP, không phải lý do để nới quyền hoặc coi capture đã chạy. Xem [Chrome tabCapture API](https://developer.chrome.com/docs/extensions/reference/api/tabCapture).

## Review findings

| Finding | Xử lý hiện tại |
| :--- | :--- |
| Chrome offscreen HTML bị source copy ghi đè | Đã để Vite sở hữu HTML compile, thêm regression test và validator asset path. |
| `build:firefox`/`build:chrome` phụ thuộc artifact target khác | Đã tách validator theo `--target`; mỗi lệnh build chỉ kiểm tra target của nó. |
| Popup inject/retry và session race | Popup chỉ gửi START; background có handshake single-flight, `SessionManager`, generation và cleanup idempotent. |
| Firefox audio capture có nguy cơ double playback/mất STT | MediaElementSource được ưu tiên; captureStream là fallback có native-volume control; STT tap nằm trước gain và TTS độc lập. |
| Test cũ mô phỏng extension bằng injection | Đã bỏ fake messaging tests; thêm production integration, bundle smoke và artifact extension E2E fail-closed. |
| Test phụ thuộc backend/cổng cố định | E2E tự build backend, health-check và dùng cổng động; cleanup process/profile theo test. |
| UI suy đoán video hoặc ACTIVE/retry sai | `hasVideo` mặc định false, popup lấy snapshot background, phân loại lỗi và không tự retry permission/video error. |

## Test evidence và regression

- `npm run build`: PASS; `npm run build:firefox` và `npm run build:chrome` PASS độc lập; validator target-specific PASS.
- `npm run test`: 9 files, 32/32 PASS.
- `npm run test:e2e`: bundle smoke 2/2 PASS; 8 case browser runtime SKIPPED có annotation `BLOCKED`, 0 fake extension PASS.
- Chrome/Edge artifact smoke: PING thật PASS trên Edge Chromium fallback; Chrome capture lifecycle BLOCKED bởi `activeTab` action invocation.
- Audio graph regression: 2/2 integration PASS cho capture-stream không double playback, STT tap, TTS branch và restoration.
- Audio restoration runtime browser, Firefox extension E2E và YouTube smoke: `BLOCKED`/`NOT_RUN`, không suy diễn từ media spike.

## Browser validation

| Browser gate | Trạng thái | Ghi chú |
| :--- | :---: | :--- |
| Chrome extension install/service worker/content PING | PASS trên Edge Chromium fallback | Artifact thật; không dùng `page.addScriptTag` hoặc mock `chrome`. |
| Chrome `tabCapture` → `SESSION_READY` → `ACTIVE` → `STOP` | BLOCKED | Harness CDP không tạo được action toolbar invocation thật. |
| Firefox extension install → lifecycle | BLOCKED | Host chưa có temporary-install runner; Playwright Firefox page harness lỗi nội bộ. |
| Chrome YouTube smoke | NOT_RUN | Cần desktop action invocation và YouTube thực. |
| Firefox YouTube smoke | NOT_RUN | Cần Firefox temporary-install runner và YouTube thực. |

## Remaining risks

1. Cần reviewer chạy manual toolbar invocation trên Chrome/Edge và temporary-install trên Firefox để đóng browser runtime gates.
2. Cần CI chạy sau khi PR được tạo; kết quả hiện tại là `PENDING` cho đến khi có check run.
3. Backend hiện dùng MockSTT/TTS theo phạm vi PRD; các test này không chứng minh AI production quality.

## Merge readiness

**NOT READY — P0 browser evidence còn thiếu.** Code/build/regression gates đã PASS, nhưng Chrome capture action invocation, Firefox extension lifecycle, YouTube smoke và CI vẫn là gate độc lập. Theo phạm vi PRD, branch chưa merge, chưa deploy và chưa xóa.

## Nguyên nhân gốc và thay đổi

1. Build trước đây copy lại `src/offscreen/offscreen.html` sau Vite, làm artifact production còn `offscreen.ts`. Build mới để Vite sở hữu HTML compile và validator resolve resource theo đúng thư mục HTML.
2. Content script được build IIFE độc lập. `ContentScriptHandshake` dùng một flight theo tab: PING, inject nhiều nhất một lần, rồi PING xác nhận; lỗi permission/restricted được fail-closed.
3. `SessionManager` tập trung state `IDLE → INITIALIZING → READY → CONNECTING → ACTIVE`, `STOPPING`, `ERROR`, tạo session ID UUID, coalescing duplicate START, hủy bằng `AbortController`, chặn stale response và cleanup idempotent.
4. Chrome dùng `tabCapture` + Offscreen; Firefox dùng content-side `MediaElementSource` hoặc fallback `captureStream`. Nhánh STT tách trước gain, TTS độc lập, `captureStream` không được nối lại vào destination gây double playback, và volume/mute được khôi phục khi stop.
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

Đã chuẩn bị code/test/report trên branch review. Chưa merge, chưa xóa branch và chưa deploy production. CI, manual toolbar invocation và Firefox temporary-install vẫn là gate độc lập cần evidence trước khi gọi P0 hoàn tất.
