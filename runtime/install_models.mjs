// Cài đúng bộ model đã ghim; mọi cache, file tạm và trọng số đều ở ổ E:.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { downloadVerifiedModel } from '../packages/backend/dist/local/model-downloader.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const installRootArg = process.argv.indexOf('--install-root');
const installRoot = path.resolve(installRootArg >= 0 ? process.argv[installRootArg + 1] : 'E:\\VietDub-AI');
const confirmed = process.argv.includes('--confirm-model-selection');
const selection = JSON.parse(readFileSync(path.join(repoRoot, 'models', 'manifest.example.json'), 'utf8'));
const modelRoot = path.join(installRoot, 'models');
const cacheRoot = path.join(installRoot, 'cache');
const expectedCodec = selection.models.tts.dependencies?.codec;
const allowedHosts = ['huggingface.co', 'us.aws.cdn.hf.co'];
const zeroSha256 = '0'.repeat(64);

if (!confirmed) {
  console.error('Từ chối tải: cần --confirm-model-selection sau khi operator xác nhận MODEL_SELECTION.md.');
  process.exit(2);
}
if (!expectedCodec) throw new Error('Thiếu revision/license codec đã ghim trong manifest mẫu.');
if (process.platform === 'win32' && path.parse(installRoot).root.toUpperCase() !== 'E:\\') {
  throw new Error('MODEL_ROOT và cache phải nằm trên ổ E:.');
}
if (existsSync(path.join(modelRoot, 'manifest.json'))) {
  throw new Error('manifest.json đã tồn tại; không ghi đè dữ liệu model hiện có.');
}

const cachePaths = {
  HF_HOME: path.join(cacheRoot, 'huggingface'),
  HUGGINGFACE_HUB_CACHE: path.join(cacheRoot, 'huggingface', 'hub'),
  TRANSFORMERS_CACHE: path.join(cacheRoot, 'huggingface', 'transformers'),
  PIP_CACHE_DIR: path.join(cacheRoot, 'pip'),
  TEMP: path.join(cacheRoot, 'temp'),
  TMP: path.join(cacheRoot, 'temp'),
  TORCH_HOME: path.join(cacheRoot, 'torch'),
  XDG_CACHE_HOME: path.join(cacheRoot, 'xdg'),
  PYTHONPYCACHEPREFIX: path.join(cacheRoot, 'pycache')
};
mkdirSync(modelRoot, { recursive: true });
for (const [name, value] of Object.entries(cachePaths)) {
  mkdirSync(value, { recursive: true });
  process.env[name] = value;
}
process.env.HF_HUB_DISABLE_TELEMETRY = '1';
process.env.GRADIO_ANALYTICS_ENABLED = 'False';

const sourceSpecs = [
  ...['stt', 'translation', 'tts'].map(component => ({
    component,
    modelId: selection.models[component].modelId,
    revision: selection.models[component].revision,
    license: selection.models[component].license.model.toLowerCase(),
    upstreamUrl: selection.models[component].upstreamUrl
  })),
  {
    component: 'codec',
    modelId: expectedCodec.modelId,
    revision: expectedCodec.revision,
    license: expectedCodec.license.toLowerCase(),
    upstreamUrl: expectedCodec.upstreamUrl
  }
];
const metadataByModel = new Map();

for (const source of sourceSpecs) {
  const apiUrl = `https://huggingface.co/api/models/${source.modelId}/revision/${source.revision}?blobs=true`;
  const response = await fetch(apiUrl, { redirect: 'manual' });
  if (response.status !== 200) throw new Error(`Không xác minh được metadata upstream cho ${source.modelId} (HTTP ${response.status}).`);
  const metadata = await response.json();
  if (metadata.sha !== source.revision) throw new Error(`Revision upstream không khớp cho ${source.modelId}.`);
  if (String(metadata.cardData?.license ?? '').toLowerCase() !== source.license) {
    throw new Error(`License upstream không khớp cho ${source.modelId}; dừng trước khi tải model.`);
  }
  metadataByModel.set(source.modelId, metadata);
}

const downloadPlan = [];
for (const component of ['stt', 'translation', 'tts']) {
  const entry = selection.models[component];
  for (const artifact of entry.artifacts) {
    const isCodec = component === 'tts' && artifact.relativePath.startsWith('codec/');
    const source = isCodec ? expectedCodec : entry;
    const upstreamPath = isCodec ? artifact.relativePath.slice('codec/'.length) : artifact.relativePath;
    const upstreamFile = metadataByModel.get(source.modelId)?.siblings?.find(item => item.rfilename === upstreamPath);
    if (!upstreamFile || !Number.isSafeInteger(upstreamFile.size) || !upstreamFile.blobId) {
      throw new Error(`Thiếu metadata upstream cho ${source.modelId}/${upstreamPath}.`);
    }
    if (upstreamFile.size !== artifact.sizeBytes) {
      throw new Error(`Kích thước upstream thay đổi: ${source.modelId}/${upstreamPath}.`);
    }
    const lfsSha256 = upstreamFile.lfs?.sha256?.toLowerCase();
    if (artifact.sha256 !== zeroSha256 && lfsSha256 !== artifact.sha256.toLowerCase()) {
      throw new Error(`LFS SHA-256 upstream không khớp selection: ${source.modelId}/${upstreamPath}.`);
    }
    if (!lfsSha256 && !/^[a-f0-9]{40}$/i.test(upstreamFile.blobId)) {
      throw new Error(`Git blob ID upstream không hợp lệ: ${source.modelId}/${upstreamPath}.`);
    }
    downloadPlan.push({ component, entry, artifact, source, upstreamPath, upstreamFile, lfsSha256 });
  }
}
const selectedBytes = downloadPlan.reduce((total, item) => total + item.artifact.sizeBytes, 0);
if (selectedBytes !== 1_005_369_274) {
  throw new Error(`Tổng dung lượng selection thay đổi: ${selectedBytes} bytes.`);
}

const verifiedArtifacts = { stt: [], translation: [], tts: [] };
const report = {
  authorized: true,
  installRoot,
  modelRoot,
  cacheRoot,
  startedAt: new Date().toISOString(),
  sources: sourceSpecs.map(({ component, modelId, revision, license, upstreamUrl }) => ({
    component, modelId, revision, license, upstreamUrl
  })),
  artifacts: []
};

for (const item of downloadPlan) {
  const { component, entry, artifact, source, upstreamPath, upstreamFile, lfsSha256 } = item;
  const destination = path.resolve(modelRoot, entry.relativePath, artifact.relativePath);
  const relative = path.relative(path.resolve(modelRoot, entry.relativePath), destination);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Đường dẫn artifact vượt khỏi thư mục model: ${artifact.relativePath}.`);
  }
  mkdirSync(path.dirname(destination), { recursive: true });
  const urlPath = upstreamPath.split('/').map(encodeURIComponent).join('/');
  const url = `${source.upstreamUrl}/resolve/${source.revision}/${urlPath}`;
  const request = {
    url,
    destination,
    expectedSizeBytes: artifact.sizeBytes,
    consentAccepted: true,
    allowedHosts
  };
  if (lfsSha256) request.expectedSha256 = lfsSha256;
  else request.expectedGitBlobSha1 = upstreamFile.blobId;

  let localSha256;
  let disposition = 'downloaded';
  if (existsSync(destination)) {
    const existing = readFileSync(destination);
    const digest = createHash('sha256').update(existing).digest('hex');
    const gitBlob = createHash('sha1').update(`blob ${existing.length}\0`).update(existing).digest('hex');
    const matches = existing.length === artifact.sizeBytes && (lfsSha256 ? digest === lfsSha256 : gitBlob === upstreamFile.blobId);
    if (!matches) throw new Error(`Đã có file không khớp; giữ nguyên và dừng: ${artifact.relativePath}.`);
    localSha256 = digest;
    disposition = 'verified-existing';
  } else {
    const result = await downloadVerifiedModel(request);
    localSha256 = result.sha256;
  }

  const installedArtifact = {
    relativePath: artifact.relativePath,
    sizeBytes: artifact.sizeBytes,
    sha256: localSha256,
    sourceModelId: source.modelId,
    sourceRevision: source.revision,
    ...(lfsSha256 ? { upstreamLfsSha256: lfsSha256 } : { upstreamGitBlobSha1: upstreamFile.blobId })
  };
  verifiedArtifacts[component].push(installedArtifact);
  report.artifacts.push({
    component,
    modelId: source.modelId,
    revision: source.revision,
    relativePath: `${entry.relativePath}/${artifact.relativePath}`,
    sizeBytes: artifact.sizeBytes,
    sha256: localSha256,
    upstreamIntegrity: lfsSha256 ? 'LFS_SHA256' : 'GIT_BLOB_SHA1',
    upstreamDigest: lfsSha256 ?? upstreamFile.blobId,
    disposition
  });
  console.log(`${disposition}: ${source.modelId}@${source.revision.slice(0, 8)} ${upstreamPath} (${artifact.sizeBytes} bytes)`);
}

const manifest = structuredClone(selection);
manifest.generatedAt = new Date().toISOString();
for (const component of ['stt', 'translation', 'tts']) {
  manifest.models[component].artifacts = verifiedArtifacts[component];
}
const manifestPath = path.join(modelRoot, 'manifest.json');
const manifestTemp = `${manifestPath}.part-${process.pid}`;
writeFileSync(manifestTemp, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
renameSync(manifestTemp, manifestPath);
report.completedAt = new Date().toISOString();
report.artifactCount = report.artifacts.length;
report.totalBytes = report.artifacts.reduce((total, artifact) => total + artifact.sizeBytes, 0);
const evidencePath = path.join(installRoot, 'evidence', 'model-download.json');
mkdirSync(path.dirname(evidencePath), { recursive: true });
writeFileSync(evidencePath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
console.log(`Hoàn tất xác minh ${report.artifactCount} artifact (${report.totalBytes} bytes); manifest: ${manifestPath}`);
