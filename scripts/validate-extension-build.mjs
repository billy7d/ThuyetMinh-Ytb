import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const targets = ['firefox', 'chrome'];
let hasErrors = false;

console.log('====================================================');
console.log('>>> RUNNING AUTOMATED EXTENSION BUILD VALIDATION');
console.log('====================================================\n');

for (const target of targets) {
  const distDir = path.resolve(rootDir, `packages/extension/dist/${target}`);
  console.log(`[Validation] Checking ${target.toUpperCase()} build in: ${distDir}`);

  if (!fs.existsSync(distDir)) {
    console.error(`❌ [${target}] Dist directory does not exist: ${distDir}`);
    hasErrors = true;
    continue;
  }

  // 1. Verify manifest.json exists and is valid JSON
  const manifestPath = path.resolve(distDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    console.error(`❌ [${target}] Missing manifest.json`);
    hasErrors = true;
    continue;
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    console.log(`  ✓ manifest.json is valid JSON (version ${manifest.version}, MV${manifest.manifest_version})`);
  } catch (err) {
    console.error(`❌ [${target}] Invalid manifest.json JSON:`, err.message);
    hasErrors = true;
    continue;
  }

  // 2. Check Action / Popup HTML exists
  const popupPath = manifest.action?.default_popup;
  if (popupPath) {
    const fullPopupPath = path.resolve(distDir, popupPath);
    if (!fs.existsSync(fullPopupPath)) {
      console.error(`❌ [${target}] Referenced default_popup does not exist: ${fullPopupPath}`);
      hasErrors = true;
    } else {
      console.log(`  ✓ default_popup exists: ${popupPath}`);
    }
  }

  // 3. Check Background scripts exist
  if (manifest.background) {
    const bgScripts = manifest.background.scripts || (manifest.background.service_worker ? [manifest.background.service_worker] : []);
    for (const bg of bgScripts) {
      const fullBgPath = path.resolve(distDir, bg);
      if (!fs.existsSync(fullBgPath)) {
        console.error(`❌ [${target}] Referenced background script does not exist: ${fullBgPath}`);
        hasErrors = true;
      } else {
        console.log(`  ✓ background script exists: ${bg}`);
      }
    }
  }

  // 4. Check Content scripts exist and DO NOT CONTAIN ES MODULE IMPORTS!
  if (manifest.content_scripts) {
    for (const cs of manifest.content_scripts) {
      for (const jsFile of cs.js || []) {
        const fullJsPath = path.resolve(distDir, jsFile);
        if (!fs.existsSync(fullJsPath)) {
          console.error(`❌ [${target}] Referenced content script does not exist: ${fullJsPath}`);
          hasErrors = true;
          continue;
        }

        const content = fs.readFileSync(fullJsPath, 'utf-8');

        // Check for static import statements (e.g. import ... from ..., import "...")
        const importMatch = content.match(/\bimport\s*[\w\s{},*]*\s*from\s*['"][^'"]+['"]/i) || content.match(/\bimport\s*['"][^'"]+['"]/i);
        if (importMatch) {
          console.error(`❌ [${target}] CRITICAL ERROR: Content script ${jsFile} contains ES module import:\n   -> "${importMatch[0]}"`);
          console.error(`   Content scripts must be standalone IIFE bundles without static imports!`);
          hasErrors = true;
        } else {
          console.log(`  ✓ content script is standalone (0 static imports): ${jsFile}`);
        }

        // Check for export statements
        const exportMatch = content.match(/\bexport\s*(?:default|const|let|var|function|class|\{)/i);
        if (exportMatch) {
          console.error(`❌ [${target}] CRITICAL ERROR: Content script ${jsFile} contains ES module export:\n   -> "${exportMatch[0]}"`);
          hasErrors = true;
        } else {
          console.log(`  ✓ content script is standalone (0 exports): ${jsFile}`);
        }

        // Verify IIFE wrap
        if (content.trim().startsWith('(function()') || content.trim().startsWith('(()=>{')) {
          console.log(`  ✓ content script is properly wrapped in IIFE`);
        }
      }
    }
  }

  // 5. For Chrome, verify offscreen document exists
  if (target === 'chrome') {
    const offscreenHtmlPath = path.resolve(distDir, 'src/offscreen/offscreen.html');
    if (!fs.existsSync(offscreenHtmlPath)) {
      console.error(`❌ [chrome] Missing offscreen HTML document: ${offscreenHtmlPath}`);
      hasErrors = true;
    } else {
      console.log(`  ✓ offscreen document exists: src/offscreen/offscreen.html`);
    }
  }

  console.log(`[Validation] ${target.toUpperCase()} verification completed.\n`);
}

if (hasErrors) {
  console.error('❌ Build validation FAILED! See errors above.');
  process.exit(1);
} else {
  console.log('✅ ALL EXTENSION BUILDS VALIDATED SUCCESSFULLY!');
  process.exit(0);
}
