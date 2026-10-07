#!/usr/bin/env node
// Native messaging host của VietDub AI: cho extension bật backend local khi người dùng quên chạy start_backend.ps1.
//
// Giao thức Chrome/Firefox: mỗi bản tin là 4 byte độ dài (little-endian) + JSON UTF-8, qua stdin/stdout. Extension dùng
// runtime.sendNativeMessage (một câu hỏi, một câu trả lời); host thoát khi stdin đóng.
//
// An toàn: host chỉ hiểu hai lệnh cố định, KHÔNG nhận đường dẫn/tham số/biến môi trường nào từ extension.
//   {"command":"status"} -> {"ok":true,"state":"down|warming|ready"}
//   {"command":"start"}  -> {"ok":true,"state":"ready|warming|starting|started","pid":n}   (đã chạy thì không chạy thêm)
// Lệnh chạy backend (script, node, thư mục log) nằm trong tệp cấu hình do install_native_host.ps1 tạo; chỉ extension có ID
// trong allowed_origins (Chrome) / allowed_extensions (Firefox) của manifest host mới gọi được host này; trình duyệt tự kiểm tra,
// host kiểm tra lại: Chrome truyền origin "chrome-extension://<id>/", Firefox truyền đường dẫn manifest host rồi ID add-on.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_MESSAGE_BYTES = 64 * 1024;
const HEALTH_TIMEOUT_MS = 2_500;
/** pid đã ghi còn sống và chưa quá chừng này thì coi là backend đang khởi động (nạp model có thể mất 1-2 phút). */
const STARTING_WINDOW_MS = 10 * 60_000;

const here = path.dirname(fileURLToPath(import.meta.url));

export function loadConfig(env = process.env) {
  const installRoot = env.VIETDUB_INSTALL_ROOT || 'E:\\VietDub-AI';
  const defaults = {
    repoRoot: path.resolve(here, '..', '..'),
    nodeExecutable: process.execPath,
    healthUrl: 'http://127.0.0.1:8080/health',
    stateDir: path.join(installRoot, 'native-host'),
    logPath: path.join(installRoot, 'logs', 'backend.log'),
    allowedOrigins: []
  };
  let fromFile = {};
  if (env.VIETDUB_HOST_CONFIG) fromFile = JSON.parse(fs.readFileSync(env.VIETDUB_HOST_CONFIG, 'utf8'));
  const config = { ...defaults, ...fromFile };
  config.startScript = config.startScript || path.join(config.repoRoot, 'runtime', 'start_backend.ps1');
  return config;
}

/** 'down' = không có gì trả lời; 'warming' = backend trả lời nhưng chưa sẵn sàng (đang nạp model); 'ready'. */
export async function probeBackend(healthUrl, fetchImpl = fetch) {
  try {
    const response = await fetchImpl(healthUrl, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    return response.ok ? 'ready' : 'warming';
  } catch {
    return 'down';
  }
}

/** Tác vụ theo yêu cầu do install_native_host.ps1 đăng ký đang chạy (backend khởi động bằng Task Scheduler). */
function taskRunning(taskName) {
  const result = spawnSync('schtasks.exe', ['/query', '/tn', taskName, '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
  return result.status === 0 && /"Running"/i.test(result.stdout || '');
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function readState(config) {
  try {
    return JSON.parse(fs.readFileSync(path.join(config.stateDir, 'backend-launch.json'), 'utf8'));
  } catch {
    return null;
  }
}

// Chạy backend bằng Start-Process của PowerShell. Đã đo trên Windows 11: tiến trình con tạo bằng spawn() của Node (kể cả `cmd /c start`)
// chết ngay khi host thoát, spawn({detached:true}) thì powershell.exe thoát mã 0 mà không chạy gì (mất console); chỉ Start-Process
// cho tiến trình sống tiếp độc lập với host. Giá trị đường dẫn đi qua biến môi trường, không ghép vào chuỗi lệnh.
const LAUNCH_COMMAND = [
  "$a = @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',('\"{0}\"' -f $env:VIETDUB_LAUNCH_SCRIPT),'-NodeExecutable',('\"{0}\"' -f $env:VIETDUB_LAUNCH_NODE));",
  "(Start-Process -FilePath powershell.exe -ArgumentList $a -WindowStyle Hidden -WorkingDirectory $env:VIETDUB_LAUNCH_CWD",
  "-RedirectStandardOutput $env:VIETDUB_LAUNCH_LOG -RedirectStandardError $env:VIETDUB_LAUNCH_ERR -PassThru).Id"
].join(' ');

// Cách ưu tiên: Task Scheduler. Firefox gom tiến trình host vào một job object và giết cả nhóm khi host thoát (đo: backend bật bằng
// Start-Process từ Firefox chết trong ~1 s, log trống), còn tiến trình do Task Scheduler tạo nằm ngoài nhóm đó. Chrome thì cả hai đều sống.
function launchViaTask(config) {
  if (!config.taskName) return false;
  const result = spawnSync('schtasks.exe', ['/run', '/tn', config.taskName], { windowsHide: true, stdio: 'ignore', timeout: 15_000 });
  if (result.status !== 0) return false;
  fs.mkdirSync(config.stateDir, { recursive: true });
  fs.writeFileSync(path.join(config.stateDir, 'backend-launch.json'), JSON.stringify({ via: 'task', startedAt: Date.now() }));
  return true;
}

function launchBackend(config) {
  if (launchViaTask(config)) return undefined;
  fs.mkdirSync(path.dirname(config.logPath), { recursive: true });
  fs.mkdirSync(config.stateDir, { recursive: true });
  const errPath = config.logPath.replace(/(\.log)?$/, '.err.log');
  // Start-Process mở tệp log ở chế độ ghi đè: backend.log / backend.err.log luôn là của lần bật gần nhất.
  // Kết quả (pid) ghi ra tệp, không qua pipe: backend kế thừa pipe stdout của PowerShell khởi động nên pipe không bao giờ đóng
  // và host sẽ chờ tới hết thời gian dù backend đã chạy.
  const pidPath = path.join(config.stateDir, 'launch-pid.txt');
  fs.rmSync(pidPath, { force: true });
  const out = fs.openSync(pidPath, 'w');
  const launcher = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', LAUNCH_COMMAND], {
    cwd: config.repoRoot,
    windowsHide: true,
    timeout: 30_000,
    stdio: ['ignore', out, 'ignore'],
    env: {
      ...process.env,
      VIETDUB_LAUNCH_SCRIPT: config.startScript,
      VIETDUB_LAUNCH_NODE: config.nodeExecutable,
      VIETDUB_LAUNCH_CWD: config.repoRoot,
      VIETDUB_LAUNCH_LOG: config.logPath,
      VIETDUB_LAUNCH_ERR: errPath
    }
  });
  fs.closeSync(out);
  if (launcher.error || launcher.status !== 0) throw new Error(`Không chạy được backend (mã ${launcher.status ?? launcher.error?.message})`);
  const pid = Number.parseInt(fs.readFileSync(pidPath, 'utf8').trim().split(/\s+/).pop() || '', 10);
  if (!Number.isInteger(pid)) throw new Error('Không đọc được pid của backend');
  fs.writeFileSync(path.join(config.stateDir, 'backend-launch.json'), JSON.stringify({ pid, startedAt: Date.now() }));
  return pid;
}

export async function handleCommand(message, config, deps = {}) {
  const probe = deps.probe || (() => probeBackend(config.healthUrl));
  const launch = deps.launch || (() => launchBackend(config));
  const command = message && typeof message === 'object' ? message.command : undefined;
  if (command !== 'status' && command !== 'start') return { ok: false, error: 'unknown-command' };

  const state = await probe();
  if (command === 'status' || state !== 'down') return { ok: true, state };

  const previous = readState(config);
  const stillRunning = previous && (previous.via === 'task' ? taskRunning(config.taskName) : isAlive(previous.pid));
  if (stillRunning && Date.now() - previous.startedAt < STARTING_WINDOW_MS) {
    return { ok: true, state: 'starting', ...(previous.pid ? { pid: previous.pid } : {}) };
  }
  if (!fs.existsSync(config.startScript)) return { ok: false, error: 'script-missing' };
  try {
    const pid = launch();
    return { ok: true, state: 'started', ...(pid ? { pid } : {}) };
  } catch (error) {
    return { ok: false, error: 'launch-failed', detail: String(error?.message || error).slice(0, 200) };
  }
}

export function encodeMessage(value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

/** Tách các bản tin hoàn chỉnh từ bộ đệm; trả {messages, rest, error}. */
export function decodeMessages(buffer) {
  const messages = [];
  let offset = 0;
  while (buffer.length - offset >= 4) {
    const length = buffer.readUInt32LE(offset);
    if (length > MAX_MESSAGE_BYTES) return { messages, rest: Buffer.alloc(0), error: 'message-too-large' };
    if (buffer.length - offset - 4 < length) break;
    const raw = buffer.subarray(offset + 4, offset + 4 + length).toString('utf8');
    offset += 4 + length;
    try {
      messages.push(JSON.parse(raw));
    } catch {
      messages.push(undefined);
    }
  }
  return { messages, rest: buffer.subarray(offset), error: undefined };
}

async function main() {
  const config = loadConfig();
  const callers = process.argv.slice(2);
  let buffer = Buffer.alloc(0);
  let chain = Promise.resolve();
  const reply = value => process.stdout.write(encodeMessage(value));

  process.stdin.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    const decoded = decodeMessages(buffer);
    buffer = decoded.rest;
    if (decoded.error) {
      reply({ ok: false, error: decoded.error });
      process.exit(1);
    }
    for (const message of decoded.messages) {
      chain = chain.then(async () => {
        const allowed = config.allowedOrigins;
        if (allowed.length > 0 && !callers.some(caller => allowed.includes(caller))) return reply({ ok: false, error: 'origin-not-allowed' });
        reply(await handleCommand(message, config));
      });
    }
  });
  process.stdin.on('end', () => {
    void chain.then(() => process.exit(0));
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(`${String(error?.stack || error)}\n`);
    process.exit(1);
  });
}
