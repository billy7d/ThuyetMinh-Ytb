import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const hostScript = path.join(root, 'runtime', 'native-host', 'host.mjs');
const ORIGIN = 'chrome-extension://boffkjgmlpmipjpojfjjkdmmcnmnfnoj/';
const FIREFOX_ID = 'vietdub-ai@vietdub.local';
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function frame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

/** Chạy host như Chrome: gửi các bản tin, đóng stdin, đọc các bản tin trả lời. */
async function runHost(configPath: string, messages: unknown[], origin: string | string[] = ORIGIN, raw?: Buffer): Promise<{ replies: any[]; code: number | null }> {
  const child = spawn(process.execPath, [hostScript, ...(Array.isArray(origin) ? origin : [origin])], { env: { ...process.env, VIETDUB_HOST_CONFIG: configPath }, stdio: ['pipe', 'pipe', 'pipe'] });
  const chunks: Buffer[] = [];
  child.stdout.on('data', chunk => chunks.push(chunk));
  for (const message of messages) child.stdin.write(frame(message));
  if (raw) child.stdin.write(raw);
  child.stdin.end();
  const code = await new Promise<number | null>(resolve => child.on('close', resolve));
  const out = Buffer.concat(chunks);
  const replies: any[] = [];
  for (let offset = 0; offset + 4 <= out.length;) {
    const length = out.readUInt32LE(offset);
    replies.push(JSON.parse(out.subarray(offset + 4, offset + 4 + length).toString('utf8')));
    offset += 4 + length;
  }
  return { replies, code };
}

async function freePort(): Promise<number> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

const FAKE_BACKEND = `
import http from 'node:http';
const [port, warmupMs] = [Number(process.argv[2]), Number(process.argv[3])];
const startedAt = Date.now();
console.log('fake backend listening on ' + port);
http.createServer((req, res) => {
  if (req.url === '/quit') { res.end('bye'); setTimeout(() => process.exit(0), 20); return; }
  const ready = Date.now() - startedAt >= warmupMs;
  res.writeHead(ready ? 200 : 503, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ mode: 'local', configured: ready }));
}).listen(port, '127.0.0.1');
`;

let tempDirs: string[] = [];
const ports: number[] = [];

function makeSetup(options: { warmupMs?: number; allowedOrigins?: string[]; withScript?: boolean; taskName?: string } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vietdub-host-'));
  tempDirs.push(dir);
  const backendPath = path.join(dir, 'fake-backend.mjs');
  fs.writeFileSync(backendPath, FAKE_BACKEND);
  return freePort().then(port => {
    ports.push(port);
    const startScript = path.join(dir, 'start_backend.ps1');
    // Giống start_backend.ps1 thật: nhận -NodeExecutable rồi chạy node.
    if (options.withScript !== false) {
      fs.writeFileSync(startScript, `param([string]$NodeExecutable = '')\r\n& $NodeExecutable '${backendPath}' ${port} ${options.warmupMs ?? 0}\r\n`);
    }
    const configPath = path.join(dir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      repoRoot: dir,
      startScript,
      nodeExecutable: process.execPath,
      healthUrl: `http://127.0.0.1:${port}/health`,
      stateDir: path.join(dir, 'state'),
      logPath: path.join(dir, 'logs', 'backend.log'),
      allowedOrigins: options.allowedOrigins ?? [ORIGIN, FIREFOX_ID],
      ...(options.taskName ? { taskName: options.taskName } : {})
    }));
    return { dir, port, configPath, healthUrl: `http://127.0.0.1:${port}/health` };
  });
}

async function quitBackend(port: number): Promise<void> {
  await fetch(`http://127.0.0.1:${port}/quit`, { signal: AbortSignal.timeout(1_500) }).catch(() => undefined);
}

afterEach(async () => {
  for (const port of ports.splice(0)) await quitBackend(port);
  await wait(150);
  // Tiến trình PowerShell bọc backend giả có thể còn giữ thư mục làm việc vài trăm ms sau khi backend thoát.
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
});

describe('native messaging host: giao thức và an toàn', () => {
  it('lệnh lạ, thiếu lệnh hoặc JSON hỏng đều bị từ chối; trường "script" do extension gửi bị bỏ qua', async () => {
    // Không có script khởi động cấu hình sẵn: nếu host nghe theo "script" của extension thì sẽ chạy evil.ps1.
    const { configPath, dir } = await makeSetup({ withScript: false });
    fs.writeFileSync(path.join(dir, 'evil.ps1'), `Set-Content '${path.join(dir, 'pwned.txt')}' 'x'`);
    const { replies, code } = await runHost(configPath, [{ command: 'rm -rf' }, { command: 'start', script: path.join(dir, 'evil.ps1') }, 'start', {}]);
    expect(replies[0]).toEqual({ ok: false, error: 'unknown-command' });
    expect(replies[1]).toEqual({ ok: false, error: 'script-missing' });
    expect(replies[2]).toEqual({ ok: false, error: 'unknown-command' });
    expect(replies[3]).toEqual({ ok: false, error: 'unknown-command' });
    expect(code).toBe(0);
    await wait(800);
    expect(fs.existsSync(path.join(dir, 'pwned.txt'))).toBe(false);
  });

  it('origin không có trong allowedOrigins bị từ chối', async () => {
    const { configPath } = await makeSetup();
    const { replies } = await runHost(configPath, [{ command: 'status' }], 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/');
    expect(replies).toEqual([{ ok: false, error: 'origin-not-allowed' }]);
  });

  it('Firefox truyền đường dẫn manifest rồi ID add-on: ID đúng được nhận, ID lạ bị từ chối', async () => {
    const { configPath } = await makeSetup();
    const manifest = 'E:\\VietDub-AI\\native-host\\com.vietdub.backend_launcher.firefox.json';
    expect((await runHost(configPath, [{ command: 'status' }], [manifest, FIREFOX_ID])).replies).toEqual([{ ok: true, state: 'down' }]);
    expect((await runHost(configPath, [{ command: 'status' }], [manifest, 'evil@example.com'])).replies).toEqual([{ ok: false, error: 'origin-not-allowed' }]);
  });

  it('bản tin quá lớn bị từ chối và host thoát', async () => {
    const { configPath } = await makeSetup();
    const header = Buffer.alloc(4);
    header.writeUInt32LE(10 * 1024 * 1024, 0);
    const { replies, code } = await runHost(configPath, [], ORIGIN, header);
    expect(replies).toEqual([{ ok: false, error: 'message-too-large' }]);
    expect(code).toBe(1);
  });
});

describe.skipIf(process.platform !== 'win32')('native messaging host: bật backend', () => {
  it('status: down khi chưa chạy', async () => {
    const { configPath } = await makeSetup();
    const { replies } = await runHost(configPath, [{ command: 'status' }]);
    expect(replies).toEqual([{ ok: true, state: 'down' }]);
  });

  it('start: chạy script cấu hình tách rời khỏi host, ghi log; host thoát mà backend vẫn sống', async () => {
    const { configPath, healthUrl, dir } = await makeSetup();
    const { replies } = await runHost(configPath, [{ command: 'start' }]);
    expect(replies[0]).toMatchObject({ ok: true, state: 'started' });
    expect(typeof replies[0].pid).toBe('number');
    // Host đã thoát; backend giả phải tự lên và vẫn chạy.
    let state = 'down';
    for (let attempt = 0; attempt < 40 && state === 'down'; attempt += 1) {
      await wait(250);
      state = await fetch(healthUrl, { signal: AbortSignal.timeout(1_000) }).then(response => (response.ok ? 'ready' : 'warming')).catch(() => 'down');
    }
    expect(state).toBe('ready');
    // Đầu ra của backend đi vào backend.log.
    expect(fs.readFileSync(path.join(dir, 'logs', 'backend.log'), 'utf8')).toContain('fake backend listening on');
  }, 30_000);

  it('start lần hai khi backend đang khởi động: không chạy thêm bản nào (starting), rồi ready khi nạp xong', async () => {
    const { configPath, healthUrl } = await makeSetup({ warmupMs: 4_000 });
    const first = await runHost(configPath, [{ command: 'start' }]);
    expect(first.replies[0]).toMatchObject({ ok: true, state: 'started' });
    // Chờ cổng mở (503 = đang nạp model).
    let state = 'down';
    for (let attempt = 0; attempt < 40 && state === 'down'; attempt += 1) {
      await wait(250);
      state = await fetch(healthUrl, { signal: AbortSignal.timeout(1_000) }).then(response => (response.ok ? 'ready' : 'warming')).catch(() => 'down');
    }
    expect(state).toBe('warming');
    const second = await runHost(configPath, [{ command: 'start' }, { command: 'status' }]);
    expect(second.replies[0]).toEqual({ ok: true, state: 'warming' });
    expect(second.replies[1]).toEqual({ ok: true, state: 'warming' });
    await wait(4_500);
    const third = await runHost(configPath, [{ command: 'start' }]);
    expect(third.replies[0]).toEqual({ ok: true, state: 'ready' });
  }, 40_000);

  it('start khi backend vừa được bật nhưng cổng chưa mở: trả starting thay vì chạy lần hai', async () => {
    const { configPath, dir } = await makeSetup();
    fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
    // Giả lập lần bật trước còn sống (chính tiến trình test) và mới cách đây 5 giây.
    fs.writeFileSync(path.join(dir, 'state', 'backend-launch.json'), JSON.stringify({ pid: process.pid, startedAt: Date.now() - 5_000 }));
    const { replies } = await runHost(configPath, [{ command: 'start' }]);
    expect(replies[0]).toEqual({ ok: true, state: 'starting', pid: process.pid });
    expect(fs.existsSync(path.join(dir, 'logs', 'backend.log'))).toBe(false);
  });

  it('tác vụ nền chưa được đăng ký (schtasks /run lỗi): dùng cách dự phòng Start-Process và vẫn bật được backend', async () => {
    const { configPath, healthUrl } = await makeSetup({ taskName: 'VietDub AI Backend KHONG-TON-TAI-TEST' });
    const { replies } = await runHost(configPath, [{ command: 'start' }]);
    expect(replies[0]).toMatchObject({ ok: true, state: 'started' });
    expect(typeof replies[0].pid).toBe('number');
    let state = 'down';
    for (let attempt = 0; attempt < 40 && state === 'down'; attempt += 1) {
      await wait(250);
      state = await fetch(healthUrl, { signal: AbortSignal.timeout(1_000) }).then(response => (response.ok ? 'ready' : 'warming')).catch(() => 'down');
    }
    expect(state).toBe('ready');
  }, 30_000);

  it('thiếu script khởi động: báo script-missing', async () => {
    const { configPath } = await makeSetup({ withScript: false });
    const { replies } = await runHost(configPath, [{ command: 'start' }]);
    expect(replies[0]).toEqual({ ok: false, error: 'script-missing' });
  });
});
