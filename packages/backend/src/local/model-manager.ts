import { createHash } from 'node:crypto';
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import path from 'node:path';

export type LocalModelComponent = 'stt' | 'translation' | 'tts';
export type LocalModelReadiness = 'missing' | 'verifying' | 'ready' | 'error';

export interface ModelLicenseManifest {
  model: string;
  code: string;
  tokenizer: string;
  codec?: string;
  voice?: string;
  distribution: 'verified' | 'restricted' | 'unknown';
  commercialUse: 'verified' | 'restricted' | 'unknown';
  sourceCheckedAt?: string;
  notes?: string;
}

export interface ModelArtifactManifest {
  relativePath: string;
  sizeBytes: number;
  sha256: string;
}

export interface LocalModelEntry {
  component: LocalModelComponent;
  modelId: string;
  revision: string;
  upstreamUrl: string;
  relativePath: string;
  artifacts: ModelArtifactManifest[];
  license: ModelLicenseManifest;
}

export interface LocalModelManifest {
  schemaVersion: 1;
  generatedAt: string;
  models: Record<LocalModelComponent, LocalModelEntry>;
}

export interface LocalModelComponentStatus {
  component: LocalModelComponent;
  modelId?: string;
  revision?: string;
  path?: string;
  readiness: LocalModelReadiness;
  errors: string[];
}

export interface LocalModelStatus {
  manifestPath: string;
  modelRoot: string;
  ready: boolean;
  errors: string[];
  components: Record<LocalModelComponent, LocalModelComponentStatus>;
}

const COMPONENTS: LocalModelComponent[] = ['stt', 'translation', 'tts'];
const SHA256_RE = /^[a-f0-9]{64}$/i;

/**
 * Reads and verifies the operator-owned local model manifest. It does not
 * download anything and never silently accepts a missing checksum/license.
 */
export class LocalModelManager {
  readonly manifestPath: string;
  readonly modelRoot: string;
  private readonly manifest: LocalModelManifest | null;
  private readonly manifestErrors: string[];
  private readonly artifactHashCache = new Map<string, { sizeBytes: number; mtimeMs: number; ctimeMs: number; sha256: string }>();

  constructor(manifestPath: string, modelRoot = path.dirname(manifestPath)) {
    this.manifestPath = path.resolve(manifestPath);
    this.modelRoot = path.resolve(modelRoot);
    this.manifestErrors = [];
    this.manifest = this.readManifest();
  }

  getManifest(): LocalModelManifest | null {
    return this.manifest;
  }

  getStatus(): LocalModelStatus {
    const components = Object.fromEntries(
      COMPONENTS.map(component => [component, this.checkComponent(component)])
    ) as Record<LocalModelComponent, LocalModelComponentStatus>;
    const componentErrors = COMPONENTS.flatMap(component => components[component].errors);
    const errors = [...this.manifestErrors, ...componentErrors];
    return {
      manifestPath: this.manifestPath,
      modelRoot: this.modelRoot,
      ready: errors.length === 0 && COMPONENTS.every(component => components[component].readiness === 'ready'),
      errors: [...new Set(errors)],
      components
    };
  }

  getMissingConfiguration(): string[] {
    const status = this.getStatus();
    const missing: string[] = [];
    if (!existsSync(this.manifestPath)) missing.push(`LOCAL_MODEL_MANIFEST=${this.manifestPath}`);
    for (const component of COMPONENTS) {
      const componentStatus = status.components[component];
      if (componentStatus.readiness !== 'ready') missing.push(`LOCAL_${component.toUpperCase()}_MODEL`);
    }
    return [...new Set(missing)];
  }

  getModelPath(component: LocalModelComponent): string {
    const entry = this.manifest?.models[component];
    if (!entry) throw new Error(`Local model manifest has no ${component} entry`);
    return path.resolve(this.modelRoot, entry.relativePath);
  }

  private readManifest(): LocalModelManifest | null {
    if (!existsSync(this.manifestPath)) {
      this.manifestErrors.push(`Local model manifest not found: ${this.manifestPath}`);
      return null;
    }

    try {
      const parsed = JSON.parse(readFileSync(this.manifestPath, 'utf8')) as unknown;
      if (!isRecord(parsed) || parsed.schemaVersion !== 1 || !isRecord(parsed.models)) {
        throw new Error('schemaVersion 1 and models are required');
      }
      const models = {} as Record<LocalModelComponent, LocalModelEntry>;
      for (const component of COMPONENTS) {
        const raw = parsed.models[component];
        models[component] = validateEntry(component, raw);
      }
      return {
        schemaVersion: 1,
        generatedAt: requireString(parsed.generatedAt, 'generatedAt'),
        models
      };
    } catch (error) {
      this.manifestErrors.push(
        `Invalid local model manifest ${this.manifestPath}: ${error instanceof Error ? error.message : String(error)}`
      );
      return null;
    }
  }

  private checkComponent(component: LocalModelComponent): LocalModelComponentStatus {
    const entry = this.manifest?.models[component];
    if (!entry) {
      return { component, readiness: 'missing', errors: [`Missing ${component} model manifest entry`] };
    }

    const modelPath = path.resolve(this.modelRoot, entry.relativePath);
    const errors: string[] = [];
    if (!existsSync(modelPath)) {
      errors.push(`${component} model path does not exist: ${modelPath}`);
      return {
        component,
        modelId: entry.modelId,
        revision: entry.revision,
        path: modelPath,
        readiness: 'missing',
        errors
      };
    }
    if (entry.license.distribution !== 'verified') {
      errors.push(`${component} model distribution license is not verified`);
    }
    if (entry.license.commercialUse !== 'verified') {
      errors.push(`${component} model commercial-use rights are not verified`);
    }

    for (const artifact of entry.artifacts) {
      const artifactPath = path.resolve(modelPath, artifact.relativePath);
      const artifactRelative = path.relative(modelPath, artifactPath);
      if (!artifactRelative || artifactRelative === '..' || artifactRelative.startsWith(`..${path.sep}`) || path.isAbsolute(artifactRelative)) {
        errors.push(`${component} artifact escapes its model directory: ${artifact.relativePath}`);
        continue;
      }
      if (!existsSync(artifactPath)) {
        errors.push(`${component} artifact is missing: ${artifact.relativePath}`);
        continue;
      }
      let stats;
      try {
        stats = statSync(artifactPath);
      } catch (error) {
        errors.push(`${component} artifact cannot be inspected: ${artifact.relativePath}`);
        continue;
      }
      if (!stats.isFile()) {
        errors.push(`${component} artifact is not a file: ${artifact.relativePath}`);
        continue;
      }
      if (stats.size !== artifact.sizeBytes) {
        errors.push(`${component} artifact size mismatch: ${artifact.relativePath}`);
        continue;
      }
      const actualSha = this.getArtifactSha256(artifactPath, stats.size, stats.mtimeMs, stats.ctimeMs);
      if (actualSha !== artifact.sha256.toLowerCase()) {
        errors.push(`${component} artifact SHA-256 mismatch: ${artifact.relativePath}`);
      }
    }

    return {
      component,
      modelId: entry.modelId,
      revision: entry.revision,
      path: modelPath,
      readiness: errors.length === 0 ? 'ready' : 'error',
      errors
    };
  }

  private getArtifactSha256(filePath: string, sizeBytes: number, mtimeMs: number, ctimeMs: number): string {
    const cached = this.artifactHashCache.get(filePath);
    if (cached && cached.sizeBytes === sizeBytes && cached.mtimeMs === mtimeMs && cached.ctimeMs === ctimeMs) {
      return cached.sha256;
    }
    const sha256 = sha256File(filePath);
    this.artifactHashCache.set(filePath, { sizeBytes, mtimeMs, ctimeMs, sha256 });
    return sha256;
  }
}

function validateEntry(component: LocalModelComponent, value: unknown): LocalModelEntry {
  if (!isRecord(value)) throw new Error(`${component} entry must be an object`);
  const license = value.license;
  if (!isRecord(license)) throw new Error(`${component}.license is required`);
  const artifacts = value.artifacts;
  if (!Array.isArray(artifacts) || artifacts.length === 0) {
    throw new Error(`${component}.artifacts must contain at least one file`);
  }
  return {
    component,
    modelId: requireString(value.modelId, `${component}.modelId`),
    revision: requireString(value.revision, `${component}.revision`),
    upstreamUrl: requireString(value.upstreamUrl, `${component}.upstreamUrl`),
    relativePath: safeRelativePath(requireString(value.relativePath, `${component}.relativePath`)),
    artifacts: artifacts.map((artifact, index) => validateArtifact(component, artifact, index)),
    license: {
      model: requireString(license.model, `${component}.license.model`),
      code: requireString(license.code, `${component}.license.code`),
      tokenizer: requireString(license.tokenizer, `${component}.license.tokenizer`),
      codec: component === 'tts'
        ? requireString(license.codec, `${component}.license.codec`)
        : optionalString(license.codec),
      voice: component === 'tts'
        ? requireString(license.voice, `${component}.license.voice`)
        : optionalString(license.voice),
      distribution: enumValue(license.distribution, ['verified', 'restricted', 'unknown'], `${component}.license.distribution`),
      commercialUse: enumValue(license.commercialUse, ['verified', 'restricted', 'unknown'], `${component}.license.commercialUse`),
      sourceCheckedAt: optionalString(license.sourceCheckedAt),
      notes: optionalString(license.notes)
    }
  };
}

function validateArtifact(component: LocalModelComponent, value: unknown, index: number): ModelArtifactManifest {
  if (!isRecord(value)) throw new Error(`${component}.artifacts[${index}] must be an object`);
  const sha256 = requireString(value.sha256, `${component}.artifacts[${index}].sha256`).toLowerCase();
  if (!SHA256_RE.test(sha256)) throw new Error(`${component}.artifacts[${index}].sha256 must be a SHA-256 hex digest`);
  const sizeBytes = value.sizeBytes;
  if (typeof sizeBytes !== 'number' || !Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) {
    throw new Error(`${component}.artifacts[${index}].sizeBytes must be a positive integer`);
  }
  return {
    relativePath: safeRelativePath(requireString(value.relativePath, `${component}.artifacts[${index}].relativePath`)),
    sizeBytes,
    sha256
  };
}

function safeRelativePath(value: string): string {
  const normalized = path.posix.normalize(value.replaceAll('\\', '/'));
  if (!normalized || normalized === '.' || normalized.startsWith('../') || normalized.includes('/../') || path.posix.isAbsolute(normalized) || path.win32.isAbsolute(value) || /^[A-Za-z]:/.test(value)) {
    throw new Error(`path must be relative and stay inside the model directory: ${value}`);
  }
  return normalized;
}

function sha256File(filePath: string): string {
  const digest = createHash('sha256');
  const fd = openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead = 0;
    do {
      bytesRead = readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead > 0) digest.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
    return digest.digest('hex');
  } finally {
    closeSync(fd);
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} must be a non-empty string`);
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new Error(`${field} must be one of ${allowed.join(', ')}`);
  }
  return value as T;
}
