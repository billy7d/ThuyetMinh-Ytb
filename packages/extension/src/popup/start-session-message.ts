import { AudioMixerConfig, OperationMode } from '@vietdub/shared';

export interface PopupStartSessionInput {
  tabId: number;
  mode: OperationMode;
  mixerConfig: AudioMixerConfig;
  wsUrl?: string;
}

export interface PopupStartSessionMessage {
  type: 'START_SESSION';
  tabId: number;
  mode: OperationMode;
  mixerConfig: AudioMixerConfig;
  wsUrl?: string;
}

/** Tạo payload duy nhất để Popup gửi chế độ đã chọn tới background. */
export function createStartSessionMessage(
  input: PopupStartSessionInput
): PopupStartSessionMessage {
  return {
    type: 'START_SESSION',
    tabId: input.tabId,
    mode: input.mode,
    mixerConfig: { ...input.mixerConfig },
    wsUrl: input.wsUrl
  };
}
