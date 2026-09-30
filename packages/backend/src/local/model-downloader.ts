import { createHash } from 'node:crypto';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';

export interface VerifiedModelDownload {
  url: string;
  destination: string;
  sizeBytes: number;
  sha256: string;
}

export interface ModelDownloadRequest {
  url: string;
  destination: string;
  expectedSizeBytes: number;
  expectedSha256?: string;
  expectedGitBlobSha1?: string;
  /** Must be true only after the operator saw the license/source notice. */
  consentAccepted: boolean;
  /** Optional allow-list for the exact upstream hosts recorded in the manifest. */
  allowedHosts?: string[];
  fetchImpl?: typeof fetch;
}

/**
 * Explicit, verified model download helper. It is never called by startup;
 * callers must pass consentAccepted=true and a pinned size/checksum.
 */
export async function downloadVerifiedModel(request: ModelDownloadRequest): Promise<VerifiedModelDownload> {
  if (!request.consentAccepted) {
    throw new Error('Model download requires explicit consent after showing source, revision and license information');
  }
  const url = new URL(request.url);
  if (url.protocol !== 'https:') throw new Error('Model downloads require HTTPS');
  if (url.username || url.password) throw new Error('Model download URL must not contain credentials');
  if (url.port) throw new Error('Model download URL must use the default HTTPS port');
  if (!Number.isSafeInteger(request.expectedSizeBytes) || request.expectedSizeBytes <= 0) {
    throw new Error('expectedSizeBytes must be a positive integer');
  }
  const expectedSha256 = request.expectedSha256?.toLowerCase();
  if (expectedSha256 && !/^[a-f0-9]{64}$/.test(expectedSha256)) {
    throw new Error('expectedSha256 must be a SHA-256 hex digest');
  }
  const expectedGitBlobSha1 = request.expectedGitBlobSha1?.toLowerCase();
  if (expectedGitBlobSha1 && !/^[a-f0-9]{40}$/.test(expectedGitBlobSha1)) {
    throw new Error('expectedGitBlobSha1 must be a Git blob SHA-1 digest');
  }
  if (!expectedSha256 && !expectedGitBlobSha1) {
    throw new Error('A pinned SHA-256 or Git blob SHA-1 digest is required');
  }
  const allowedHosts = new Set(
    (request.allowedHosts?.length ? request.allowedHosts : [url.hostname])
      .map(host => host.trim().toLowerCase())
      .filter(Boolean)
  );
  if (!allowedHosts.has(url.hostname)) {
    throw new Error(`Model source host is not allow-listed: ${url.hostname}`);
  }

  const fetchImpl = request.fetchImpl || fetch;
  let currentUrl = url;
  let response: Response | undefined;
  for (let redirectCount = 0; redirectCount <= 5; redirectCount++) {
    response = await fetchImpl(currentUrl, { redirect: 'manual' });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    if (redirectCount === 5) throw new Error('Model download exceeded the redirect limit');
    const location = response.headers.get('location');
    if (!location) throw new Error('Model download redirect is missing a location');
    const nextUrl = new URL(location, currentUrl);
    // Chỉ tải tiếp sau khi đích redirect đã qua kiểm tra HTTPS và allow-list.
    if (nextUrl.protocol !== 'https:') throw new Error('Model download redirect must use HTTPS');
    if (nextUrl.username || nextUrl.password) throw new Error('Model download redirect must not contain credentials');
    if (nextUrl.port) throw new Error('Model download redirect must use the default HTTPS port');
    if (!allowedHosts.has(nextUrl.hostname)) {
      throw new Error(`Model download redirect host is not allow-listed: ${nextUrl.hostname}`);
    }
    await response.body?.cancel().catch(() => {});
    currentUrl = nextUrl;
  }
  if (!response) throw new Error('Model download did not return a response');
  if (!response.ok || !response.body) {
    throw new Error(`Model download failed with HTTP ${response.status}`);
  }

  const destination = path.resolve(request.destination);
  const tempPath = `${destination}.part-${process.pid}-${Date.now()}`;
  await mkdir(path.dirname(destination), { recursive: true });
  const handle = await open(tempPath, 'wx');
  const digest = createHash('sha256');
  // Git blob SHA-1 xác thực file thường; SHA-256 local vẫn luôn được tạo riêng.
  const gitBlobDigest = expectedGitBlobSha1
    ? createHash('sha1').update(`blob ${request.expectedSizeBytes}\0`)
    : undefined;
  let sizeBytes = 0;
  try {
    const reader = response.body.getReader();
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = Buffer.from(next.value);
      sizeBytes += chunk.length;
      if (sizeBytes > request.expectedSizeBytes) throw new Error('Downloaded model exceeds the pinned size');
      digest.update(chunk);
      gitBlobDigest?.update(chunk);
      await handle.write(chunk);
    }
    await handle.close();
    const sha256 = digest.digest('hex');
    if (sizeBytes !== request.expectedSizeBytes) throw new Error(`Model size mismatch: expected ${request.expectedSizeBytes}, got ${sizeBytes}`);
    if (expectedSha256 && sha256 !== expectedSha256) {
      throw new Error(`Model SHA-256 mismatch: expected ${expectedSha256}, got ${sha256}`);
    }
    const gitBlobSha1 = gitBlobDigest?.digest('hex');
    if (expectedGitBlobSha1 && gitBlobSha1 !== expectedGitBlobSha1) {
      throw new Error(`Git blob SHA-1 mismatch: expected ${expectedGitBlobSha1}, got ${gitBlobSha1}`);
    }
    await rename(tempPath, destination);
    // Không trả query của URL CDN có thể chứa token ký tạm thời.
    const publicUrl = new URL(url);
    publicUrl.search = '';
    publicUrl.hash = '';
    return { url: publicUrl.toString(), destination, sizeBytes, sha256 };
  } catch (error) {
    await handle.close().catch(() => {});
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}
