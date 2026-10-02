/**
 * Đảm bảo AudioContext đang chạy, nhưng không bao giờ chờ vô hạn.
 *
 * Firefox chặn AudioContext (autoplay policy) cho tới khi người dùng thao tác trên chính trang đó; bấm nút trong popup
 * extension không tính. Khi bị chặn, `resume()` trả về Promise không bao giờ hoàn thành: phiên kẹt mãi ở trạng thái
 * "Đang kết nối", trông như backend/model lỗi. Hàm này chờ tối đa `timeoutMs` rồi báo lỗi rõ ràng.
 */

export const AUDIO_CONTEXT_RESUME_TIMEOUT_MS = 3_000;

export class AudioContextBlockedError extends Error {
  readonly code = 'AUDIO_CONTEXT_BLOCKED';

  constructor() {
    super('Trình duyệt đang chặn âm thanh của trang cho tới khi bạn tương tác với trang.');
    this.name = 'AudioContextBlockedError';
  }
}

export async function ensureAudioContextRunning(
  context: Pick<AudioContext, 'state' | 'resume'>,
  timeoutMs = AUDIO_CONTEXT_RESUME_TIMEOUT_MS
): Promise<void> {
  const isRunning = (): boolean => context.state === 'running';
  if (isRunning()) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const resumed = await Promise.race([
      context.resume().then(() => true, () => false),
      new Promise<boolean>(resolve => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      })
    ]);
    if (!resumed || !isRunning()) throw new AudioContextBlockedError();
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
