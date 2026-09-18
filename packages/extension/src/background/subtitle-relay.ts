import { SubtitleEventMessage } from '@vietdub/shared';

export interface SubtitleRelayTarget {
  sessionId: string | null;
  tabId: number | null;
  send: (tabId: number, message: SubtitleEventMessage) => Promise<unknown>;
}

/** Chỉ chuyển subtitle của phiên hiện tại tới đúng tab đang phát video. */
export async function relaySubtitleEvent(
  message: SubtitleEventMessage,
  target: SubtitleRelayTarget
): Promise<boolean> {
  if (target.sessionId !== message.sessionId || target.tabId === null) return false;
  await target.send(target.tabId, message);
  return true;
}
