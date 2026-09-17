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
});
