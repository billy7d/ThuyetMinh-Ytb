import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import {
  ensureExtensionBuild,
  startBackend,
  startChromeExtension,
  startFixtureServer,
  type RunningBackend,
  type RunningChromeExtension,
  type RunningHttpServer
} from './support/test-environment.js';

const extensionRoot = path.resolve(process.cwd(), '../extension');
const fixturePath = path.join(extensionRoot, '..', 'tests', 'src', 'spike', 'test-page.html');

async function sendRuntimeMessage<T>(page: Page, message: unknown): Promise<T> {
  return page.evaluate((request) => new Promise<T>((resolve, reject) => {
    chrome.runtime.sendMessage(request, (response) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(response as T);
    });
  }), message);
}

async function getActiveTabId(page: Page): Promise<number> {
  return page.evaluate(() => new Promise<number>((resolve, reject) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else if (!tabs[0]?.id) reject(new Error('Không tìm thấy tab video đang hoạt động.'));
      else resolve(tabs[0].id);
    });
  }));
}

async function pingActiveContent(page: Page): Promise<any> {
  return page.evaluate(() => new Promise((resolve, reject) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (chrome.runtime.lastError || !tabs[0]?.id) {
        reject(new Error(chrome.runtime.lastError?.message || 'Không tìm thấy tab video.'));
        return;
      }
      chrome.tabs.sendMessage(tabs[0].id, { type: 'CONTENT_PING' }, (response) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(response);
      });
    });
  }));
}

async function startThroughBackground(page: Page, wsUrl: string): Promise<any> {
  const tabId = await getActiveTabId(page);
  return sendRuntimeMessage(page, {
    type: 'START_SESSION',
    tabId,
    mode: 'dubbing_and_subtitle',
    mixerConfig: { originalVolume: 25, originalMuted: false, ttsVolume: 100 },
    wsUrl
  });
}

function skipWhenActionInvocationIsRequired(responseOrResponses: any): void {
  const responses = Array.isArray(responseOrResponses) ? responseOrResponses : [responseOrResponses];
  const blocked = responses.find((response) => {
    const text = String(response?.error || '').toLowerCase();
    return response?.code === 'PERMISSION_DENIED' && (text.includes('active tab') || text.includes('activetab') || text.includes('invoked for the current page'));
  });
  if (!blocked) return;

  test.info().annotations.push({
    type: 'blocked',
    description: 'tabCapture cần action button invocation thật; harness CDP không mô phỏng click toolbar.'
  });
  test.skip(true, `BLOCKED: ${blocked.error}`);
}

test.describe('Chrome extension E2E — artifact thật', () => {
  let fixture: RunningHttpServer;
  let backend: RunningBackend;
  let chromeRuntime: RunningChromeExtension;
  let browserContext: BrowserContext;
  let videoPage: Page;
  let extensionId: string;
  let browserLaunchBlocked: string | null = null;

  test.beforeAll(async () => {
    try {
      await ensureExtensionBuild('chrome');
      fixture = await startFixtureServer(fixturePath);
      backend = await startBackend();
      chromeRuntime = await startChromeExtension(path.join(extensionRoot, 'dist', 'chrome'));
      browserContext = chromeRuntime.context;
      extensionId = chromeRuntime.extensionId;
      videoPage = await browserContext.newPage();
      await videoPage.goto(fixture.url);
      await expect(videoPage.locator('video')).toHaveCount(1);
      await videoPage.waitForFunction(() => Boolean((window as any).__vietdub_spike__));
      await videoPage.locator('video').evaluate((video: HTMLVideoElement) => video.play());
    } catch (error) {
      const message = String(error);
      if (/spawn (?:UNKNOWN|ENOENT)|side-by-side configuration|Không tìm thấy Chrome\/Chromium executable|Chrome dừng trước khi mở CDP|Chrome không mở CDP/i.test(message)) {
        browserLaunchBlocked = message;
        return;
      }
      throw error;
    }
  });

  test.beforeEach(() => {
    if (browserLaunchBlocked) {
      test.info().annotations.push({ type: 'blocked', description: browserLaunchBlocked });
      test.skip(true, `BLOCKED: không khởi chạy được Chrome for Testing: ${browserLaunchBlocked}`);
    }
  });

  test.afterAll(async () => {
    await chromeRuntime?.close();
    await backend?.close();
    await fixture?.close();
  });

  async function openPopupPage(): Promise<Page> {
    const popupPage = await browserContext.newPage();
    // Giữ tab video là active để chrome.tabs.query trong popup chọn đúng target.
    const query = `?wsUrl=${encodeURIComponent(backend.wsUrl)}`;
    await popupPage.goto(`chrome-extension://${extensionId}/src/popup/index.html${query}`);
    await videoPage.bringToFront();
    return popupPage;
  }

  async function stopThroughBackground(popupPage: Page): Promise<void> {
    const response = await sendRuntimeMessage<any>(popupPage, { type: 'STOP_SESSION' });
    expect(response.success).toBe(true);
    await expect.poll(async () => (await sendRuntimeMessage<any>(popupPage, { type: 'GET_STATUS' })).state).toBe('IDLE');
  }

  test('nạp manifest/service worker thật và content script trả lời PING', async () => {
    const popupPage = await openPopupPage();
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(extensionRoot, 'dist', 'chrome', 'manifest.json'), 'utf8'));
      expect(manifest.manifest_version).toBe(3);
      expect(extensionId).toBeTruthy();

      const ping = await pingActiveContent(popupPage);
      expect(ping.ready).toBe(true);
      expect(ping.hasVideo).toBe(true);
    } finally {
      await popupPage.close();
    }
  });

  test('START → SESSION_READY → ACTIVE → STOP dọn offscreen và khôi phục audio', async () => {
    await videoPage.locator('video').evaluate((video: HTMLVideoElement) => {
      video.volume = 0.4;
      video.muted = false;
    });
    const popupPage = await openPopupPage();
    try {
      await expect(popupPage.getByRole('button', { name: 'Bắt đầu thuyết minh' })).toBeVisible();
      const startResponse = await startThroughBackground(popupPage, backend.wsUrl);
      skipWhenActionInvocationIsRequired(startResponse);
      expect(startResponse.success, JSON.stringify(startResponse)).toBe(true);
      await expect(popupPage.getByText('Đang thuyết minh')).toBeVisible({ timeout: 15000 });

      const status = await sendRuntimeMessage<any>(popupPage, { type: 'GET_STATUS' });
      expect(status.state).toBe('ACTIVE');
      expect(status.isCapturing).toBe(true);
      expect(status.sessionId).toBeTruthy();

      const offscreenStatus = await sendRuntimeMessage<any>(popupPage, { type: 'GET_OFFSCREEN_STATUS' });
      expect(offscreenStatus.active).toBe(true);
      expect(offscreenStatus.hasAudioContext).toBe(true);
      expect(offscreenStatus.hasPcmProcessor).toBe(true);

      await stopThroughBackground(popupPage);
      const stoppedOffscreen = await sendRuntimeMessage<any>(popupPage, { type: 'GET_OFFSCREEN_STATUS' });
      expect(stoppedOffscreen.active).toBe(false);
      expect(stoppedOffscreen.hasAudioContext).toBe(false);
      expect(stoppedOffscreen.hasPcmProcessor).toBe(false);

      const restored = await videoPage.locator('video').evaluate((video: HTMLVideoElement) => ({ volume: video.volume, muted: video.muted }));
      expect(restored).toEqual({ volume: 0.4, muted: false });
    } finally {
      await popupPage.close();
    }
  });

  test('double START dùng cùng session và START → STOP → START không tạo duplicate', async () => {
    const popupPage = await openPopupPage();
    try {
      const tabId = await getActiveTabId(popupPage);
      const startRequest = {
        type: 'START_SESSION',
        tabId,
        mode: 'dubbing_and_subtitle',
        mixerConfig: { originalVolume: 30, originalMuted: false, ttsVolume: 100 },
        wsUrl: backend.wsUrl
      };
      const responses = await popupPage.evaluate((request) => Promise.all([
        new Promise<any>((resolve) => chrome.runtime.sendMessage(request, resolve)),
        new Promise<any>((resolve) => chrome.runtime.sendMessage(request, resolve))
      ]), startRequest);
      skipWhenActionInvocationIsRequired(responses);
      expect(responses.every((response) => response.success)).toBe(true);
      expect(responses[0].sessionId).toBe(responses[1].sessionId);
      expect((await sendRuntimeMessage<any>(popupPage, { type: 'GET_STATUS' })).state).toBe('ACTIVE');

      await stopThroughBackground(popupPage);
      const second = await sendRuntimeMessage<any>(popupPage, startRequest);
      expect(second.success).toBe(true);
      await expect.poll(async () => (await sendRuntimeMessage<any>(popupPage, { type: 'GET_STATUS' })).state).toBe('ACTIVE');
      await stopThroughBackground(popupPage);
    } finally {
      await popupPage.close();
    }
  });

  test('backend disconnect không để UI giữ ACTIVE', async () => {
    const popupPage = await openPopupPage();
    try {
      const startResponse = await startThroughBackground(popupPage, backend.wsUrl);
      skipWhenActionInvocationIsRequired(startResponse);
      expect(startResponse.success, JSON.stringify(startResponse)).toBe(true);
      await expect(popupPage.getByText('Đang thuyết minh')).toBeVisible({ timeout: 15000 });
      await backend.close();
      await expect(popupPage.getByText('Lỗi kết nối')).toBeVisible({ timeout: 10000 });
      const status = await sendRuntimeMessage<any>(popupPage, { type: 'GET_STATUS' });
      expect(status.state).toBe('ERROR');
      expect(status.isCapturing).toBe(false);
      await stopThroughBackground(popupPage);
    } finally {
      await popupPage.close();
    }
  });
});
