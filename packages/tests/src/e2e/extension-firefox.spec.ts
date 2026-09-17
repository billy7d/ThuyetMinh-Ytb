import { test, expect } from '@playwright/test';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { firefox, Browser, Page } from 'playwright';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test.describe('Mozilla Firefox Extension E2E Flow', () => {
  let server: http.Server;
  let serverUrl: string;
  let browser: Browser;
  let page: Page;

  test.beforeAll(async () => {
    const htmlPath = path.resolve(__dirname, '../spike/test-page.html');
    const htmlContent = fs.readFileSync(htmlPath, 'utf-8');

    server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(htmlContent);
    });

    await new Promise<void>((resolve) => {
      server.listen(9877, () => {
        serverUrl = 'http://localhost:9877';
        resolve();
      });
    });

    browser = await firefox.launch({
      headless: true,
      firefoxUserPrefs: {
        'media.navigator.permission.disabled': true,
        'media.autoplay.default': 0,
        'media.volume_scale': '1.0'
      }
    });
  });

  test.afterAll(async () => {
    await browser.close();
    server.close();
  });

  test('1. Should detect HTML5 video in Firefox', async () => {
    page = await browser.newPage();
    await page.goto(serverUrl);
    await page.waitForTimeout(1000);

    const videoExists = await page.evaluate(() => {
      return !!document.querySelector('video');
    });
    expect(videoExists).toBe(true);
  });

  test('2. Should capture audio from HTMLMediaElement and verify real signal in Firefox', async () => {
    const checkResult = await page.evaluate(async () => {
      return await (window as any).__vietdub_spike__.runFeasibilityCheck();
    });

    expect(checkResult.html5VideoPlaying).toBe(true);
    expect(checkResult.hasAudioTracks).toBe(true);
    expect(checkResult.sttSignalRMS_original100).toBeGreaterThan(0.05);
  });

  test('3. Should maintain STT tap signal when original video is muted in Firefox', async () => {
    const checkResult = await page.evaluate(async () => {
      return await (window as any).__vietdub_spike__.runFeasibilityCheck();
    });

    expect(checkResult.sttSignalRMS_original0).toBeGreaterThan(0.05);
  });

  test('4. Should play independent TTS audio in Firefox', async () => {
    const checkResult = await page.evaluate(async () => {
      return await (window as any).__vietdub_spike__.runFeasibilityCheck();
    });

    expect(checkResult.ttsPlayedSeparately).toBe(true);
    expect(checkResult.ttsSignalRMS).toBeGreaterThan(0.1);
  });

  test('5. Should safely restore video and audio context in Firefox', async () => {
    const checkResult = await page.evaluate(async () => {
      return await (window as any).__vietdub_spike__.runFeasibilityCheck();
    });

    expect(checkResult.originalRestored).toBe(true);
    expect(checkResult.errors.length).toBe(0);
  });

  test('6. Should inject built Firefox content script bundle (IIFE) without syntax error and respond to PING', async () => {
    // 1. Setup mock chrome runtime API on window
    await page.evaluate(() => {
      (window as any).__vietdub_listeners = [];
      (window as any).chrome = {
        runtime: {
          onMessage: {
            addListener: (cb: any) => {
              (window as any).__vietdub_listeners.push(cb);
            }
          },
          sendMessage: () => Promise.resolve()
        }
      };
    });

    // 2. Add the actual built Firefox content script bundle
    const contentJsPath = path.resolve(__dirname, '../../../extension/dist/firefox/content/content.js');
    await page.addScriptTag({ path: contentJsPath });

    // 3. Verify that script executed successfully and set window.__VIETDUB_CONTENT_INJECTED__
    const isInjected = await page.evaluate(() => (window as any).__VIETDUB_CONTENT_INJECTED__);
    expect(isInjected).toBe(true);

    // 4. Send CONTENT_PING to the registered listener and check response
    const pingResponse = await page.evaluate(async () => {
      return new Promise((resolve) => {
        const listener = (window as any).__vietdub_listeners[0];
        if (!listener) {
          resolve({ error: 'No listener registered' });
          return;
        }
        listener({ type: 'CONTENT_PING' }, {}, (res: any) => {
          resolve(res);
        });
      });
    });

    expect(pingResponse).toBeTruthy();
    expect((pingResponse as any).ready).toBe(true);
    expect((pingResponse as any).hasVideo).toBe(true);
  });

  test('7. Should successfully start and stop capture when backend server is online', async () => {
    // Start capture connecting to running backend on 8080
    const startResponse = await page.evaluate(async () => {
      return new Promise((resolve) => {
        const listener = (window as any).__vietdub_listeners[0];
        listener(
          {
            type: 'FIREFOX_START_CAPTURE',
            sessionId: 'test_online_sess',
            mode: 'dubbing_and_subtitle',
            mixerConfig: { originalVolume: 30, ttsVolume: 100 }
          },
          {},
          (res: any) => {
            resolve(res);
          }
        );
      });
    });

    expect(startResponse).toBeTruthy();
    expect((startResponse as any).success).toBe(true);

    // Stop capture and ensure clean cleanup
    const stopResponse = await page.evaluate(async () => {
      return new Promise((resolve) => {
        const listener = (window as any).__vietdub_listeners[0];
        listener(
          { type: 'FIREFOX_STOP_CAPTURE' },
          {},
          (res: any) => {
            resolve(res);
          }
        );
      });
    });

    expect(stopResponse).toBeTruthy();
    expect((stopResponse as any).success).toBe(true);
  });

  test('8. Should handle backend offline gracefully on FIREFOX_START_CAPTURE', async () => {
    // Attempt start capture connecting to an unavailable port (59999)
    const startResponse = await page.evaluate(async () => {
      return new Promise((resolve) => {
        const listener = (window as any).__vietdub_listeners[0];
        listener(
          {
            type: 'FIREFOX_START_CAPTURE',
            sessionId: 'test_offline_sess',
            mode: 'dubbing_and_subtitle',
            mixerConfig: { originalVolume: 30, ttsVolume: 100 },
            wsUrl: 'ws://localhost:59999'
          },
          {},
          (res: any) => {
            resolve(res);
          }
        );
      });
    });

    expect(startResponse).toBeTruthy();
    expect((startResponse as any).success).toBe(false);
    // Error must explain backend connection issue rather than crash with "Receiving end does not exist"
    expect((startResponse as any).error).toMatch(/Không thể kết nối|máy chủ|Timeout/);
  });
});
