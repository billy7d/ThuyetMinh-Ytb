import React, { useState, useEffect } from 'react';
import { OperationMode, AudioMixerConfig, DEFAULT_MODE, DEFAULT_ORIGINAL_VOLUME, DEFAULT_TTS_VOLUME } from '@vietdub/shared';

type SessionState = 'IDLE' | 'INITIALIZING' | 'ACTIVE' | 'STOPPING' | 'ERROR';

export const Popup: React.FC = () => {
  const [sessionState, setSessionState] = useState<SessionState>('IDLE');
  const [hasVideo, setHasVideo] = useState<boolean>(true);
  const [videoTitle, setVideoTitle] = useState<string>('');
  const [statusText, setStatusText] = useState<string>('Sẵn sàng');
  const [mode, setMode] = useState<OperationMode>(DEFAULT_MODE);
  const [originalVolume, setOriginalVolume] = useState<number>(DEFAULT_ORIGINAL_VOLUME);
  const [originalMuted, setOriginalMuted] = useState<boolean>(false);
  const [ttsVolume, setTtsVolume] = useState<number>(DEFAULT_TTS_VOLUME);
  const [activeTabId, setActiveTabId] = useState<number | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [errorHint, setErrorHint] = useState<string | null>(null);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);

  // Helper to categorize errors and provide actionable hints
  const classifyError = (rawError: string): { message: string; hint: string } => {
    const lower = (rawError || '').toLowerCase();
    if (
      lower.includes('localhost:8080') ||
      lower.includes('websocket') ||
      lower.includes('econnrefused') ||
      lower.includes('máy chủ ai') ||
      lower.includes('timeout') ||
      lower.includes('closed before')
    ) {
      return {
        message: 'Không thể kết nối máy chủ AI (ws://localhost:8080).',
        hint: 'Vui lòng mở terminal trong thư mục dự án và chạy: npm run dev:server'
      };
    }
    if (lower.includes('video') || lower.includes('không tìm thấy')) {
      return {
        message: 'Không tìm thấy thẻ video trên trang này.',
        hint: 'Hãy mở video YouTube và bấm Play để bắt đầu.'
      };
    }
    if (lower.includes('tabcapture') || lower.includes('permission') || lower.includes('notallowederror')) {
      return {
        message: 'Không có quyền truy cập âm thanh tab.',
        hint: 'Vui lòng cấp quyền thu âm tab trong trình duyệt và thử lại.'
      };
    }
    return {
      message: rawError || 'Đã xảy ra lỗi không xác định.',
      hint: 'Hãy thử tải lại trang (F5) hoặc khởi động lại extension.'
    };
  };

  const checkVideoInTab = (tabId: number, isKnownVideo: boolean, attempt = 1) => {
    chrome.tabs.sendMessage(tabId, { type: 'CHECK_VIDEO' }, (res) => {
      if (chrome.runtime.lastError || !res) {
        if (attempt === 1) {
          const scripting = (chrome as any).scripting;
          if (scripting?.executeScript) {
            scripting.executeScript({
              target: { tabId },
              files: ['content/content.js']
            }).then(() => {
              setTimeout(() => checkVideoInTab(tabId, isKnownVideo, 2), 400);
            }).catch(() => {
              setHasVideo(isKnownVideo);
            });
            return;
          } else if ((chrome.tabs as any).executeScript) {
            (chrome.tabs as any).executeScript(tabId, { file: 'content/content.js' }, () => {
              setTimeout(() => checkVideoInTab(tabId, isKnownVideo, 2), 400);
            });
            return;
          }
        }
        setHasVideo(isKnownVideo);
      } else {
        setHasVideo(res.hasVideo || isKnownVideo);
        if (res.videoTitle) setVideoTitle(res.videoTitle);
      }
    });
  };

  useEffect(() => {
    // 1. Get active tab info
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs.length > 0 && tabs[0].id) {
        const tabId = tabs[0].id;
        const tabUrl = tabs[0].url || '';
        const tabTitle = tabs[0].title || '';
        setActiveTabId(tabId);
        if (tabTitle) setVideoTitle(tabTitle);

        const isKnownVideo = tabUrl.includes('youtube.com') ||
          tabUrl.includes('youtu.be') ||
          tabUrl.includes('vimeo.com') ||
          tabUrl.includes('bilibili.com');

        checkVideoInTab(tabId, isKnownVideo, 1);

        // Query session status from background
        chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (res) => {
          if (res) {
            if (res.isCapturing) {
              setSessionState('ACTIVE');
              setStatusText('Đang thuyết minh');
            } else {
              setSessionState('IDLE');
              setStatusText('Sẵn sàng');
            }
            if (res.mode) setMode(res.mode);
            if (res.mixerConfig) {
              setOriginalVolume(res.mixerConfig.originalVolume);
              setOriginalMuted(res.mixerConfig.originalMuted);
              setTtsVolume(res.mixerConfig.ttsVolume);
            }
          }
        });
      }
    });

    // 2. Listen for latency metrics & session state updates
    const messageListener = (msg: any) => {
      if (msg.type === 'LATENCY_METRIC' && msg.totalPipelineMs) {
        setLatencyMs(Math.round(msg.totalPipelineMs));
      }
      if (msg.type === 'ERROR' && msg.fatal) {
        setSessionState('ERROR');
        const classified = classifyError(msg.message);
        setErrorMessage(classified.message);
        setErrorHint(classified.hint);
        setStatusText('Lỗi kết nối');
      }
    };
    chrome.runtime.onMessage.addListener(messageListener);

    return () => {
      chrome.runtime.onMessage.removeListener(messageListener);
    };
  }, []);

  const executeStart = (tabId: number, retryAttempt = 0): Promise<void> => {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        {
          type: 'START_SESSION',
          tabId,
          mode,
          mixerConfig: { originalVolume, originalMuted, ttsVolume }
        },
        (res) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else if (res?.success) {
            resolve();
          } else {
            reject(new Error(res?.error || 'Không thể bắt đầu phiên'));
          }
        }
      );
    });
  };

  const handleStartWithRetry = async () => {
    if (!activeTabId) return;
    setSessionState('INITIALIZING');
    setStatusText('Đang kết nối...');
    setErrorMessage(null);
    setErrorHint(null);

    // Step 1: Ensure content script injection if possible
    const scripting = (chrome as any).scripting;
    if (scripting?.executeScript) {
      try {
        await scripting.executeScript({
          target: { tabId: activeTabId },
          files: ['content/content.js']
        });
      } catch {
        // Content script might already exist or restricted page
      }
    }

    // Step 2: Retry loop (up to 3 attempts with backoff)
    const MAX_ATTEMPTS = 3;
    let lastErr: any = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        if (attempt > 1) {
          setStatusText(`Đang thử lại lần ${attempt}/${MAX_ATTEMPTS}...`);
          await new Promise((r) => setTimeout(r, 400 * Math.pow(2, attempt - 2)));
        }
        await executeStart(activeTabId, attempt);
        setSessionState('ACTIVE');
        setStatusText('Đang thuyết minh');
        return;
      } catch (err: any) {
        lastErr = err;
        console.warn(`[POPUP] Start attempt ${attempt} failed:`, err);
      }
    }

    // All attempts failed
    setSessionState('ERROR');
    setStatusText('Lỗi kết nối');
    const classified = classifyError(lastErr?.message || '');
    setErrorMessage(classified.message);
    setErrorHint(classified.hint);
  };

  const handleStop = () => {
    setSessionState('STOPPING');
    setStatusText('Đang dừng...');
    chrome.runtime.sendMessage({ type: 'STOP_SESSION' }, () => {
      setSessionState('IDLE');
      setStatusText('Sẵn sàng');
      setLatencyMs(null);
    });
  };

  const handleModeSelect = (newMode: OperationMode) => {
    setMode(newMode);
    if (sessionState === 'ACTIVE') {
      chrome.runtime.sendMessage({ type: 'CHANGE_MODE', mode: newMode });
    }
  };

  const handleOriginalVolumeChange = (val: number) => {
    setOriginalVolume(val);
    if (sessionState === 'ACTIVE') {
      chrome.runtime.sendMessage({
        type: 'UPDATE_MIXER_CONFIG',
        config: { originalVolume: val }
      });
    }
  };

  const handleOriginalMuteToggle = (muted: boolean) => {
    setOriginalMuted(muted);
    if (sessionState === 'ACTIVE') {
      chrome.runtime.sendMessage({
        type: 'UPDATE_MIXER_CONFIG',
        config: { originalMuted: muted }
      });
    }
  };

  const handleTtsVolumeChange = (val: number) => {
    setTtsVolume(val);
    if (sessionState === 'ACTIVE') {
      chrome.runtime.sendMessage({
        type: 'UPDATE_MIXER_CONFIG',
        config: { ttsVolume: val }
      });
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
                  if (activeTabId) checkVideoInTab(activeTabId, true, 1);
                }}
              >
                🔍 Quét lại
              </button>
            </div>
          )}
        </div>
      )}

      {errorMessage && (
        <div style={styles.alertError}>
          <div style={{ fontWeight: 600 }}>❌ {errorMessage}</div>
          {errorHint && <div style={styles.errorHint}>💡 {errorHint}</div>}
          <div style={{ marginTop: 8 }}>
            <button
              type="button"
              style={styles.btnRetry}
              onClick={handleStartWithRetry}
            >
              🔄 Thử lại
            </button>
          </div>
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
        ) : sessionState === 'INITIALIZING' || sessionState === 'STOPPING' ? (
          <button style={styles.btnDisabled} disabled>
            {statusText}
          </button>
        ) : (
          <button
            style={styles.btnPrimary}
            onClick={handleStartWithRetry}
            disabled={!hasVideo && !videoTitle.toLowerCase().includes('youtube')}
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
