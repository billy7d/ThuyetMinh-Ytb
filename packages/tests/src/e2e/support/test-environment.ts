import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { chromium, type Browser, type BrowserContext, type Worker } from 'playwright';

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(process.cwd(), '../..');

export interface RunningHttpServer {
  server: http.Server;
  url: string;
  close: () => Promise<void>;
}

export interface RunningBackend {
  process: ChildProcess;
  wsUrl: string;
  healthUrl: string;
  close: () => Promise<void>;
}

export interface RunningChromeExtension {
  browser: Browser;
  context: BrowserContext;
  extensionId: string;
  profilePath: string;
  close: () => Promise<void>;
}

export async function getFreePort(): Promise<number> {
  const probe = net.createServer();
  return new Promise<number>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (!address || typeof address === 'string') {
        probe.close(() => reject(new Error('Không xác định được cổng test động.')));
        return;
      }
      probe.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}

export async function startFixtureServer(htmlPath: string): Promise<RunningHttpServer> {
  const htmlContent = fs.readFileSync(htmlPath, 'utf8');
  const port = await getFreePort();
  const server = http.createServer((_request, response) => {
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Access-Control-Allow-Origin': '*'
    });
    response.end(htmlContent);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });

  return {
    server,
    url: `http://127.0.0.1:${port}`,
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  };
}

export async function ensureExtensionBuild(target: 'chrome' | 'firefox'): Promise<void> {
  await execFileAsync(process.execPath, [path.join(repositoryRoot, 'packages', 'extension', 'build.mjs'), `--${target}`], {
    cwd: path.join(repositoryRoot, 'packages', 'extension'),
    maxBuffer: 8 * 1024 * 1024
  });
}

export async function ensureBackendBuild(): Promise<void> {
  // Windows cần chạy npm qua ComSpec để tránh lỗi EINVAL khi execFile gọi shim .cmd.
  const npmCommand = process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : 'npm';
  const npmArgs = process.platform === 'win32'
    ? ['/d', '/s', '/c', 'npm run build -w @vietdub/backend']
    : ['run', 'build', '-w', '@vietdub/backend'];
  await execFileAsync(npmCommand, npmArgs, {
    cwd: repositoryRoot,
    maxBuffer: 8 * 1024 * 1024
  });
}

async function waitForHealth(healthUrl: string, child: ChildProcess, stderr: { value: string }): Promise<void> {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Backend dừng trước health check: ${stderr.value}`);
    }
    try {
      const response = await fetch(healthUrl, { signal: AbortSignal.timeout(500) });
      if (response.ok) return;
    } catch {
      // Chưa sẵn sàng thì tiếp tục polling trong thời hạn hữu hạn.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Backend không vượt qua health check trong 10 giây: ${stderr.value}`);
}

async function waitForCdp(cdpUrl: string, child: ChildProcess, stderr: { value: string }, spawnError: { value: Error | null }): Promise<void> {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (spawnError.value) throw spawnError.value;
    if (child.exitCode !== null) {
      throw new Error(`Chrome dừng trước khi mở CDP: ${stderr.value}`);
    }
    try {
      const response = await fetch(cdpUrl, { signal: AbortSignal.timeout(500) });
      if (response.ok) return;
    } catch {
      // Chrome chưa mở cổng CDP thì tiếp tục polling trong thời hạn hữu hạn.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Chrome không mở CDP trong 10 giây: ${stderr.value}`);
}

async function terminateProcessTree(child: ChildProcess): Promise<void> {
  if (process.platform === 'win32' && child.pid) {
    const commandShell = process.env.ComSpec || 'cmd.exe';
    // Kể cả khi process cha đã thoát, tiến trình con của Chromium có thể vẫn còn.
    await execFileAsync(commandShell, ['/d', '/s', '/c', `taskkill /pid ${child.pid} /t /f`]).catch(() => undefined);
  } else if (child.exitCode === null) {
    child.kill('SIGTERM');
  }

  if (child.exitCode !== null) return;

  await Promise.race([
    once(child, 'exit').then(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, 5000))
  ]);
}

async function isVietDubWorker(worker: Worker): Promise<boolean> {
  try {
    const manifest = await worker.evaluate(() => chrome.runtime.getManifest() as { name?: string });
    return manifest.name === 'VietDub AI - Thuyết minh tiếng Việt thời gian thực';
  } catch {
    return false;
  }
}

async function waitForVietDubWorker(context: BrowserContext): Promise<Worker> {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    for (const worker of context.serviceWorkers()) {
      if (await isVietDubWorker(worker)) return worker;
    }

    const remaining = Math.max(100, deadline - Date.now());
    try {
      const worker = await context.waitForEvent('serviceworker', { timeout: Math.min(1000, remaining) });
      if (await isVietDubWorker(worker)) return worker;
    } catch {
      // Có thể service worker chưa được đánh thức; vòng lặp sẽ kiểm tra lại.
    }
  }
  throw new Error('Không tìm thấy service worker VietDub AI trong Chrome E2E.');
}

export async function startBackend(): Promise<RunningBackend> {
  await ensureBackendBuild();
  const port = await getFreePort();
  const healthUrl = `http://127.0.0.1:${port}/health`;
  const backendProcess = spawn(
    process.execPath,
    [path.join(repositoryRoot, 'packages', 'backend', 'dist', 'server.js')],
    {
      cwd: repositoryRoot,
      env: { ...process.env, PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    }
  );
  const stderr = { value: '' };
  backendProcess.stderr?.on('data', (chunk: Buffer) => {
    stderr.value += chunk.toString();
  });
  try {
    await waitForHealth(healthUrl, backendProcess, stderr);
  } catch (error) {
    // Nếu health check thất bại, phải dọn process ngay cả khi factory chưa trả RunningBackend.
    await terminateProcessTree(backendProcess);
    throw error;
  }

  return {
    process: backendProcess,
    wsUrl: `ws://127.0.0.1:${port}`,
    healthUrl,
    close: async () => {
      if (backendProcess.exitCode !== null) return;
      backendProcess.kill();
      await Promise.race([
        once(backendProcess, 'exit').then(() => undefined),
        new Promise<void>((resolve) => setTimeout(resolve, 5000))
      ]);
    }
  };
}

export async function startChromeExtension(extensionPath: string): Promise<RunningChromeExtension> {
  const executablePath = resolveChromiumExecutable();
  if (!executablePath) throw new Error('Không tìm thấy Chrome/Chromium executable để chạy extension E2E.');

  const profilePath = createTemporaryProfile('vietdub-chrome-e2e');
  const port = await getFreePort();
  const stderr = { value: '' };
  const spawnError = { value: null as Error | null };
  let chromeProcess: ChildProcess;
  try {
    chromeProcess = spawn(
      executablePath,
      [
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${profilePath}`,
        '--headless=new',
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        '--use-fake-ui-for-media-stream',
        '--autoplay-policy=no-user-gesture-required',
        '--no-sandbox',
        '--no-first-run',
        // Edge có thể relaunch sang process khác; giữ PID do Node quản lý để cleanup không bỏ sót process con.
        '--edge-skip-compat-layer-relaunch',
        'about:blank'
      ],
      {
        cwd: repositoryRoot,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      }
    );
  } catch (error) {
    await removeTemporaryProfile(profilePath).catch(() => undefined);
    throw error;
  }
  chromeProcess.once('error', (error) => {
    spawnError.value = error;
  });
  chromeProcess.stderr?.on('data', (chunk: Buffer) => {
    stderr.value += chunk.toString();
  });

  try {
    await waitForCdp(`http://127.0.0.1:${port}/json/version`, chromeProcess, stderr, spawnError);
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const context = browser.contexts()[0];
    if (!context) throw new Error('Không tìm thấy browser context của Chrome E2E.');
    const worker = await waitForVietDubWorker(context);
    const extensionId = new URL(worker.url()).host;
    let closed = false;

    return {
      browser,
      context,
      extensionId,
      profilePath,
      close: async () => {
        if (closed) return;
        closed = true;
        const closePage = context.pages()[0];
        if (closePage) {
          try {
            // Browser.close của kết nối CDP chỉ ngắt client; Browser.close của CDP mới dừng process thật.
            const cdpSession = await context.newCDPSession(closePage);
            await cdpSession.send('Browser.close');
          } catch {
            // Nếu Chrome đã tự dừng thì bước taskkill bên dưới vẫn là cleanup hợp lệ.
          }
        }
        await browser.close().catch(() => undefined);
        await terminateProcessTree(chromeProcess);
        await removeTemporaryProfile(profilePath).catch((error) => {
          console.warn('[E2E] Không xóa được profile tạm sau khi Chrome đã dừng:', String(error));
        });
      }
    };
  } catch (error) {
    await terminateProcessTree(chromeProcess);
    await removeTemporaryProfile(profilePath).catch(() => undefined);
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${stderr.value}`);
  }
}

export function createTemporaryProfile(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
}

export function resolveChromiumExecutable(): string | undefined {
  const configuredPath = process.env.VIETDUB_CHROMIUM_EXECUTABLE;
  if (configuredPath && fs.existsSync(configuredPath)) return configuredPath;

  const expectedPlaywrightPath = path.join(
    os.homedir(),
    'AppData',
    'Local',
    'ms-playwright',
    'chromium-1243',
    'chrome-win64',
    'chrome.exe'
  );
  if (fs.existsSync(expectedPlaywrightPath)) return expectedPlaywrightPath;

  const systemChrome = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe');
  if (fs.existsSync(systemChrome)) return systemChrome;

  const playwrightRoot = path.dirname(path.dirname(path.dirname(expectedPlaywrightPath)));
  return fs.readdirSync(playwrightRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^chromium-\d+$/.test(entry.name))
    .map((entry) => path.join(playwrightRoot, entry.name, 'chrome-win64', 'chrome.exe'))
    .find((candidate) => fs.existsSync(candidate));
}

export async function removeTemporaryProfile(profilePath: string): Promise<void> {
  if (!fs.existsSync(profilePath)) return;
  let lastError: unknown;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      fs.rmSync(profilePath, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw lastError;
}

export { repositoryRoot };
