// Đóng gói bản Firefox để cài cố định (không phải add-on tạm thời ở about:debugging).
//   node scripts/firefox-package.mjs lint   kiểm tra dist/firefox bằng bộ kiểm tra của addons.mozilla.org (AMO), không gửi gì lên mạng
//   node scripts/firefox-package.mjs sign   gửi dist/firefox cho AMO ký ở kênh "unlisted" (tự phân phối, không công khai trên AMO)
//                                           rồi tải về tệp .xpi đã ký vào packages/extension/dist/firefox-signed/
// Firefox bản thường chỉ cài cố định tiện ích đã được Mozilla ký. Khóa API lấy ở https://addons.mozilla.org/developers/addon/api/key/,
// đặt WEB_EXT_API_KEY / WEB_EXT_API_SECRET trong biến môi trường hoặc trong tệp .env ở gốc repo (không commit).
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const distDir = path.join(rootDir, 'packages/extension/dist/firefox');
const signedDir = path.join(rootDir, 'packages/extension/dist/firefox-signed');
const webExt = path.join(rootDir, 'node_modules/web-ext/bin/web-ext.js');
const KEY_NAMES = ['WEB_EXT_API_KEY', 'WEB_EXT_API_SECRET'];

function fail(message) {
  console.error(`[Firefox] ${message}`);
  process.exit(1);
}

function runWebExt(args, env = process.env) {
  const result = spawnSync(process.execPath, [webExt, ...args], { cwd: rootDir, env, stdio: 'inherit' });
  if (result.error) fail(`Không chạy được web-ext: ${result.error.message}`);
  return result.status ?? 1;
}

/** Lấy khóa AMO từ biến môi trường, thiếu thì đọc .env ở gốc repo. Không bao giờ in giá trị khóa. */
function loadAmoKeys() {
  const keys = Object.fromEntries(KEY_NAMES.map((name) => [name, process.env[name]?.trim() || '']));
  const envFile = path.join(rootDir, '.env');
  if (KEY_NAMES.some((name) => !keys[name]) && fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
      const match = /^\s*(WEB_EXT_API_KEY|WEB_EXT_API_SECRET)\s*=\s*(.*?)\s*$/.exec(line);
      if (match && !keys[match[1]]) keys[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  }
  const missing = KEY_NAMES.filter((name) => !keys[name]);
  if (missing.length > 0) {
    fail(
      `Thiếu ${missing.join(', ')}. Tạo khóa ở https://addons.mozilla.org/developers/addon/api/key/ ` +
        '(JWT issuer -> WEB_EXT_API_KEY, JWT secret -> WEB_EXT_API_SECRET) rồi thêm hai dòng đó vào .env ở gốc repo.'
    );
  }
  return keys;
}

/** AMO không ký lại cùng một phiên bản, nên mỗi lần ký đóng dấu phiên bản theo thời điểm: <major>.<minor>.<YYYYMMDD>.<HHMMSS>.
 *  Số luôn tăng nên Firefox coi tệp mới là bản cập nhật của tiện ích đã cài. */
function stampVersion() {
  const manifestPath = path.join(distDir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const [major = '1', minor = '0'] = String(manifest.version).split('.');
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const time = Number(`${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`);
  manifest.version = `${major}.${minor}.${date}.${time}`;
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest.version;
}

/** Mở tệp .xpi trong Firefox đang chạy: Firefox hiện hộp thoại "Add ...?" của chính nó, người dùng bấm Add là cài/cập nhật xong.
 *  Trả false nếu không tìm thấy Firefox (khi đó cài tay). */
function openInFirefox(xpiPath) {
  const candidates = [
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Microsoft/WindowsApps/firefox.exe'), // bản Microsoft Store
    'C:/Program Files/Mozilla Firefox/firefox.exe',
    'C:/Program Files (x86)/Mozilla Firefox/firefox.exe'
  ].filter(Boolean);
  const firefox = candidates.find((candidate) => fs.existsSync(candidate));
  if (!firefox) return false;
  spawn(firefox, [xpiPath], { detached: true, stdio: 'ignore' }).unref();
  return true;
}

const command = process.argv[2];
if (!fs.existsSync(webExt)) fail('Chưa cài web-ext. Chạy "npm install" ở gốc repo.');
if (!fs.existsSync(path.join(distDir, 'manifest.json'))) fail('Chưa có bản build Firefox. Chạy "npm run build:firefox" trước.');

if (command === 'lint') {
  process.exit(runWebExt(['lint', '--source-dir', distDir, '--no-input']));
} else if (command === 'sign') {
  const keys = loadAmoKeys();
  if (runWebExt(['lint', '--source-dir', distDir, '--no-input']) !== 0) fail('Bản build còn lỗi kiểm tra của AMO, sửa trước khi ký.');
  const version = stampVersion();
  console.log(`[Firefox] Gửi phiên bản ${version} cho addons.mozilla.org ký (kênh unlisted, không công khai)...`);
  fs.mkdirSync(signedDir, { recursive: true });
  const status = runWebExt(
    ['sign', '--channel', 'unlisted', '--source-dir', distDir, '--artifacts-dir', signedDir, '--no-input'],
    { ...process.env, ...keys }
  );
  if (status !== 0) fail('Ký không thành công (xem lỗi ở trên).');
  const signed = fs
    .readdirSync(signedDir)
    .filter((name) => name.endsWith('.xpi') && name.includes(version))
    .map((name) => path.join(signedDir, name));
  if (signed.length === 0) fail(`Không thấy tệp .xpi của phiên bản ${version} trong ${signedDir}.`);
  const latest = path.join(signedDir, 'vietdub-ai-firefox.xpi');
  fs.copyFileSync(signed[0], latest);
  console.log(`[Firefox] Đã ký: ${latest}`);
  if (!process.argv.includes('--no-open') && openInFirefox(latest)) {
    console.log('[Firefox] Đã mở tệp trong Firefox: bấm "Add" ở hộp thoại để cài/cập nhật.');
  } else {
    console.log('[Firefox] Cài: Firefox -> about:addons -> bánh răng -> "Install Add-on From File..." -> chọn tệp trên.');
  }
} else {
  fail('Dùng: node scripts/firefox-package.mjs <lint|sign>');
}
