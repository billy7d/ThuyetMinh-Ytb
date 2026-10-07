// Thử đầu-cuối nút "Bật backend" trên Chrome thật (đã cài sẵn): nạp extension, mở popup, bấm nút, chờ backend thật lên,
// rồi đóng Chrome và kiểm tra backend vẫn sống. Yêu cầu: đã chạy runtime/install_native_host.ps1 và npm run build:chrome,
// cổng 8080 đang trống. Dùng profile riêng trên ổ E:, không đụng profile Chrome của người dùng.
//   node runtime/native_host_e2e.mjs [--keep]   (--keep: không tắt backend sau khi thử)
import { execFileSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extensionRoot = path.join(repositoryRoot, 'packages', 'extension', 'dist', 'chrome');
const installRoot = 'E:\\VietDub-AI';
const profileRoot = path.join(installRoot, 'browser-profile', 'native-host-e2e');
const chromeExecutable = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const expectedId = execFileSync(process.execPath, [path.join(repositoryRoot, 'runtime', 'native-host', 'extension-id.mjs')], { encoding: 'utf8' }).trim();
const keep = process.argv.includes('--keep');
const report = { startedAt: new Date().toISOString(), expectedId, steps: [] };
const step = (name, data = {}) => {
  report.steps.push({ at: new Date().toISOString(), name, ...data });
  console.error(`[e2e] ${name}`, Object.keys(data).length ? JSON.stringify(data) : '');
};
const health = async () => {
  try {
    const response = await fetch('http://127.0.0.1:8080/health', { signal: AbortSignal.timeout(2000) });
    return response.status;
  } catch {
    return 0;
  }
};
const listenerPid = () => {
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', "(Get-NetTCPConnection -LocalPort 8080 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess"], { encoding: 'utf8' }).trim();
    return out ? Number(out) : null;
  } catch {
    return null;
  }
};

if (await health() !== 0) throw new Error('Cổng 8080 đang có backend chạy; tắt nó trước khi thử để kết quả không bị lẫn.');
await rm(profileRoot, { recursive: true, force: true });
await mkdir(profileRoot, { recursive: true });

let context;
try {
  context = await chromium.launchPersistentContext(profileRoot, {
    executablePath: chromeExecutable,
    headless: false,
    args: ['--enable-unsafe-extension-debugging', '--no-first-run', '--no-default-browser-check'],
    ignoreDefaultArgs: ['--disable-extensions'],
    viewport: { width: 520, height: 780 }
  });
  const browserSession = await context.browser().newBrowserCDPSession();
  const { id } = await browserSession.send('Extensions.loadUnpacked', { path: extensionRoot });
  step('extension-loaded', { id, matchesExpected: id === expectedId });
  if (id !== expectedId) throw new Error(`ID extension ${id} khác ID trong allowed_origins ${expectedId}`);

  const page = await context.newPage();
  await page.goto(`chrome-extension://${id}/src/popup/index.html`);
  await page.waitForSelector('text=Chưa kết nối backend local', { timeout: 15_000 });
  const button = page.getByRole('button', { name: /Bật backend/ });
  await button.waitFor({ timeout: 5_000 });
  step('popup-shows-launch-button', { text: await page.locator('text=Chưa kết nối backend local').innerText() });

  const clickedAt = Date.now();
  await button.click();
  await page.waitForSelector('text=Đang bật backend và nạp model', { timeout: 15_000 });
  step('launch-requested', { afterMs: Date.now() - clickedAt });
  const failure = page.locator('[role=alert]');
  const outcome = await Promise.race([
    page.waitForSelector('text=Backend local sẵn sàng', { timeout: 240_000 }).then(() => 'ready'),
    failure.first().waitFor({ timeout: 240_000 }).then(async () => `failure: ${await failure.first().innerText()}`)
  ]);
  step('popup-outcome', { outcome, afterMs: Date.now() - clickedAt, health: await health() });
  await page.screenshot({ path: path.join(installRoot, 'evidence', 'native-host-e2e-popup.png') });
  report.popupOutcome = outcome;
  report.readyAfterMs = Date.now() - clickedAt;
} finally {
  // Backend bật từ Chrome kế thừa đường ống CDP của Playwright nên context.close() có thể không bao giờ trả về: đóng có giới hạn
  // thời gian rồi tắt tiến trình Chrome của profile thử (không đụng Chrome của người dùng).
  await Promise.race([context?.close().catch(() => undefined), new Promise(resolve => setTimeout(resolve, 10_000))]);
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-Command', "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Where-Object { $_.CommandLine -like '*native-host-e2e*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"], { stdio: 'ignore' });
  } catch { /* đã đóng */ }
}

await new Promise(resolve => setTimeout(resolve, 3000));
report.healthAfterChromeClosed = await health();
step('chrome-closed', { health: report.healthAfterChromeClosed });
const pid = listenerPid();
report.backendPid = pid;
if (!keep && pid) {
  execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  step('backend-stopped', { pid });
}
report.verdict = report.popupOutcome === 'ready' && report.healthAfterChromeClosed === 200 ? 'PASS' : 'FAIL';
await mkdir(path.join(installRoot, 'evidence'), { recursive: true });
const reportPath = path.join(installRoot, 'evidence', `native-host-e2e-${Date.now()}.json`);
await writeFile(reportPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ verdict: report.verdict, readyAfterMs: report.readyAfterMs, healthAfterChromeClosed: report.healthAfterChromeClosed, reportPath }, null, 2));
process.exit(report.verdict === 'PASS' ? 0 : 1);
