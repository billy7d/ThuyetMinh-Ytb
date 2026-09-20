# P0 real-browser acceptance evidence — 2026-09-18

## Phạm vi và trạng thái

- Repository: `billy7d/ThuyetMinh-Ytb`
- Branch: `fix/firefox-extension-reliability-p0`
- Commit kiểm tra: `a7282d2f4026dc4ed56b7e95d2c751d5286ba554`
- Timestamp bắt đầu kiểm tra: `2026-09-18T10:23:59.8809014+07:00`
- PR: [#1](https://github.com/billy7d/ThuyetMinh-Ytb/pull/1), GitHub API xác nhận `open`, `draft=true`
- CI PR run: [#35252585548](https://github.com/billy7d/ThuyetMinh-Ytb/actions/runs/35252585548), `completed/success`, 9/9 jobs
- Video URL: `https://www.youtube.com/` — chỉ mở homepage để xác nhận Chrome page thật; chưa phát video kiểm thử.

Kết luận acceptance: **BLOCKED**, không phải PASS/FAIL sản phẩm. Hard-stop được kích hoạt trước bước cài extension vì Chrome bị chặn tại `chrome://extensions/` và Firefox không có target khả dụng để quan sát toolbar, tab capture, STT/TTS hoặc audio restoration.

## Runtime đã kiểm tra

| Thành phần | Kết quả thực tế |
| :--- | :--- |
| Node.js | `v24.18.0` |
| npm | `11.16.0` |
| Playwright | `1.63.0` (`npx --no-install playwright --version`) |
| `web-ext` | Không có trong PATH |
| GitHub CLI | Không có trong PATH; `gh auth status` không chạy được |
| Chrome executable | Có tại `C:\Program Files\Google\Chrome\Application\chrome.exe` |
| Firefox executable | Không tìm thấy tại các path chuẩn đã kiểm tra |
| Computer Use state | Lần đầu chỉ expose Codex In-app Browser; sau user retry expose Chrome `id=2`, Firefox vẫn không xuất hiện |

## Bằng chứng Computer Use — lần thử đầu

Các lời gọi browser thật đã trả về:

```text
createBrowserTab("chrome", "https://www.youtube.com", ...)
-> Browser is not available: chrome

createBrowserTab("firefox", "https://www.youtube.com", ...)
-> Browser is not available: firefox
```

Đây là lỗi khả dụng của browser automation host, không phải kết quả extension. Không dùng Edge, page injection, mock Chrome API hoặc artifact PING để thay thế nghiệm thu Chrome/Firefox.

## Ma trận acceptance

| Test | Chrome | Firefox | Bằng chứng |
| :--- | :---: | :---: | :--- |
| Cài extension thật và kiểm tra manifest/permissions | BLOCKED | BLOCKED | Chrome `chrome://extensions/` bị URL Policy chặn; Firefox không có target |
| Toolbar invocation và popup thật | BLOCKED | BLOCKED | Không thể nạp extension/đi tới toolbar bằng browser surface được expose |
| `SESSION_READY → ACTIVE → STOP` | NOT_RUN | NOT_RUN | Hard-stop trước khi cài |
| Tab capture và STT transcript | NOT_RUN | NOT_RUN | Không có extension tab/session thật |
| Translation và TTS độc lập | NOT_RUN | NOT_RUN | Không có backend/browser session của extension |
| Giữ/giảm/tắt âm lượng gốc | NOT_RUN | NOT_RUN | Chưa phát video kiểm thử |
| STOP khôi phục volume/mute | NOT_RUN | NOT_RUN | Không có runtime để quan sát |
| Double START / STOP khi connecting | NOT_RUN | NOT_RUN | Không có toolbar thật |
| Backend disconnect/reconnect | NOT_RUN | NOT_RUN | Không có session thật |
| Reload, chuyển video, đóng tab | NOT_RUN | NOT_RUN | Chưa có YouTube video tab của acceptance |
| Pause/resume, mute/unmute | NOT_RUN | NOT_RUN | Không có media tab thật |
| YouTube smoke và chất lượng dịch | NOT_RUN | NOT_RUN | Chỉ mở homepage; chưa dùng video kiểm thử |

## Evidence không thể thu thập

- Screenshot Chrome: **NOT_COLLECTED** — Chrome YouTube page có expose nhưng hard-stop xảy ra trước khi có acceptance state cần chụp.
- Screenshot Firefox: **NOT_COLLECTED** — Firefox executable/target không khả dụng.
- Browser console logs: **NOT_COLLECTED** — chưa có browser page thật.
- Backend logs: **NOT_COLLECTED** — chưa khởi chạy một acceptance session thật.
- Audio/resource-leak observations: **NOT_COLLECTED** — không được suy diễn từ unit/integration test.

Không tạo file screenshot, console log hoặc backend log giả để làm PASS.

## Cách đóng blocker thủ công

Trên desktop có Chrome và Firefox thật:

1. Chạy `npm run build` tại commit này.
2. Chrome: mở `chrome://extensions`, bật Developer mode, chọn `Load unpacked`, nạp `packages/extension/dist/chrome`; mở YouTube, bấm icon VietDub AI trên toolbar, rồi thực hiện lifecycle/audio/error matrix.
3. Firefox: mở `about:debugging#/runtime/this-firefox` hoặc dùng `web-ext run --source-dir packages/extension/dist/firefox`; nạp artifact Firefox và thực hiện cùng matrix, ghi riêng fallback `captureStream` nếu không quan sát được.
4. Lưu screenshot, console/backend log đã loại bỏ secret, timestamp, browser version và video URL vào thư mục evidence.
5. Chỉ cập nhật `BROWSER_ACCEPTANCE=PASS` khi cả hai browser có evidence toolbar + capture + `SESSION_READY → ACTIVE → STOP` + audio restoration + YouTube smoke.

## Retry sau khi user khởi động browser thủ công

- Timestamp retry: `2026-09-18T10:30:03.7115813+07:00`
- Computer Use đã expose Chrome browser `id=2`, type `extension`, với tab YouTube thật `https://www.youtube.com/`; DOM snapshot xác nhận trang YouTube tải được và có nội dung homepage thực.
- Firefox không xuất hiện trong inventory sau khi refresh; không có Firefox target để claim hoặc temporary-install.
- Tab Chrome thứ hai hiện là một trang Google Search thật. Thử mở `chrome://extensions/` để kiểm tra/nạp artifact bị policy chặn:

```text
Browser Use rejected this action due to browser security policy.
Reason: The browser URL policy blocks this action.
Browser use cannot visit the requested page because its URL is blocked by the Browser use URL policy.
The agent must not attempt to achieve the same outcome via workaround, indirect execution, raw CDP or browser commands, or policy circumvention.
```

Kết quả retry: **Chrome YouTube page observed, nhưng Chrome extension install/toolbar acceptance vẫn BLOCKED**; Firefox acceptance vẫn **BLOCKED**. Không có screenshot, console log, backend log hoặc audio trace hợp lệ của extension để bổ sung sau hard-stop.
