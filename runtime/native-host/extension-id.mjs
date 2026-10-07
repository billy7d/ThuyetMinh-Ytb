// In ID extension Chrome tính từ trường "key" của manifest (dùng cho allowed_origins của native messaging host).
//   node runtime/native-host/extension-id.mjs [đường dẫn manifest.chrome.json]
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** ID = 32 ký tự đầu của SHA-256(khóa công khai DER), mỗi nibble ánh xạ 0-f -> a-p. */
export function extensionIdFromKey(base64Key) {
  const der = Buffer.from(base64Key, 'base64');
  return [...crypto.createHash('sha256').update(der).digest().subarray(0, 16)]
    .map(byte => 'abcdefghijklmnop'[byte >> 4] + 'abcdefghijklmnop'[byte & 15])
    .join('');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const manifestPath = process.argv[2]
    || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../packages/extension/manifest.chrome.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (typeof manifest.key !== 'string' || !manifest.key) {
    console.error('manifest không có trường "key".');
    process.exit(1);
  }
  console.log(extensionIdFromKey(manifest.key));
}
