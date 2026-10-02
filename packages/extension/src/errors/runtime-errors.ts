/** Phân loại lỗi runtime thành thông báo tiếng Việt kèm gợi ý đúng nguyên nhân. */

export interface ClassifiedError {
  message: string;
  hint: string;
}

/** Thời gian extension chờ backend báo SESSION_READY (backend chờ model tối đa 45 s). */
export const SESSION_READY_TIMEOUT_MS = 60_000;

// Lỗi tạm thời phía backend: bấm thử lại là hợp lý, không cần tải lại trang.
const RETRYABLE_SERVER_CODES = new Set([
  'LOCAL_RUNTIME_WARMING',
  'VIDEO_NAVIGATION',
  'PAGE_RELOADED',
  'CONCURRENT_SESSION_LIMIT',
  'STT_UNAVAILABLE',
  'WS_CONNECTION_TIMEOUT',
  'WS_CONNECTION_FAILED',
  'WS_DISCONNECTED'
]);

export function isRetryableServerError(code: string | undefined): boolean {
  return Boolean(code && RETRYABLE_SERVER_CODES.has(code));
}

export function classifyRuntimeError(rawError: string, code = ''): ClassifiedError {
  const upperCode = code.toUpperCase();
  const lower = `${code} ${rawError || ''}`.toLowerCase();

  if (lower.includes('permission') || lower.includes('notallowed') || lower.includes('tab_capture')) {
    return { message: 'Không có quyền truy cập âm thanh tab.', hint: 'Hãy cấp quyền thu âm tab rồi thử lại.' };
  }
  if (upperCode === 'VIDEO_NOT_FOUND' || lower.includes('không tìm thấy phần tử video') || lower.includes('chưa tìm thấy phần tử video')) {
    return { message: 'Không tìm thấy thẻ video trên trang này.', hint: 'Hãy mở video và bấm Play trước khi bắt đầu.' };
  }
  if (upperCode === 'AUDIO_CONTEXT_BLOCKED') {
    return {
      message: 'Trình duyệt đang chặn âm thanh của trang này.',
      hint: 'Bấm vào video (Play) một lần để cho phép âm thanh, rồi bấm Bắt đầu lại.'
    };
  }
  if (upperCode === 'VIDEO_NAVIGATION') {
    return { message: 'Video trên trang đã thay đổi nên phiên thuyết minh đã dừng.', hint: 'Bấm Thử lại để thuyết minh video hiện tại.' };
  }
  if (upperCode === 'PAGE_RELOADED') {
    return { message: 'Trang video vừa tải lại nên phiên cũ đã kết thúc.', hint: 'Bấm Play rồi bấm Thử lại để bắt đầu phiên mới.' };
  }
  if (upperCode === 'LOCAL_RUNTIME_WARMING') {
    return { message: 'Model AI local đang khởi động.', hint: 'Lần đầu nạp model có thể mất vài chục giây; hãy bấm thử lại sau ít giây.' };
  }
  if (upperCode === 'LOCAL_RUNTIME_NOT_READY' || upperCode === 'PROVIDER_NOT_CONFIGURED') {
    return { message: 'Backend local chưa sẵn sàng.', hint: 'Kiểm tra model/worker (xem log trong thư mục logs cạnh thư mục model) rồi khởi động lại backend.' };
  }
  if (upperCode === 'STT_UNAVAILABLE') {
    return { message: 'Bộ nhận dạng giọng nói local đã ngừng hoạt động.', hint: 'Khởi động lại backend; xem file worker-stt.log để biết lỗi cụ thể.' };
  }
  if (upperCode === 'STT_OVERLOADED' || upperCode === 'PIPELINE_BACKPRESSURE') {
    return { message: 'Máy xử lý AI đang quá tải, một phần lời thoại bị bỏ qua.', hint: 'Đóng bớt ứng dụng nặng hoặc dùng chế độ chỉ phụ đề để giảm tải CPU.' };
  }
  if (upperCode === 'TTS_ERROR') {
    return { message: 'Không tạo được giọng đọc cho một câu.', hint: 'Phụ đề vẫn tiếp tục; nếu lặp lại nhiều lần hãy xem file worker-tts.log.' };
  }
  if (upperCode === 'PIPELINE_ERROR' || upperCode === 'STT_ERROR') {
    return { message: 'Một câu không xử lý được và đã được bỏ qua.', hint: 'Phiên vẫn tiếp tục chạy.' };
  }
  if (upperCode === 'BUDGET_OR_RATE_LIMIT') {
    return { message: 'Phiên đã chạm giới hạn thời lượng hoặc tốc độ gửi audio.', hint: 'Bấm Bắt đầu để mở phiên mới.' };
  }
  if (upperCode === 'CONCURRENT_SESSION_LIMIT') {
    return { message: 'Backend đang xử lý quá nhiều phiên.', hint: 'Dừng phiên ở tab khác rồi thử lại.' };
  }
  if (
    upperCode.startsWith('WS_') ||
    lower.includes('websocket') ||
    lower.includes('econnrefused') ||
    lower.includes('máy chủ')
  ) {
    return { message: 'Không thể kết nối máy chủ AI.', hint: 'Kiểm tra backend local đang chạy (cổng 8080) rồi thử lại.' };
  }
  return {
    message: rawError || 'Đã xảy ra lỗi không xác định.',
    hint: 'Hãy bấm Dừng rồi Bắt đầu lại; nếu vẫn lỗi, khởi động lại backend và extension.'
  };
}
