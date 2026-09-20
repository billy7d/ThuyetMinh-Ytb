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
  expectedSha256: string;
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
  if (!Number.isSafeInteger(request.expectedSizeBytes) || request.expectedSizeBytes <= 0) {
    throw new Error('expectedSizeBytes must be a positive integer');
  }
  const expectedSha256 = request.expectedSha256.toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(expectedSha256)) throw new Error('expectedSha256 must be a SHA-256 hex digest');
  if (request.allowedHosts?.length && !request.allowedHosts.includes(url.hostname)) {
    throw new Error(`Model source host is not allow-listed: ${url.hostname}`);
  }

  const fetchImpl = request.fetchImpl || fetch;
  const response = await fetchImpl(url, { redirect: 'error' });
  if (!response.ok || !response.body) {
    throw new Error(`Model download failed with HTTP ${response.status}`);
  }
  const finalUrl = new URL(response.url || url.toString());
  if (finalUrl.protocol !== 'https:') throw new Error('Model download redirect was not HTTPS');
  if (request.allowedHosts?.length && !request.allowedHosts.includes(finalUrl.hostname)) {
    throw new Error(`Model download redirect host is not allow-listed: ${finalUrl.hostname}`);
  }

  const destination = path.resolve(request.destination);
  const tempPath = `${destination}.part-${process.pid}-${Date.now()}`;
  await mkdir(path.dirname(destination), { recursive: true });
  const handle = await open(tempPath, 'wx');
  const digest = createHash('sha256');
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
      await handle.write(chunk);
    }
    await handle.close();
    const sha256 = digest.digest('hex');
    if (sizeBytes !== request.expectedSizeBytes) throw new Error(`Model size mismatch: expected ${request.expectedSizeBytes}, got ${sizeBytes}`);
    if (sha256 !== expectedSha256) throw new Error(`Model SHA-256 mismatch: expected ${expectedSha256}, got ${sha256}`);
    await rename(tempPath, destination);
    return { url: finalUrl.toString(), destination, sizeBytes, sha256 };
  } catch (error) {
    await handle.close().catch(() => {});
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}
