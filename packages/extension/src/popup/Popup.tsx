import React, { useEffect, useRef, useState } from 'react';
import { DEFAULT_MODE, DEFAULT_ORIGINAL_VOLUME, DEFAULT_TTS_VOLUME, OperationMode, SessionState } from '@vietdub/shared';
import { createStartSessionMessage } from './start-session-message.js';
import { classifyRuntimeError } from '../errors/runtime-errors.js';
import { BackendState, LaunchFailure, launchBackend, probeBackend, waitUntilReady } from '../backend/backend-launcher.js';

// Cảnh báo cũ hơn ngưỡng này không còn phản ánh tình trạng hiện tại.
const WARNING_VISIBLE_MS = 30_000;

export const Popup: React.FC = () => {
  const configuredBackendUrl = new URLSearchParams(window.location.search).get('wsUrl') || undefined;
  const [sessionState, setSessionState] = useState<SessionState>('IDLE');
  const [hasVideo, setHasVideo] = useState<boolean>(false);
  const [statusText, setStatusText] = useState<string>('Sẵn sàng');
  const [mode, setMode] = useState<OperationMode>(DEFAULT_MODE);
  const [originalVolume, setOriginalVolume] = useState<number>(DEFAULT_ORIGINAL_VOLUME);
  const [originalMuted, setOriginalMuted] = useState<boolean>(false);
  const [ttsVolume, setTtsVolume] = useState<number>(DEFAULT_TTS_VOLUME);
  const [activeTabId, setActiveTabId] = useState<number | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [errorHint, setErrorHint] = useState<string | null>(null);
  const [canRetry, setCanRetry] = useState<boolean>(false);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [warningText, setWarningText] = useState<string | null>(null);
  // checking: đang thăm dò; launching: đã nhờ host bật, đang chờ model nạp xong.
  const [backendState, setBackendState] = useState<BackendState | 'checking' | 'launching'>('checking');
  const [launchFailure, setLaunchFailure] = useState<LaunchFailure | null>(null);
  const launchCancelledRef = useRef(false);
  const activeSessionIdRef = useRef<string | null>(null);

  const classifyError = classifyRuntimeError;

  const isRetryableError = (rawError: string, code: string, retryable: boolean): boolean => {
    const lower = `${code} ${rawError || ''}`.toLowerCase();
    // Permission và thiếu video cần người dùng sửa tab/quyền, không được retry ngầm từ popup.
    if (lower.includes('permission') || lower.includes('notallowed') || lower.includes('video_not_found') || lower.includes('không tìm thấy')) {
      return false;
    }
    return retryable;
  };

  const checkVideoInTab = (tabId: number) => {
    chrome.tabs.sendMessage(tabId, { type: 'CHECK_VIDEO' }, (res) => {
      if (chrome.runtime.lastError || !res) {
        // Popup chỉ đọc trạng thái; việc inject thuộc trách nhiệm của background.
        setHasVideo(false);
      } else {
        setHasVideo(res.hasVideo === true);
      }
    });
  };

  const stateText = (state: SessionState): string => {
    switch (state) {
      case 'INITIALIZING': return 'Đang chuẩn bị...';
      case 'READY': return 'Đã sẵn sàng';
      case 'CONNECTING': return 'Đang kết nối / nạp model...';
      case 'ACTIVE': return 'Đang thuyết minh';
      case 'STOPPING': return 'Đang dừng...';
      case 'ERROR': return 'Lỗi kết nối';
      default: return 'Sẵn sàng';
    }
  };

  const applySnapshot = (snapshot: any) => {
    const state = (snapshot?.state || (snapshot?.isCapturing ? 'ACTIVE' : 'IDLE')) as SessionState;
    setSessionState(state);
    setStatusText(stateText(state));
    activeSessionIdRef.current = snapshot?.sessionId || null;
    if (snapshot?.mode) setMode(snapshot.mode);
    if (snapshot?.mixerConfig) {
      setOriginalVolume(snapshot.mixerConfig.originalVolume);
      setOriginalMuted(snapshot.mixerConfig.originalMuted);
      setTtsVolume(snapshot.mixerConfig.ttsVolume);
    }
    if (state !== 'ACTIVE') setLatencyMs(null);
    const warning = snapshot?.warning;
    if (state === 'ACTIVE' && warning && Date.now() - (warning.at || 0) < WARNING_VISIBLE_MS) {
      const classified = classifyError(warning.message, warning.code);
      setWarningText(`${classified.message} ${classified.hint}`);
    } else {
      setWarningText(null);
    }
    if (snapshot?.error) {
      const classified = classifyError(snapshot.error.message, snapshot.error.code);
      setErrorMessage(classified.message);
      setErrorHint(classified.hint);
      setCanRetry(isRetryableError(snapshot.error.message, snapshot.error.code || '', snapshot.error.retryable === true));
    } else if (state !== 'ERROR') {
      setErrorMessage(null);
      setErrorHint(null);
      setCanRetry(false);
    }
  };

  useEffect(() => {
    let disposed = false;
    // Popup chỉ đọc tab hiện tại; background mới có quyền điều phối injection.
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (disposed || tabs.length === 0 || !tabs[0].id) return;
      const tabId = tabs[0].id;
      setActiveTabId(tabId);
      checkVideoInTab(tabId);
      chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (snapshot) => {
        if (!disposed && snapshot) applySnapshot(snapshot);
      });
    });

    const messageListener = (msg: any) => {
      if (msg.type === 'SESSION_STATE') applySnapshot(msg);
      if (msg.type === 'LATENCY_METRIC' && (!msg.sessionId || msg.sessionId === activeSessionIdRef.current)) {
        // Ưu tiên độ trễ thật so với video; totalPipelineMs không tính thời gian gom câu.
        const lag = Number.isFinite(msg.videoLagMs) ? msg.videoLagMs : msg.totalPipelineMs;
        if (Number.isFinite(lag) && lag > 0) setLatencyMs(Math.round(lag));
      }
      if (msg.type === 'ERROR' && msg.fatal && (!msg.sessionId || msg.sessionId === activeSessionIdRef.current)) {
        const classified = classifyError(msg.message, msg.code);
        setSessionState('ERROR');
        setStatusText('Lỗi kết nối');
        setErrorMessage(classified.message);
        setErrorHint(classified.hint);
        setCanRetry(isRetryableError(msg.message || '', msg.code || '', msg.retryable === true));
        setLatencyMs(null);
      }
    };
    chrome.runtime.onMessage.addListener(messageListener);

    return () => {
      disposed = true;
      chrome.runtime.onMessage.removeListener(messageListener);
    };
  }, []);

  useEffect(() => {
    launchCancelledRef.current = false;
    void probeBackend().then(state => {
      if (!launchCancelledRef.current) setBackendState(current => (current === 'checking' ? state : current));
    });
    return () => {
      launchCancelledRef.current = true;
    };
  }, []);

  // Nhờ native host bật backend rồi chờ tới khi sẵn sàng (nạp model ~1-2 phút). Đóng popup thì thôi chờ, backend vẫn chạy tiếp.
  const handleLaunchBackend = async () => {
    if (backendState === 'launching') return;
    setLaunchFailure(null);
    setBackendState('launching');
    const result = await launchBackend();
    if (!result.ok) {
      setLaunchFailure(result.reason);
      setBackendState('down');
      return;
    }
    const ready = await waitUntilReady({
      probe: () => probeBackend(),
      isCancelled: () => launchCancelledRef.current,
      onState: state => {
        if (state === 'ready') setBackendState('ready');
      }
    });
    if (launchCancelledRef.current) return;
    if (!ready) {
      setLaunchFailure('host-error');
      setBackendState('down');
    }
  };

  const backendStatus = ((): string => {
    switch (backendState) {
      case 'ready': return 'Backend local sẵn sàng';
      case 'warming': return 'Backend local đang nạp model hoặc chưa sẵn sàng — đợi một lúc rồi mở lại popup';
      case 'launching': return 'Đang bật backend và nạp model (khoảng 1–2 phút)...';
      case 'down': return 'Chưa kết nối backend local';
      default: return 'Đang kiểm tra backend local...';
    }
  })();
  const launchFailureText = ((): string | null => {
    switch (launchFailure) {
      case 'host-missing': return 'Chưa cài trình hỗ trợ bật backend. Chạy một lần: powershell -ExecutionPolicy Bypass -File runtime/install_native_host.ps1 rồi mở lại popup.';
      case 'forbidden': return 'Trình hỗ trợ không cho extension này gọi (ID extension đã đổi). Chạy lại runtime/install_native_host.ps1.';
      case 'script-missing': return 'Không tìm thấy runtime/start_backend.ps1. Chạy lại runtime/install_native_host.ps1 từ thư mục dự án.';
      case 'host-error': return 'Không bật được backend hoặc model chưa nạp xong sau 4 phút. Xem E:\\VietDub-AI\\logs\\backend.log.';
      default: return null;
    }
  })();

  const sendExtensionMessage = <T,>(message: unknown): Promise<T> => {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(response as T);
      });
    });
  };

  const handleStart = async () => {
    if (activeTabId === null) return;
    if (['INITIALIZING', 'READY', 'CONNECTING', 'ACTIVE', 'STOPPING'].includes(sessionState)) return;
    setSessionState('INITIALIZING');
    setStatusText('Đang chuẩn bị...');
    setErrorMessage(null);
    setErrorHint(null);
    setCanRetry(false);
    try {
      const response: any = await sendExtensionMessage(createStartSessionMessage({
        tabId: activeTabId,
        mode,
        mixerConfig: { originalVolume, originalMuted, ttsVolume },
        // Cho phép smoke test dùng cổng động; người dùng bình thường dùng backend mặc định.
        wsUrl: configuredBackendUrl
      }));
      if (!response?.success) {
        const error = new Error(response?.error || 'Không thể bắt đầu phiên') as Error & { code?: string; retryable?: boolean };
        error.code = response?.code;
        error.retryable = response?.retryable === true;
        throw error;
      }
    } catch (error: any) {
      const classified = classifyError(error?.message || '', error?.code || '');
      setSessionState('ERROR');
      setStatusText('Lỗi kết nối');
      setErrorMessage(classified.message);
      setErrorHint(classified.hint);
      setCanRetry(isRetryableError(error?.message || '', error?.code || '', error?.retryable === true));
      setLatencyMs(null);
    }
  };

  const handleStop = async () => {
    setSessionState('STOPPING');
    setStatusText('Đang dừng...');
    try {
      const response: any = await sendExtensionMessage({ type: 'STOP_SESSION' });
      if (!response?.success) throw new Error(response?.error || 'Không thể dừng phiên');
      activeSessionIdRef.current = null;
      setSessionState('IDLE');
      setStatusText('Sẵn sàng');
      setCanRetry(false);
      setLatencyMs(null);
    } catch (error: any) {
      const classified = classifyError(error?.message || '', 'STOP_FAILED');
      setSessionState('ERROR');
      setStatusText('Lỗi kết nối');
      setErrorMessage(classified.message);
      setErrorHint(classified.hint);
      setCanRetry(false);
    }
  };

  const handleModeSelect = (newMode: OperationMode) => {
    setMode(newMode);
    if (sessionState === 'ACTIVE') {
      void sendExtensionMessage({ type: 'CHANGE_MODE', mode: newMode }).catch((error) => {
        console.warn('[POPUP] mode change failed', String(error));
      });
    }
  };

  const handleOriginalVolumeChange = (val: number) => {
    setOriginalVolume(val);
    if (sessionState === 'ACTIVE') {
      void sendExtensionMessage({
        type: 'UPDATE_MIXER_CONFIG',
        config: { originalVolume: val }
      }).catch((error) => console.warn('[POPUP] mixer update failed', String(error)));
    }
  };

  const handleOriginalMuteToggle = (muted: boolean) => {
    setOriginalMuted(muted);
    if (sessionState === 'ACTIVE') {
      void sendExtensionMessage({
        type: 'UPDATE_MIXER_CONFIG',
        config: { originalMuted: muted }
      }).catch((error) => console.warn('[POPUP] mixer update failed', String(error)));
    }
  };

  const handleTtsVolumeChange = (val: number) => {
    setTtsVolume(val);
    if (sessionState === 'ACTIVE') {
      void sendExtensionMessage({
        type: 'UPDATE_MIXER_CONFIG',
        config: { ttsVolume: val }
      }).catch((error) => console.warn('[POPUP] mixer update failed', String(error)));
    }
  };

  return (
    <div style={styles.container}>
      {/* Header */}
      <div style={styles.header}>
        <h1 style={styles.title}>VietDub AI</h1>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          {sessionState === 'ACTIVE' && latencyMs !== null && (
            <div style={styles.latencyBadge}>⚡ {latencyMs}ms</div>
          )}
          <div style={styles.badge(sessionState)}>{statusText}</div>
        </div>
      </div>
      <div style={styles.subHeader}>Thuyết minh tiếng Việt theo thời gian thực</div>
      <div style={styles.privacyNotice}>
        AI mặc định chạy offline trên máy của bạn sau khi model local được cài đặt. Không cần API key; dừng phiên sẽ ngắt truyền dữ liệu.
      </div>
      <div style={styles.backendStatus}>{backendStatus}</div>
      {(backendState === 'down' || backendState === 'launching') && (
        <div style={{ marginBottom: 12 }}>
          <button
            type="button"
            style={backendState === 'launching' ? styles.btnDisabled : styles.btnLaunch}
            disabled={backendState === 'launching'}
            onClick={handleLaunchBackend}
          >
            {backendState === 'launching' ? 'Đang bật backend...' : '▶ Bật backend'}
          </button>
          {launchFailureText && <div style={styles.launchFailure} role="alert">{launchFailureText}</div>}
        </div>
      )}

      {/* Video Detection Notice */}
      {!hasVideo && (
        <div style={styles.alertWarning}>
          <div>⚠️ Chưa phát hiện video trong tab này.</div>
          <div style={{ marginTop: 6, fontSize: 11, color: '#fef08a', lineHeight: 1.4 }}>
            💡 <b>Mẹo:</b> Nếu tab YouTube đã mở trước khi nạp Extension, hãy bấm <b>Tải lại trang (F5)</b> hoặc bấm Play video.
          </div>
          {activeTabId && (
            <div style={{ marginTop: 8, display: 'flex', gap: 6 }}>
              <button
                type="button"
                style={{
                  padding: '4px 10px',
                  backgroundColor: '#854d0e',
                  color: '#fff',
                  border: 'none',
                  borderRadius: 4,
                  cursor: 'pointer',
                  fontSize: 11,
                  fontWeight: 600
                }}
                onClick={() => {
                  chrome.tabs.reload(activeTabId);
                  window.close();
                }}
              >
                🔄 Tải lại trang (F5)
              </button>
              <button
                type="button"
                style={{
                  padding: '4px 10px',
                  backgroundColor: '#3f3f46',
                  color: '#fff',
                  border: 'none',
                  borderRadius: 4,
                  cursor: 'pointer',
                  fontSize: 11
                }}
                onClick={() => {
                  if (activeTabId !== null) checkVideoInTab(activeTabId);
                }}
              >
                🔍 Quét lại
              </button>
            </div>
          )}
        </div>
      )}

      {warningText && !errorMessage && (
        <div style={styles.alertWarning} role="status">
          ⚠️ {warningText}
        </div>
      )}

      {errorMessage && (
        <div style={styles.alertError}>
          <div style={{ fontWeight: 600 }}>❌ {errorMessage}</div>
          {errorHint && <div style={styles.errorHint}>💡 {errorHint}</div>}
          {canRetry && <div style={{ marginTop: 8 }}>
            <button
              type="button"
              style={styles.btnRetry}
              onClick={handleStart}
            >
              🔄 Thử lại
            </button>
          </div>}
        </div>
      )}

      {/* Mode Selection */}
      <div style={styles.section}>
        <div style={styles.sectionTitle}>Chế độ hoạt động</div>
        <div style={styles.modeButtonGroup}>
          <button
            style={styles.modeButton(mode === 'dubbing_only')}
            onClick={() => handleModeSelect('dubbing_only')}
          >
            Chỉ thuyết minh
          </button>
          <button
            style={styles.modeButton(mode === 'subtitle_only')}
            onClick={() => handleModeSelect('subtitle_only')}
          >
            Chỉ phụ đề
          </button>
          <button
            style={styles.modeButton(mode === 'dubbing_and_subtitle')}
            onClick={() => handleModeSelect('dubbing_and_subtitle')}
          >
            Thuyết minh + phụ đề
          </button>
        </div>
      </div>

      {/* Audio Mixer */}
      <div style={styles.section}>
        <div style={styles.sectionTitle}>Bộ trộn âm thanh</div>

        {/* Original Video Volume */}
        <div style={styles.sliderGroup}>
          <div style={styles.sliderLabelRow}>
            <span>Âm thanh video gốc</span>
            <span style={styles.valText}>{originalMuted ? '0%' : `${originalVolume}%`}</span>
          </div>
          <input
            type="range"
            min="0"
            max="100"
            value={originalMuted ? 0 : originalVolume}
            disabled={originalMuted}
            onChange={(e) => handleOriginalVolumeChange(Number(e.target.value))}
            style={styles.slider}
          />
          <label style={styles.checkboxRow}>
            <input
              type="checkbox"
              checked={originalMuted}
              onChange={(e) => handleOriginalMuteToggle(e.target.checked)}
            />
            <span style={{ marginLeft: 6 }}>Tắt hoàn toàn âm thanh gốc</span>
          </label>
        </div>

        {/* TTS Dubbing Volume */}
        <div style={styles.sliderGroup}>
          <div style={styles.sliderLabelRow}>
            <span>Âm lượng thuyết minh</span>
            <span style={styles.valText}>{ttsVolume}%</span>
          </div>
          <input
            type="range"
            min="0"
            max="100"
            value={ttsVolume}
            onChange={(e) => handleTtsVolumeChange(Number(e.target.value))}
            style={styles.slider}
          />
        </div>
      </div>

      {/* Action Button */}
      <div style={styles.actionContainer}>
        {sessionState === 'ACTIVE' ? (
          <button style={styles.btnDanger} onClick={handleStop}>
            Dừng thuyết minh
          </button>
        ) : sessionState === 'STOPPING' ? (
          <button style={styles.btnDisabled} disabled>
            {statusText}
          </button>
        ) : sessionState === 'INITIALIZING' || sessionState === 'READY' || sessionState === 'CONNECTING' ? (
          <button style={styles.btnDanger} onClick={handleStop}>
            Hủy khởi tạo
          </button>
        ) : (
          <button
            style={styles.btnPrimary}
            onClick={handleStart}
            disabled={activeTabId === null}
          >
            Bắt đầu thuyết minh
          </button>
        )}
      </div>
    </div>
  );
};

const styles: Record<string, any> = {
  container: {
    width: 340,
    padding: '16px 20px',
    backgroundColor: '#18181b',
    color: '#f4f4f5',
    fontFamily: 'system-ui, -apple-system, sans-serif',
    boxSizing: 'border-box'
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center'
  },
  title: {
    fontSize: 20,
    fontWeight: 700,
    margin: 0,
    color: '#38bdf8'
  },
  latencyBadge: {
    fontSize: 11,
    padding: '3px 6px',
    borderRadius: 6,
    backgroundColor: '#064e3b',
    color: '#34d399',
    fontWeight: 600
  },
  badge: (state: SessionState) => {
    switch (state) {
      case 'ACTIVE':
        return {
          fontSize: 11,
          padding: '3px 8px',
          borderRadius: 12,
          backgroundColor: '#166534',
          color: '#4ade80',
          fontWeight: 600
        };
      case 'INITIALIZING':
      case 'READY':
      case 'CONNECTING':
      case 'STOPPING':
        return {
          fontSize: 11,
          padding: '3px 8px',
          borderRadius: 12,
          backgroundColor: '#854d0e',
          color: '#fef08a',
          fontWeight: 600
        };
      case 'ERROR':
        return {
          fontSize: 11,
          padding: '3px 8px',
          borderRadius: 12,
          backgroundColor: '#7f1d1d',
          color: '#fca5a5',
          fontWeight: 600
        };
      case 'IDLE':
      default:
        return {
          fontSize: 11,
          padding: '3px 8px',
          borderRadius: 12,
          backgroundColor: '#3f3f46',
          color: '#a1a1aa',
          fontWeight: 600
        };
    }
  },
  subHeader: {
    fontSize: 12,
    color: '#71717a',
    marginTop: 4,
    marginBottom: 14
  },
  privacyNotice: {
    fontSize: 10,
    lineHeight: 1.4,
    color: '#a1a1aa',
    border: '1px solid #3f3f46',
    borderRadius: 6,
    padding: '7px 8px',
    marginBottom: 12
  },
  backendStatus: {
    fontSize: 11,
    lineHeight: 1.3,
    color: '#a1a1aa',
    marginBottom: 12
  },
  btnLaunch: {
    width: '100%',
    padding: '8px 12px',
    backgroundColor: '#2563eb',
    color: '#fff',
    border: 'none',
    borderRadius: 6,
    cursor: 'pointer',
    fontSize: 12,
    fontWeight: 600
  },
  launchFailure: {
    marginTop: 6,
    fontSize: 11,
    lineHeight: 1.4,
    color: '#fed7aa'
  },
  alertWarning: {
    backgroundColor: '#422006',
    border: '1px solid #854d0e',
    color: '#fef08a',
    fontSize: 12,
    padding: 8,
    borderRadius: 6,
    marginBottom: 12
  },
  alertError: {
    backgroundColor: '#450a0a',
    border: '1px solid #991b1b',
    color: '#fca5a5',
    fontSize: 12,
    padding: 10,
    borderRadius: 6,
    marginBottom: 12
  },
  errorHint: {
    marginTop: 6,
    fontSize: 11,
    color: '#fed7aa',
    lineHeight: 1.4
  },
  btnRetry: {
    padding: '4px 10px',
    backgroundColor: '#991b1b',
    color: '#fff',
    border: 'none',
    borderRadius: 4,
    cursor: 'pointer',
    fontSize: 11,
    fontWeight: 600
  },
  section: {
    marginBottom: 16
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: 600,
    color: '#d4d4d8',
    marginBottom: 8
  },
  modeButtonGroup: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6
  },
  modeButton: (active: boolean) => ({
    padding: '7px 10px',
    fontSize: 12,
    fontWeight: 500,
    border: active ? '1px solid #38bdf8' : '1px solid #3f3f46',
    borderRadius: 6,
    backgroundColor: active ? '#0369a1' : '#27272a',
    color: active ? '#ffffff' : '#a1a1aa',
    cursor: 'pointer',
    textAlign: 'left' as const,
    transition: 'all 0.15s ease'
  }),
  sliderGroup: {
    marginBottom: 10
  },
  sliderLabelRow: {
    display: 'flex',
    justifyContent: 'space-between',
    fontSize: 12,
    color: '#a1a1aa',
    marginBottom: 4
  },
  valText: {
    color: '#38bdf8',
    fontWeight: 600
  },
  slider: {
    width: '100%',
    accentColor: '#38bdf8',
    cursor: 'pointer'
  },
  checkboxRow: {
    display: 'flex',
    alignItems: 'center',
    fontSize: 11,
    color: '#a1a1aa',
    marginTop: 4,
    cursor: 'pointer'
  },
  actionContainer: {
    marginTop: 18
  },
  btnPrimary: {
    width: '100%',
    padding: '10px 0',
    backgroundColor: '#0284c7',
    color: '#ffffff',
    border: 'none',
    borderRadius: 8,
    fontSize: 14,
    fontWeight: 600,
    cursor: 'pointer'
  },
  btnDanger: {
    width: '100%',
    padding: '10px 0',
    backgroundColor: '#dc2626',
    color: '#ffffff',
    border: 'none',
    borderRadius: 8,
    fontSize: 14,
    fontWeight: 600,
    cursor: 'pointer'
  },
  btnDisabled: {
    width: '100%',
    padding: '10px 0',
    backgroundColor: '#3f3f46',
    color: '#a1a1aa',
    border: 'none',
    borderRadius: 8,
    fontSize: 14,
    fontWeight: 600,
    cursor: 'not-allowed'
  }
};
