# Subtitle mode và overlay regression — 2026-09-18

## Kết luận

Root cause của phiên audit không có phụ đề là mode runtime đã là `dubbing_only` (`sessionRef: s_024b4abb`). Backend hiện xử lý đúng contract: mode này vẫn phát TTS nhưng không phát `SUBTITLE_EVENT`. Vì vậy không có bằng chứng để sửa VAD, PCM hoặc điều kiện renderer theo hướng đoán mò.

Popup có nút `Thuyết minh + phụ đề` map đúng sang `dubbing_and_subtitle`. Đã tách việc tạo payload thành helper có kiểm thử exact payload và thêm browser case click chính nút này. Không phát hiện lỗi logic Popup đã làm biến đổi mode; thay đổi runtime tương ứng chỉ là làm relay background có thể kiểm thử độc lập, không đổi điều kiện phát subtitle.

## Thay đổi đã thực hiện

- Khóa contract Popup → background: payload phải chứa `type: START_SESSION` và `mode: dubbing_and_subtitle`.
- Bổ sung regression cho pipeline:
  - `dubbing_and_subtitle` phải tạo `SUBTITLE_EVENT` và `TTS_CHUNK`.
  - `subtitle_only` phải tạo subtitle nhưng không TTS.
  - `dubbing_only` phải không tạo subtitle nhưng vẫn TTS.
- Tách relay Chrome background thành `relaySubtitleEvent`, chỉ chuyển event khi `sessionId` khớp phiên hiện tại và có `tabId` đích; thêm test giữ nguyên message và loại event stale.
- Bổ sung browser assertions cho overlay: `display:flex`, `position:absolute`, z-index tối đa, text visible, rectangle có kích thước dương, overlap với video, và còn đúng một overlay sau khi thay node video + phát `yt-navigate-finish`.
- Không sửa VAD/PCM vì các đường đó đã có evidence hợp lệ trong audit trước.

## Kết quả kiểm thử local

| Gate | Kết quả | Bằng chứng |
|---|---|---|
| Test toàn bộ `@vietdub/tests` | PASS | 14 test files, 44 tests |
| Typecheck extension | PASS | `npm run typecheck -w @vietdub/extension` |
| Build | PASS | Chrome + Firefox + artifact validation |
| Playwright E2E | 2 PASS, 10 SKIPPED | Chỉ 2 bundle-smoke chạy; browser runtime bị skip bởi harness không khởi chạy được Chrome/Firefox extension runtime |
| `git diff --check` | PASS | Không có whitespace error |

Các test unit/integration không được dùng làm browser acceptance. E2E case full chain `Popup → backend → offscreen → background → content → SubtitleRenderer` đã được thêm, nhưng lần chạy này bị skip cùng harness; vì vậy chưa có browser PASS.

## Browser/YouTube acceptance

Computer Use đã mở được YouTube thật và phát được video trong tab hiện tại. Tuy nhiên surface không cho điều khiển popup/toolbar của extension, và policy chặn đường nạp extension runtime. Do đó trạng thái chính thức là:

`BROWSER_ACCEPTANCE=BLOCKED`

Chưa được kết luận overlay đã hiển thị thực tế trên YouTube. Không có screenshot/log browser thật hợp lệ để báo PASS.

### Manual acceptance cần operator thực hiện

1. Chạy `npm run build` rồi nạp `packages/extension/dist/chrome` bằng **Load unpacked** trên Chrome; tải lại tab YouTube sau khi nạp extension.
2. Mở video YouTube, bấm Play, mở popup, chọn đúng `Thuyết minh + phụ đề`, rồi bấm `Bắt đầu thuyết minh`.
3. Xác nhận backend nhận `SESSION_START` với `mode: 'dubbing_and_subtitle'`, sau đó có các event `TRANSCRIPT_FINAL → TRANSLATION_READY → SUBTITLE_EVENT`.
4. Trong tab YouTube, xác nhận DOM `#vietdub-subtitle-container` và `#vietdub-subtitle-text` visible, nằm chồng lên vùng video, không bị che; chụp screenshot có cả video và phụ đề.
5. Chuyển sang video thứ hai hoặc để YouTube SPA thay node video; xác nhận overlay vẫn còn đúng một container và event mới cập nhật text.
6. Gửi screenshot cùng log đã loại bỏ URL/token/audio/raw transcript. Các marker hữu ích là `gateway.session_start_received`, `chrome_ws.event_forwarded_to_background`, `content.subtitle_event_received`, `content.subtitle_event_rendered`.

## Ranh giới năng lực hiện tại

Synthetic WAV chỉ tạo tiếng tút để kiểm thử đường phát âm thanh. `MockSTTProvider`, rule-based translation và synthetic TTS không phải AI production. Real STT, Real Translation và Vietnamese TTS vẫn **chưa được triển khai**; các kết quả local/CI không chứng minh chất lượng hoặc độ đúng của ba provider thật.

PR #1 phải tiếp tục ở Draft. Không merge, deploy hoặc xóa branch.
