import { describe, expect, it } from 'vitest';
import { createStartSessionMessage } from '../../extension/src/popup/start-session-message.js';

describe('Popup start-session mode', () => {
  it('gửi đúng dubbing_and_subtitle khi người dùng chọn thuyết minh và phụ đề', () => {
    const message = createStartSessionMessage({
      tabId: 42,
      mode: 'dubbing_and_subtitle',
      mixerConfig: { originalVolume: 25, originalMuted: false, ttsVolume: 100 },
      wsUrl: 'ws://127.0.0.1:8080'
    });

    expect(message).toEqual({
      type: 'START_SESSION',
      tabId: 42,
      mode: 'dubbing_and_subtitle',
      mixerConfig: { originalVolume: 25, originalMuted: false, ttsVolume: 100 },
      wsUrl: 'ws://127.0.0.1:8080'
    });
  });
});
