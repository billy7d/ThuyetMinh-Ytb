// Kiểm thử chấp nhận Firefox thật: cài extension tạm qua Remote Debugging Protocol, mở trang có origin
// https://www.youtube.com (được Playwright phục vụ từ file local), bấm Bắt đầu như popup và theo dõi phiên.
// Không lưu transcript; chỉ lưu trạng thái phiên, mã lỗi và số lượng phụ đề.
//
// Dùng: node runtime/firefox_acceptance.mjs [--seconds 40] [--video E:\VietDub-AI\cache\temp\vietdub-acceptance.webm]
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index], process.argv[index + 1]);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Playwright là devDependency của workspace tests; nạp từ đó để script chạy được từ thư mục runtime.
const { firefox } = createRequire(path.join(repositoryRoot, 'packages', 'tests', 'package.json'))('@playwright/test');
const extensionPath = path.join(repositoryRoot, 'packages', 'extension', 'dist', 'firefox');
const videoPath = args.get('--video') || 'E:\\VietDub-AI\\cache\\temp\\vietdub-acceptance.webm';
const watchSeconds = Number(args.get('--seconds') || 40);
const evidenceRoot = 'E:\\VietDub-AI\\evidence';
const RDP_PORT = 6123;

/** Client tối giản cho Firefox Remote Debugging Protocol (khung "độ dài:JSON"). */
function connectRdp(port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let buffer = Buffer.alloc(0);
    const waiters = [];
    const messages = [];
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const colon = buffer.indexOf(':');
        if (colon < 0) break;
        const length = Number(buffer.subarray(0, colon).toString());
        if (buffer.length < colon + 1 + length) break;
        const message = JSON.parse(buffer.subarray(colon + 1, colon + 1 + length).toString('utf8'));
        buffer = buffer.subarray(colon + 1 + length);
        const index = waiters.findIndex(waiter => waiter.predicate(message));
        if (index >= 0) waiters.splice(index, 1)[0].resolve(message);
        else messages.push(message);
      }
    });
    socket.once('error', reject);
    socket.once('connect', () => {
      const wait = predicate => {
        const found = messages.findIndex(predicate);
        if (found >= 0) return Promise.resolve(messages.splice(found, 1)[0]);
        return new Promise(res => waiters.push({ predicate, resolve: res }));
      };
      const send = packet => {
        const body = Buffer.from(JSON.stringify(packet), 'utf8');
        socket.write(`${body.length}:`);
        socket.write(body);
      };
      resolve({ socket, wait, send });
    });
  });
}

async function openRdp(port) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const rdp = await connectRdp(port);
      await rdp.wait(message => message.from === 'root' && message.applicationType);
      return rdp;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }
  throw new Error('Không kết nối được Firefox Remote Debugging Protocol.');
}

async function installTemporaryAddon(rdp, addonPath) {
  rdp.send({ to: 'root', type: 'getRoot' });
  const root = await rdp.wait(message => message.from === 'root' && message.addonsActor);
  rdp.send({ to: root.addonsActor, type: 'installTemporaryAddon', addonPath });
  const installed = await rdp.wait(message => message.from === root.addonsActor);
  if (!installed.addon) throw new Error(`Cài add-on tạm thất bại: ${JSON.stringify(installed).slice(0, 300)}`);
  return installed.addon.id;
}

/** Trả về hàm chạy JS trong background của extension (giống console của about:debugging). */
async function backgroundEvaluator(rdp, addonId) {
  rdp.send({ to: 'root', type: 'listAddons' });
  const list = await rdp.wait(message => message.from === 'root' && Array.isArray(message.addons));
  const addon = list.addons.find(item => item.id === addonId);
  if (!addon) throw new Error('Không tìm thấy add-on vừa cài trong RDP.');
  // Firefox mới dùng watcher: đăng ký theo dõi frame rồi lấy console actor của trang background.
  rdp.send({ to: addon.actor, type: 'getWatcher' });
  const watcher = await rdp.wait(message => message.from === addon.actor && message.actor);
  rdp.send({ to: watcher.actor, type: 'watchTargets', targetType: 'frame' });
  const target = await rdp.wait(message => message.type === 'target-available-form' && message.target?.consoleActor &&
    String(message.target.url || '').startsWith('moz-extension://'));
  const consoleActor = target.target.consoleActor;
  return async expression => {
    rdp.send({ to: consoleActor, type: 'evaluateJSAsync', text: `(async () => JSON.stringify(await (${expression})))()`, mapped: { await: true } });
    const ack = await rdp.wait(message => message.from === consoleActor && message.resultID);
    const result = await rdp.wait(message => message.type === 'evaluationResult' && message.resultID === ack.resultID);
    if (result.exception) throw new Error(`Background eval lỗi: ${JSON.stringify(result.exceptionMessage || result.exception).slice(0, 300)}`);
    return typeof result.result === 'string' ? JSON.parse(result.result) : result.result;
  };
}

/** Gửi runtime message từ content script của tab video (sender.tab hợp lệ như luồng popup thật). */
function sendFromVideoTab(evaluate, message) {
  return evaluate(`browser.tabs.query({ url: 'https://www.youtube.com/*' }).then(([tab]) => browser.scripting.executeScript({
    target: { tabId: tab.id },
    func: payload => browser.runtime.sendMessage(payload),
    args: [${JSON.stringify(message)}]
  })).then(results => results[0] && results[0].result)`);
}

async function main() {
  const video = await readFile(videoPath);
  const browser = await firefox.launch({
    headless: false,
    args: ['-start-debugger-server', String(RDP_PORT)],
    firefoxUserPrefs: {
      'devtools.debugger.remote-enabled': true,
      'devtools.debugger.prompt-connection': false,
      'devtools.chrome.enabled': true,
      'xpinstall.signatures.required': false,
      // Mặc định giữ chính sách autoplay của Firefox như máy người dùng; --autoplay allow để nới cho video giả lập.
      ...(args.get('--autoplay') === 'allow' ? { 'media.autoplay.default': 0, 'media.autoplay.blocking_policy': 0 } : {}),
      // --autoplay block: chính sách chặn của Firefox thật (AudioContext chỉ chạy sau cử chỉ người dùng trên trang).
      ...(args.get('--autoplay') === 'block' ? { 'media.autoplay.default': 5, 'media.autoplay.blocking_policy': 2, 'media.autoplay.block-webaudio': true } : {})
    }
  });
  const report = { startedAt: new Date().toISOString(), timeline: [], subtitleTexts: 0, contentConsole: [] };
  try {
    const context = await browser.newContext();
    // Firefox điều khiển tự động (navigator.webdriver) bị YouTube trả phụ đề rỗng, kể cả cho trình phát: --captions-fixture <file json3>
    // trả phụ đề thật đã lưu của video đó để thử chế độ đọc trước theo phụ đề (các bước còn lại chạy thật).
    if (args.get('--captions-fixture')) {
      const fixture = await readFile(args.get('--captions-fixture'), 'utf8');
      await context.route(/\/api\/timedtext/, route => route.fulfill({ status: 200, contentType: 'application/json; charset=utf-8', body: fixture }));
    }
    const rdp = await openRdp(RDP_PORT);
    report.addonId = await installTemporaryAddon(rdp, extensionPath);
    const evaluate = await backgroundEvaluator(rdp, report.addonId);

    // --native-launch true: thử nút "Bật backend" của popup (native messaging host) thay cho bài thử thuyết minh. Cổng 8080 phải trống.
    if (args.get('--native-launch') === 'true') {
      report.nativeLaunch = await runNativeLaunchTest(context, evaluate);
      report.verdict = report.nativeLaunch.verdict;
      await browser.close();
      // Backend bật từ Firefox phải sống tiếp sau khi Firefox đóng.
      await new Promise(resolve => setTimeout(resolve, 3000));
      report.nativeLaunch.healthAfterBrowserClosed = await backendHealth();
      if (report.nativeLaunch.healthAfterBrowserClosed !== 200) report.nativeLaunch.verdict = 'FAIL';
      stopBackendOnPort8080();
      await mkdir(evidenceRoot, { recursive: true });
      const nativePath = path.join(evidenceRoot, `firefox-native-launch-${Date.now()}.json`);
      await writeFile(nativePath, JSON.stringify(report, null, 2));
      console.log(JSON.stringify({ ...report.nativeLaunch, reportPath: nativePath }, null, 2));
      return;
    }

    // Trang video mang origin https://www.youtube.com giống môi trường thật của người dùng.
    await context.route('https://www.youtube.com/**', async route => {
      const url = route.request().url();
      if (url.endsWith('/vietdub-test.webm')) {
        await route.fulfill({ status: 200, contentType: 'video/webm', body: video });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: '<!doctype html><html><head><title>VietDub acceptance</title></head><body style="margin:0;background:#000">' +
          '<div id="movie_player" style="position:relative;width:640px;height:360px">' +
          '<video class="video-stream html5-main-video" src="/vietdub-test.webm" style="width:640px;height:360px" playsinline></video>' +
          '</div></body></html>'
      });
    });

    const page = await context.newPage();
    report.diag = [];
    page.on('console', message => {
      const text = message.text();
      if (text.startsWith('[VIETDUB][DIAG]')) {
        const [, event, ...rest] = text.split(' ');
        let payload = null;
        try { payload = JSON.parse(rest.join(' ')); } catch {}
        if (event !== 'pcm.chunk_emitted' || report.diag.filter(item => item.event === 'pcm.chunk_emitted').length < 400) {
          report.diag.push({ t: Date.now(), event, payload });
        }
      }
      if (/firefox_tts\.decoded_and_played/.test(text)) report.ttsPlayed = (report.ttsPlayed || 0) + 1;
      if (/\[CONTENT\]|firefox_ws\.session|firefox_capture\.(start|cleanup)|WebSocket|ERROR/i.test(text)) {
        report.contentConsole.push(text.slice(0, 240));
      }
    });
    page.on('console', message => { if (/AudioContext|autoplay/i.test(message.text())) report.contentConsole.push(message.text().slice(0, 200)); });
    const targetUrl = args.get('--url') || 'https://www.youtube.com/watch?v=vietdub-test';
    if (args.get('--url')) await context.unroute('https://www.youtube.com/**');
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('video', { timeout: 30_000 });
    await page.waitForTimeout(Number(args.get('--settle-ms') || 1500));
    // Click thật vào trình phát (cử chỉ người dùng) như khi người dùng bấm Play.
    // --no-gesture true: không tương tác với trang (người dùng mở link rồi bấm Bắt đầu ngay) -> Firefox chặn AudioContext.
    const paused = await page.evaluate(() => document.querySelector('video').paused);
    if (paused && args.get('--no-gesture') !== 'true') {
      const playButton = await page.$('.ytp-play-button');
      if (playButton) await playButton.click().catch(() => undefined);
      else await page.click('video').catch(() => undefined);
    }
    if (args.get('--no-gesture') !== 'true') await page.evaluate(() => {
      const video = document.querySelector('video');
      video.muted = false;
      // Trang giả lập không có nút Play của YouTube: sau cú click (cử chỉ người dùng) thì gọi play().
      if (video.paused) return video.play().catch(() => undefined);
      return undefined;
    });
    await page.waitForTimeout(1000);
    report.videoPlaying = await page.evaluate(() => !document.querySelector('video').paused);
    await page.waitForTimeout(1500);

    const startResponse = args.get('--no-session') === 'true' ? { success: true, skipped: true } : await sendFromVideoTab(evaluate, {
      type: 'START_SESSION',
      ...(args.get('--ws') ? { wsUrl: args.get('--ws') } : {}),
      mode: 'dubbing_and_subtitle',
      mixerConfig: { originalVolume: 25, originalMuted: false, ttsVolume: 100 }
    });
    report.startResponse = startResponse;

    const watch = async (seconds, label) => {
      let lastSubtitle = '';
      const startedAt = Date.now();
      while (Date.now() - startedAt < seconds * 1000) {
        const snapshot = await sendFromVideoTab(evaluate, { type: 'GET_STATUS' });
        const subtitle = await page.evaluate(() => {
          const element = document.getElementById('vietdub-subtitle-text');
          return element && element.style.display !== 'none' ? element.textContent || '' : '';
        });
        const videoState = await page.evaluate(() => {
          const video = document.querySelector('video');
          return video ? { t: Math.round(video.currentTime), paused: video.paused, ad: Boolean(document.querySelector('.ad-showing')) } : null;
        }).catch(() => null);
        (report.videoSamples ||= []).push(videoState);
        if (subtitle && subtitle !== lastSubtitle) {
          report.subtitleTexts += 1;
          // Chỉ in ra console khi được yêu cầu (đánh giá chất lượng dịch); không lưu vào file bằng chứng.
          if (args.get('--print-subtitles') === 'true') console.error(`[SUB ${Math.round((Date.now() - startedAt) / 1000)}s] ${subtitle}`);
          lastSubtitle = subtitle;
        }
        const entry = {
          t: Math.round((Date.now() - startedAt) / 1000),
          state: snapshot?.state,
          error: snapshot?.error ? `${snapshot.error.code}: ${String(snapshot.error.message).slice(0, 160)}` : null,
          warning: snapshot?.warning ? snapshot.warning.code : null,
          subtitleVisible: Boolean(subtitle)
        };
        const previous = report.timeline.at(-1);
        if (!previous || previous.state !== entry.state || previous.error !== entry.error || previous.warning !== entry.warning) {
          report.timeline.push({ phase: label, ...entry });
        }
        if (snapshot?.state === 'ERROR') break;
        await page.waitForTimeout(1000);
      }
    };
    await watch(watchSeconds, 'first');

    // Giả lập người dùng nhấn F5 giữa phiên rồi bấm Bắt đầu lại: phiên mới phải chạy ngay, không kẹt phiên cũ.
    if (args.get('--reload') !== 'false') {
      const subtitlesBeforeReload = report.subtitleTexts;
      await page.reload();
      await page.waitForSelector('video', { timeout: 30_000 });
      await page.evaluate(() => document.querySelector('video').play().catch(() => undefined));
      await page.waitForTimeout(1500);
      report.restartResponse = await sendFromVideoTab(evaluate, {
        type: 'START_SESSION',
        ...(args.get('--ws') ? { wsUrl: args.get('--ws') } : {}),
        mode: 'dubbing_and_subtitle',
        mixerConfig: { originalVolume: 25, originalMuted: false, ttsVolume: 100 }
      });
      await watch(25, 'after-reload');
      report.subtitlesAfterReload = report.subtitleTexts - subtitlesBeforeReload;
    }
    if (args.get('--screenshot')) await page.screenshot({ path: args.get('--screenshot') }).catch(() => undefined);
    await sendFromVideoTab(evaluate, { type: 'STOP_SESSION' }).catch(() => undefined);
    rdp.socket.end();
    report.videoRestored = await page.evaluate(() => {
      const element = document.querySelector('video');
      return { volume: element.volume, muted: element.muted };
    });
  } finally {
    await browser.close();
  }
  report.completedAt = new Date().toISOString();
  report.sync = summarizeSync(report.diag || []);
  report.script = summarizeScript(report.diag || []);
  report.verdict = report.timeline.some(entry => entry.state === 'ERROR') || report.subtitleTexts === 0 ||
    (report.subtitlesAfterReload !== undefined && report.subtitlesAfterReload === 0) ? 'FAIL' : 'PASS';
  await mkdir(evidenceRoot, { recursive: true });
  const reportPath = path.join(evidenceRoot, `firefox-acceptance-${Date.now()}.json`);
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, reportPath }, null, 2));
}

async function backendHealth() {
  try {
    return (await fetch('http://127.0.0.1:8080/health', { signal: AbortSignal.timeout(2000) })).status;
  } catch {
    return 0;
  }
}

async function runNativeLaunchTest(context, evaluate) {
  const result = { steps: [] };
  const note = (name, data = {}) => { result.steps.push({ name, ...data }); console.error('[ff-native]', name, JSON.stringify(data)); };
  if (await backendHealth() !== 0) throw new Error('Cổng 8080 đang có backend chạy; tắt nó trước khi thử.');
  const call = command => evaluate(`new Promise(resolve => chrome.runtime.sendNativeMessage('com.vietdub.backend_launcher', { command: '${command}' }, response => resolve({ response: response ?? null, error: chrome.runtime.lastError ? chrome.runtime.lastError.message : null })))`);
  // Playwright không điều hướng được tới moz-extension://, nên không bấm nút popup: gọi đúng lệnh mà nút gọi (launchBackend ->
  // runtime.sendNativeMessage({command:'start'})) từ background của add-on Firefox thật.
  result.status = await call('status');
  note('status-from-background', result.status);
  const startedAt = Date.now();
  result.start = await call('start');
  note('start-from-background', { ...result.start, afterMs: Date.now() - startedAt });
  let health = 0;
  while (Date.now() - startedAt < 240_000 && health !== 200) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    health = await backendHealth();
  }
  result.readyAfterMs = Date.now() - startedAt;
  note('backend-health', { health, afterMs: result.readyAfterMs });
  result.second = await call('start');
  note('second-start-is-noop', result.second);
  result.verdict = health === 200 && result.start.response?.ok === true && result.second.response?.state === 'ready' ? 'PASS' : 'FAIL';
  return result;
}

function stopBackendOnPort8080() {
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', "(Get-NetTCPConnection -LocalPort 8080 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess"], { encoding: 'utf8' }).trim();
    if (out) execFileSync('taskkill', ['/PID', out, '/T', '/F'], { stdio: 'ignore' });
  } catch { /* không có gì để tắt */ }
}

function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((x, y) => x - y);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

/**
 * Lệch phụ đề so với giọng đọc (cùng segmentId) và độ trễ so với câu gốc trên video.
 * subtitleMinusTtsMs > 0: phụ đề hiện SAU giọng đọc; < 0: phụ đề đi TRƯỚC giọng đọc.
 */
/** Chế độ đọc trước theo phụ đề: giọng bắt đầu lệch bao nhiêu so với câu gốc, giọng tới sớm bao lâu trước câu. */
function summarizeScript(diag) {
  const stats = raw => {
    const values = raw.filter(Number.isFinite);
    return { n: values.length, p50: percentile(values, 50), p95: percentile(values, 95), max: values.length ? Math.max(...values) : null, min: values.length ? Math.min(...values) : null };
  };
  const scheduled = diag.filter(item => item.event === 'firefox_script.scheduled').map(item => item.payload || {});
  const ready = diag.filter(item => item.event === 'firefox_script.audio_ready').map(item => item.payload || {});
  if (scheduled.length === 0 && ready.length === 0) return undefined;
  return {
    started: diag.find(item => item.event === 'firefox_script.started')?.payload,
    switchedFromStt: diag.some(item => item.event === 'firefox_script.switched_from_stt'),
    scheduled: scheduled.length,
    missed: diag.filter(item => item.event === 'firefox_script.audio_missed').length,
    startOffsetMs: stats(scheduled.map(item => item.startOffsetMs)),
    audioLeadMs: stats(ready.map(item => item.leadMs)),
    rate: stats(ready.map(item => item.rate)),
    stretchMs: stats(ready.map(item => item.stretchMs))
  };
}

function summarizeSync(diag) {
  // segmentId lặp lại giữa các phiên (trước/sau tải lại trang): ghép với lần phát gần nhất cùng segmentId.
  const ttsStart = [];
  const ttsLag = [];
  for (const item of diag) {
    if (item.event !== 'firefox_tts.decoded_and_played' || !item.payload?.scheduled) continue;
    ttsStart.push({ segmentId: item.payload.segmentId, t: item.t + (item.payload.delayMs || 0) });
    if (Number.isFinite(item.payload.lagFromStartMs)) ttsLag.push({ fromStart: item.payload.lagFromStartMs, fromEnd: item.payload.lagFromEndMs });
  }
  const offsets = [];
  const subtitleLag = [];
  for (const item of diag) {
    if (item.event !== 'subtitle_renderer.displayed' || !item.payload) continue;
    if (Number.isFinite(item.payload.lagFromStartMs)) subtitleLag.push({ fromStart: item.payload.lagFromStartMs, fromEnd: item.payload.lagFromEndMs });
    const candidates = ttsStart.filter(entry => entry.segmentId === item.payload.segmentId)
      .map(entry => item.t - entry.t)
      .sort((a, b) => Math.abs(a) - Math.abs(b));
    if (candidates.length > 0) offsets.push(candidates[0]);
  }
  const stats = values => ({ n: values.length, p50: percentile(values, 50), p95: percentile(values, 95), max: values.length ? Math.max(...values) : null, min: values.length ? Math.min(...values) : null });
  const scheduled = diag.filter(item => item.event === 'tts_mixer.scheduled').map(item => item.payload || {});
  return {
    ttsScheduled: scheduled.length,
    ttsBacklogSkipped: diag.filter(item => item.event === 'tts_mixer.backlog_skipped').length,
    ttsMaxQueueDelayMs: scheduled.length ? Math.max(...scheduled.map(item => item.delayMs || 0)) : null,
    ttsMaxRate: scheduled.length ? Math.max(...scheduled.map(item => item.rate || 1)) : null,
    subtitleMinusTtsMs: stats(offsets),
    subtitleLagFromSpeechStartMs: stats(subtitleLag.map(item => item.fromStart)),
    subtitleLagFromSpeechEndMs: stats(subtitleLag.map(item => item.fromEnd)),
    ttsLagFromSpeechStartMs: stats(ttsLag.map(item => item.fromStart)),
    ttsLagFromSpeechEndMs: stats(ttsLag.map(item => item.fromEnd))
  };
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
