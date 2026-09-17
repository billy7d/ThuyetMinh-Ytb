import { test, expect } from '@playwright/test';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, BrowserContext, Page } from 'playwright';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test.describe('Google Chrome Extension E2E Flow', () => {
  let server: http.Server;
  let serverUrl: string;
  let browserContext: BrowserContext;
  let page: Page;

  test.beforeAll(async () => {
    // Start local test server serving test video page
    const htmlPath = path.resolve(__dirname, '../spike/test-page.html');
    const htmlContent = fs.readFileSync(htmlPath, 'utf-8');

    server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(htmlContent);
    });

    await new Promise<void>((resolve) => {
      server.listen(9876, () => {
        serverUrl = 'http://localhost:9876';
        resolve();
      });
    });

    // Launch Chrome with extension loaded
    const extChromePath = path.resolve(__dirname, '../../../extension/dist/chrome');
    browserContext = await chromium.launchPersistentContext('', {
      executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      headless: true,
      args: [
        `--disable-extensions-except=${extChromePath}`,
        `--load-extension=${extChromePath}`,
        '--use-fake-ui-for-media-stream',
        '--autoplay-policy=no-user-gesture-required',
        '--no-sandbox'
      ]
    });
  });

  test.afterAll(async () => {
    await browserContext.close();
    server.close();
  });

  test('1. Should detect HTML5 video element on webpage', async () => {
    page = await browserContext.newPage();
    await page.goto(serverUrl);
    await page.waitForTimeout(1000);

    const videoExists = await page.evaluate(() => {
      return !!document.querySelector('video');
    });
    expect(videoExists).toBe(true);
  });

  test('2. Should verify audio signal from video and Web Audio Tap', async () => {
    const checkResult = await page.evaluate(async () => {
      return await (window as any).__vietdub_spike__.runFeasibilityCheck();
    });

    expect(checkResult.html5VideoPlaying).toBe(true);
    expect(checkResult.hasAudioTracks).toBe(true);
    expect(checkResult.sttSignalRMS_original100).toBeGreaterThan(0.05);
  });

  test('3. Should maintain STT audio tap when original video is muted to 0%', async () => {
    const checkResult = await page.evaluate(async () => {
      return await (window as any).__vietdub_spike__.runFeasibilityCheck();
    });

    // STT Tap RMS should be preserved even when original video volume is 0%
    expect(checkResult.sttSignalRMS_original0).toBeGreaterThan(0.05);
  });

  test('4. Should support independent TTS audio playback', async () => {
    const checkResult = await page.evaluate(async () => {
      return await (window as any).__vietdub_spike__.runFeasibilityCheck();
    });

    expect(checkResult.ttsPlayedSeparately).toBe(true);
    expect(checkResult.ttsSignalRMS).toBeGreaterThan(0.1);
  });

  test('5. Should safely restore original audio on stop', async () => {
    const checkResult = await page.evaluate(async () => {
      return await (window as any).__vietdub_spike__.runFeasibilityCheck();
    });

    expect(checkResult.originalRestored).toBe(true);
    expect(checkResult.errors.length).toBe(0);
  });
});
