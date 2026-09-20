import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

function parseTarget(argv) {
  const targetArgIndex = argv.findIndex((value) => value === '--target');
  const target = targetArgIndex >= 0 ? argv[targetArgIndex + 1] : 'all';
  if (!['firefox', 'chrome', 'all'].includes(target)) {
    throw new Error(`Target không hợp lệ: ${target}. Chọn firefox, chrome hoặc all.`);
  }
  return target === 'all' ? ['firefox', 'chrome'] : [target];
}

function isInside(parentDir, childPath) {
  const relative = path.relative(parentDir, childPath);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function stripUrlSuffix(resource) {
  return resource.split(/[?#]/, 1)[0];
}

function resolveResource(distDir, resource, label, baseDir = distDir) {
  if (typeof resource !== 'string' || resource.length === 0) {
    throw new Error(`${label} phải là đường dẫn không rỗng.`);
  }

  const cleanResource = stripUrlSuffix(resource);
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(cleanResource)) {
    throw new Error(`${label} trỏ ra URL ngoài extension: ${resource}`);
  }

  // URL bắt đầu bằng / là đường dẫn từ gốc extension, không phải gốc ổ đĩa.
  const isRootRelative = /^[/\\]/.test(cleanResource);
  const relativeResource = cleanResource.replace(/^[/\\]+/, '').replaceAll('/', path.sep);
  const resolved = path.resolve(isRootRelative ? distDir : baseDir, relativeResource);
  if (!isInside(distDir, resolved)) {
    throw new Error(`${label} trỏ ra ngoài distribution: ${resource}`);
  }
  return resolved;
}

function checkFile(distDir, resource, label, errors, baseDir = distDir) {
  try {
    const resolved = resolveResource(distDir, resource, label, baseDir);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      errors.push(`${label} không tồn tại: ${resource}`);
      return null;
    }
    return resolved;
  } catch (error) {
    errors.push(error.message);
    return null;
  }
}

function collectHtmlReferences(html) {
  const references = [];
  const tagPattern = /<(script|link)\b[^>]*>/gi;
  const attributePattern = /\b(src|href)\s*=\s*["']([^"']+)["']/i;
  for (const tagMatch of html.matchAll(tagPattern)) {
    const attributeMatch = tagMatch[0].match(attributePattern);
    if (attributeMatch) {
      references.push({ tag: tagMatch[1].toLowerCase(), attribute: attributeMatch[1], resource: attributeMatch[2] });
    }
  }
  return references;
}

function collectHtmlFiles(directory) {
  const htmlFiles = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      htmlFiles.push(...collectHtmlFiles(entryPath));
      continue;
    }
    if (entry.name.toLowerCase().endsWith('.html')) htmlFiles.push(entryPath);
  }
  return htmlFiles;
}

function validateHtml(distDir, htmlPath, errors) {
  const html = fs.readFileSync(htmlPath, 'utf8');
  for (const reference of collectHtmlReferences(html)) {
    const label = `${path.relative(distDir, htmlPath)} ${reference.attribute}`;
    if (stripUrlSuffix(reference.resource).toLowerCase().endsWith('.ts')) {
      errors.push(`${label} còn tham chiếu TypeScript chưa biên dịch: ${reference.resource}`);
      continue;
    }
    checkFile(distDir, reference.resource, label, errors, path.dirname(htmlPath));
  }
  return html;
}

function validateContentScript(distDir, resource, errors) {
  const filePath = checkFile(distDir, resource, `content script ${resource}`, errors);
  if (!filePath) return;

  const content = fs.readFileSync(filePath, 'utf8');
  // Content script trong manifest là classic script nên phải tự chứa toàn bộ dependency.
  if (/\bimport\s*(?:[\w\s{},*]+\s+from\s*)?["'][^"']+["']/m.test(content)) {
    errors.push(`Content script ${resource} chứa static import.`);
  }
  if (/\bexport\s+(?:default\s+)?(?:const|let|var|function|class|\{|\*)/m.test(content)) {
    errors.push(`Content script ${resource} chứa export.`);
  }
  if (!/^\s*\(function|^\s*\(\(\)\s*=>/m.test(content)) {
    errors.push(`Content script ${resource} không được đóng gói dạng IIFE.`);
  }

  try {
    new vm.Script(content, { filename: filePath });
  } catch (error) {
    errors.push(`Content script ${resource} không parse được: ${error.message}`);
  }
}

function validateManifest(distDir, target, errors) {
  const manifestPath = path.join(distDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    errors.push('Thiếu manifest.json.');
    return;
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    errors.push(`manifest.json không phải JSON hợp lệ: ${error.message}`);
    return;
  }

  if (manifest.manifest_version !== 3) errors.push('manifest_version phải bằng 3.');
  if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string') {
    errors.push('manifest thiếu name hoặc version hợp lệ.');
  }

  const popup = manifest.action?.default_popup;
  if (popup) {
    const popupPath = checkFile(distDir, popup, 'action.default_popup', errors);
    if (popupPath) validateHtml(distDir, popupPath, errors);
  } else {
    errors.push('manifest thiếu action.default_popup.');
  }

  const backgroundFiles = manifest.background?.scripts ||
    (manifest.background?.service_worker ? [manifest.background.service_worker] : []);
  if (backgroundFiles.length === 0) errors.push('manifest thiếu background script/service_worker.');
  for (const resource of backgroundFiles) checkFile(distDir, resource, 'background script', errors);

  for (const contentScript of manifest.content_scripts || []) {
    for (const resource of contentScript.js || []) {
      validateContentScript(distDir, resource, errors);
    }
    for (const resource of contentScript.css || []) checkFile(distDir, resource, 'content stylesheet', errors);
  }

  if (target === 'chrome') {
    const offscreenResource = 'src/offscreen/offscreen.html';
    const offscreenPath = checkFile(distDir, offscreenResource, 'Chrome offscreen document', errors);
    if (offscreenPath) validateHtml(distDir, offscreenPath, errors);
  }

  // Duyệt mọi HTML artifact để bắt việc copy nhầm HTML nguồn quay lại dist.
  for (const htmlPath of collectHtmlFiles(distDir)) {
    validateHtml(distDir, htmlPath, errors);
  }

  console.log(`  ✓ manifest.json hợp lệ (version ${manifest.version}, MV${manifest.manifest_version})`);
}

function validateTarget(target) {
  const distDir = path.resolve(rootDir, `packages/extension/dist/${target}`);
  const errors = [];
  console.log(`[Validation] Kiểm tra ${target.toUpperCase()} tại: ${distDir}`);

  if (!fs.existsSync(distDir) || !fs.statSync(distDir).isDirectory()) {
    errors.push(`Không tồn tại distribution directory: ${distDir}`);
  } else {
    validateManifest(distDir, target, errors);
  }

  if (errors.length > 0) {
    for (const error of errors) console.error(`  ❌ [${target}] ${error}`);
    return false;
  }
  console.log(`  ✓ ${target.toUpperCase()} artifact đạt toàn bộ kiểm tra.\n`);
  return true;
}

let ok = false;
try {
  const targets = parseTarget(process.argv.slice(2));
  console.log('====================================================');
  console.log('>>> KIỂM TRA ARTIFACT EXTENSION');
  console.log('====================================================\n');
  ok = targets.every(validateTarget);
} catch (error) {
  console.error(`❌ Validation configuration failed: ${error.message}`);
}

if (!ok) {
  console.error('❌ Extension build validation FAILED.');
  process.exit(1);
}

console.log('✅ Extension build validation PASSED.');
