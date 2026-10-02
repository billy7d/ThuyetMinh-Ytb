// Kiểm thử Chrome cài extension thật bằng profile riêng và ghi bằng chứng an toàn.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const installRoot = path.resolve(process.env.VIETDUB_INSTALL_ROOT || 'E:\\VietDub-AI');
const evidenceRoot = path.join(installRoot, 'evidence');
const profileRoot = path.join(installRoot, 'browser-profile', 'chrome-acceptance-cdp');
const cacheRoot = path.join(installRoot, 'cache', 'chrome');
const extensionRoot = path.join(repositoryRoot, 'packages', 'extension', 'dist', 'chrome');
const chromeExecutable = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const ffmpegExecutable = 'D:\\ffmpeg-essentials_build\\ffmpeg-2026-06-15-git-44d082edc8-essentials_build\\bin\\ffmpeg.exe';
const sourceWavPath = path.join(evidenceRoot, 'stt-english-synthetic-source.wav');
const youtubeUrl = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';

if (process.platform === 'win32' && path.parse(installRoot).root.toUpperCase() !== 'E:\\') {
  throw new Error('Profile, cache và bằng chứng Chrome phải nằm trên ổ E:.');
}
await access(chromeExecutable);
await access(path.join(extensionRoot, 'manifest.json'));
await access(sourceWavPath);
await mkdir(path.dirname(profileRoot), { recursive: true });
await mkdir(cacheRoot, { recursive: true });
await mkdir(evidenceRoot, { recursive: true });

const generatedAudio = await readFile(sourceWavPath);
const testVideo = await makeHtml5Video(generatedAudio);
const server = createServer((request, response) => {
  if (request.url === '/video.mp4') {
    response.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': testVideo.length, 'Cache-Control': 'no-store' });
    response.end(testVideo);
    return;
  }
  const html = '<!doctype html><html lang="en"><meta charset="utf-8"><title>VietDub local HTML5 audio test</title>' +
    '<body style="margin:0;background:#111"><video id="vietdub-test-video" controls autoplay loop playsinline ' +
    'style="width:100vw;height:100vh" src="/video.mp4"></video></body></html>';
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(html);
});
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const address = server.address();
const localUrl = `http://127.0.0.1:${address.port}/`;

const result = {
  startedAt: new Date().toISOString(),
  browser: {
    name: 'Google Chrome stable, existing installation',
    profileRoot
  },
  extensionBuild: 'packages/extension/dist/chrome',
  html5Source: 'English speech synthesized locally by pinned VieNeu TTS; not a human recording or test fixture.',
  localHtml5: { pageLoaded: false, contentScriptReady: false, session: 'NOT_RUN' },
  youtube: { pageLoaded: false, humanSpeechPlayback: false, session: 'NOT_RUN' },
  modes: {},
  pauseResume: 'NOT_RUN',
  seek: 'NOT_RUN',
  stopAndRestore: 'NOT_RUN',
  ttsPlaybackDiagnosticCount: 0,
  latencyBadgeObserved: false,
  liveLatencySamplesMs: [],
  accessBlocker: null
};

let context;
let browser;
let chromeProcess;
let cdpPort;
let videoPage;
let extensionWorker;
let extensionId;
let videoTabId;
let offscreenPages = new Set();

function observeExtensionPage(page) {
  page.on('console', message => {
    const line = message.text();
    if (line.includes('chrome_tts.decoded_and_played')) result.ttsPlaybackDiagnosticCount += 1;
  });
  if (page.url().includes('/offscreen.html')) offscreenPages.add(page);
  page.on('framenavigated', () => {
    if (page.url().includes('/offscreen.html')) offscreenPages.add(page);
  });
}

async function waitForExtensionWorker(timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const worker of context.serviceWorkers()) {
      if (!worker.url().startsWith('chrome-extension://')) continue;
      const name = await worker.evaluate(() => chrome.runtime.getManifest().name).catch(() => '');
      if (name === 'VietDub AI - Thuyết minh tiếng Việt thời gian thực') {
        extensionWorker = worker;
        return worker;
      }
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error('Không tìm thấy MV3 extension service worker trong Chrome thật.');
}

async function activeTabIdFromExtension() {
  return extensionWorker.evaluate(() => new Promise((resolve, reject) => {
    chrome.tabs.query({ active: true, lastFocusedWindow: true }, tabs => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(tabs[0]?.id ?? null);
    });
  }));
}

async function sendTabMessage(message) {
  return extensionWorker.evaluate(({ tabId, payload }) => new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, payload, response => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(response);
    });
  }), { tabId: videoTabId, payload: message });
}

async function main() {
  const manualLoadUnpacked = process.argv.includes('--manual-load-unpacked');
  const markerPath = path.join(profileRoot, 'vietdub-acceptance-profile.json');
  let profileMarker;
  try {
    profileMarker = JSON.parse(await readFile(markerPath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    try {
      await access(profileRoot);
      throw new Error('Profile đích đã tồn tại nhưng không có dấu sở hữu VietDub; dừng để bảo toàn dữ liệu.');
    } catch (profileError) {
      if (profileError.code !== 'ENOENT') throw profileError;
    }
    await mkdir(profileRoot);
    profileMarker = { schemaVersion: 1, purpose: 'VietDub isolated Chrome acceptance', profileRoot };
    await writeFile(markerPath, `${JSON.stringify(profileMarker, null, 2)}\n`, { flag: 'wx' });
  }
  if (profileMarker.schemaVersion !== 1 || profileMarker.purpose !== 'VietDub isolated Chrome acceptance' ||
    path.resolve(profileMarker.profileRoot) !== profileRoot) {
    throw new Error('Dấu profile acceptance không khớp; dừng để bảo toàn profile.');
  }
  const profileState = path.join(profileRoot, 'Local State');
  try {
    await access(profileState);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const portProbe = createServer();
  await new Promise((resolve, reject) => {
    portProbe.once('error', reject);
    portProbe.listen(0, '127.0.0.1', resolve);
  });
  cdpPort = portProbe.address().port;
  await new Promise((resolve, reject) => portProbe.close(error => error ? reject(error) : resolve()));
  const browserTemp = path.join(installRoot, 'cache', 'temp');
  await mkdir(browserTemp, { recursive: true });
  const chromeArgs = [
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${profileRoot}`,
    `--disk-cache-dir=${cacheRoot}`,
    '--autoplay-policy=no-user-gesture-required',
    '--no-first-run',
    '--no-default-browser-check',
    manualLoadUnpacked ? 'chrome://extensions' : 'about:blank'
  ];
  chromeProcess = spawn(chromeExecutable, chromeArgs, {
    cwd: repositoryRoot,
    env: { ...process.env, TEMP: browserTemp, TMP: browserTemp },
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: false
  });
  let browserStderr = '';
  chromeProcess.stderr?.on('data', chunk => {
    if (browserStderr.length < 4096) browserStderr += chunk.toString();
  });
  const cdpUrl = `http://127.0.0.1:${cdpPort}`;
  const cdpDeadline = Date.now() + 20_000;
  while (Date.now() < cdpDeadline) {
    if (chromeProcess.exitCode !== null) throw new Error(`Chrome đóng trước CDP (${chromeProcess.exitCode}).`);
    try {
      const response = await fetch(`${cdpUrl}/json/version`, { signal: AbortSignal.timeout(500) });
      if (response.ok) break;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }
  if (Date.now() >= cdpDeadline) throw new Error(`Chrome không mở CDP trong 20 giây. ${browserStderr.slice(0, 300)}`);
  browser = await chromium.connectOverCDP(cdpUrl);
  context = browser.contexts()[0];
  if (!context) throw new Error('Không lấy được context của Chrome chạy thật.');
  await context.pages()[0]?.setViewportSize({ width: 1280, height: 800 });
  context.on('page', observeExtensionPage);
  for (const page of context.pages()) observeExtensionPage(page);
  if (manualLoadUnpacked) {
    videoPage = context.pages()[0] || await context.newPage();
    if (!videoPage.url().startsWith('chrome://extensions')) {
      await videoPage.goto('chrome://extensions', { waitUntil: 'domcontentloaded' });
    }
    result.extensionLoadUiOpened = true;
    result.operatorActionRequired = `Trong profile thử nghiệm E:, bật Developer mode rồi bấm Load unpacked và chọn ${extensionRoot}.`;
    console.log(JSON.stringify({ handoff: result.operatorActionRequired, profileRoot, cdpPort }));
    extensionWorker = await waitForExtensionWorker(30 * 60 * 1000);
  } else {
    extensionWorker = await waitForExtensionWorker();
  }
  extensionId = new URL(extensionWorker.url()).hostname;
  result.browser.version = await extensionWorker.evaluate(() => navigator.userAgent);
  result.browser.extensionId = extensionId;
  result.browser.extensionName = await extensionWorker.evaluate(() => chrome.runtime.getManifest().name);
  result.browser.popupPath = await extensionWorker.evaluate(() => chrome.runtime.getManifest().action?.default_popup || null);

  videoPage = await context.newPage();
  await videoPage.goto(localUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await videoPage.waitForSelector('video', { timeout: 15_000 });
  await videoPage.locator('video').evaluate(video => video.play());
  await videoPage.waitForFunction(() => {
    const video = document.querySelector('video');
    return Boolean(video && video.readyState >= 2 && !video.paused && video.currentTime > 0);
  }, { timeout: 15_000 });
  result.localHtml5.pageLoaded = true;

  await videoPage.bringToFront();
  videoTabId = await activeTabIdFromExtension();
  if (!Number.isInteger(videoTabId)) throw new Error('Chrome không trả tabId cho trang HTML5 đang phát.');
  const contentPing = await sendTabMessage({ type: 'CONTENT_PING' });
  result.localHtml5.contentScriptReady = contentPing?.ready === true && contentPing?.hasVideo === true;
  if (!result.localHtml5.contentScriptReady) throw new Error('Content script không xác nhận video HTML5 thật.');

  await videoPage.goto(youtubeUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  const consentButton = videoPage.getByRole('button', { name: /reject all|reject optional/i }).first();
  if (await consentButton.count() && await consentButton.isVisible().catch(() => false)) await consentButton.click();
  const agePrompt = await videoPage.getByText(/confirm your age|verify your age|age-restricted/i).count();
  if (agePrompt > 0) {
    result.youtube.pageLoaded = true;
    result.youtube.blocker = 'AGE_OR_AUTH_GATE';
    return;
  }
  await videoPage.waitForSelector('video', { timeout: 30_000 });
  const youtubeVideo = videoPage.locator('video').first();
  await youtubeVideo.evaluate(async video => { if (video.paused) await video.play().catch(() => undefined); });
  try {
    await videoPage.waitForFunction(() => {
      const video = document.querySelector('video');
      return Boolean(video && video.readyState >= 2 && !video.paused && video.currentTime > 0);
    }, { timeout: 25_000 });
    result.youtube.pageLoaded = true;
    result.youtube.humanSpeechPlayback = true;
  } catch {
    result.youtube.pageLoaded = await videoPage.locator('video').count() > 0;
    result.youtube.blocker = 'VIDEO_DID_NOT_PLAY';
    return;
  }

  await videoPage.bringToFront();
  videoTabId = await activeTabIdFromExtension();
  result.youtube.contentScriptReady = (await sendTabMessage({ type: 'CONTENT_PING' }))?.hasVideo === true;
  if (!result.youtube.contentScriptReady) {
    result.youtube.session = 'BLOCKED_CONTENT_SCRIPT';
    return;
  }
  result.localHtml5.session = 'PASS_CONTENT_SCRIPT_ONLY';
  result.youtube.session = 'PENDING_OPERATOR_ACTION_BUTTON';
  result.accessBlocker = 'Chrome action toolbar invocation chưa thực hiện; cần người dùng click extension thật để cấp tabCapture.';
}

try {
  const health = await fetch('http://127.0.0.1:8080/health', { signal: AbortSignal.timeout(5_000) });
  const payload = await health.json();
  if (!health.ok || payload.status !== 'ok' || payload.providers?.mode !== 'local' || !payload.providers?.configured) {
    throw new Error('Backend local chưa sẵn sàng; Chrome acceptance bị dừng fail-closed.');
  }
  await main();
} catch (error) {
  result.runtimeError = error instanceof Error ? error.message : String(error);
} finally {
  result.offscreenDiagnosticTargets = offscreenPages.size;
  const reportPath = path.join(evidenceRoot, `chrome-acceptance-${Date.now()}.json`);
  const holdForOperator = process.argv.includes('--hold-for-operator') && context && !result.runtimeError;
  if (holdForOperator) {
    result.cdpPort = cdpPort;
    result.operatorActionRequired = 'Click icon/puzzle menu VietDub AI trong Chrome thật; mở popup rồi bấm Bắt đầu thuyết minh.';
    console.log(JSON.stringify({ ...result, reportPath }));
    await writeFile(reportPath, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' }).catch(error => {
      console.warn(`Không ghi được báo cáo E: ${error.code || 'WRITE_ERROR'}`);
    });
    await new Promise(resolve => {
      const timer = setTimeout(resolve, 30 * 60 * 1000);
      process.once('SIGINT', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  result.completedAt = new Date().toISOString();
  result.offscreenDiagnosticTargets = offscreenPages.size;
  console.log(JSON.stringify({ ...result, reportPath }));
  if (context?.pages()[0]) {
    try {
      const cdpSession = await context.newCDPSession(context.pages()[0]);
      await cdpSession.send('Browser.close');
    } catch {
      // Browser.close có thể đã được Chrome xử lý trước khi cleanup bắt đầu.
    }
  }
  await browser?.close().catch(() => undefined);
  if (chromeProcess && chromeProcess.exitCode === null) {
    chromeProcess.kill();
    await Promise.race([once(chromeProcess, 'exit').then(() => undefined), new Promise(resolve => setTimeout(resolve, 5000))]);
  }
  await new Promise(resolve => server.close(() => resolve()));
  await writeFile(reportPath, `${JSON.stringify(result, null, 2)}\n`).catch(error => {
    console.warn(`Không ghi được báo cáo E: ${error.code || 'WRITE_ERROR'}`);
  });
}

async function makeHtml5Video(wav) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegExecutable, [
      '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=640x360:r=24',
      '-i', 'pipe:0', '-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k', '-movflags', 'frag_keyframe+empty_moov', '-f', 'mp4', 'pipe:1'
    ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const output = [];
    const errors = [];
    child.stdout.on('data', chunk => output.push(chunk));
    child.stderr.on('data', chunk => errors.push(chunk));
    child.once('error', reject);
    child.once('close', code => {
      const buffer = Buffer.concat(output);
      if (code === 0 && buffer.length > 1024) resolve(buffer);
      else reject(new Error(`Không tạo được video HTML5 local: ${Buffer.concat(errors).toString('utf8').slice(0, 200)}`));
    });
    child.stdin.end(wav);
  });
}
