import { build } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isFirefox = process.argv.includes('--firefox') || process.argv.includes('firefox');
const target = isFirefox ? 'firefox' : 'chrome';
const outDir = path.resolve(__dirname, `dist/${target}`);

console.log(`[Extension Build] Starting build for ${target.toUpperCase()} in ${outDir}...`);

// 1. Clean output directory
if (fs.existsSync(outDir)) {
  fs.rmSync(outDir, { recursive: true, force: true });
}
fs.mkdirSync(outDir, { recursive: true });

// 2. Build Popup (and Chrome Offscreen document)
console.log(`[Extension Build] Step 1: Building Popup & Web UI...`);
await build({
  root: __dirname,
  configFile: false,
  plugins: [react()],
  build: {
    outDir,
    emptyOutDir: false,
    target: 'esnext',
    rollupOptions: {
      input: {
        popup: path.resolve(__dirname, 'src/popup/index.html'),
        ...(!isFirefox ? { offscreen: path.resolve(__dirname, 'src/offscreen/offscreen.html') } : {})
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: 'assets/[name].[ext]'
      }
    }
  }
});

// 3. Build Background Script (IIFE for Firefox, ES for Chrome service worker)
console.log(`[Extension Build] Step 2: Building Background Script...`);
if (isFirefox) {
  await build({
    configFile: false,
    build: {
      outDir: path.resolve(outDir, 'background'),
      emptyOutDir: false,
      target: 'esnext',
      lib: {
        entry: path.resolve(__dirname, 'src/background/firefox-background.ts'),
        name: 'VietDubBackground',
        formats: ['iife'],
        fileName: () => 'firefox-background.js'
      },
      rollupOptions: {
        output: {
          extend: true,
          inlineDynamicImports: true
        }
      }
    }
  });
} else {
  await build({
    configFile: false,
    build: {
      outDir: path.resolve(outDir, 'background'),
      emptyOutDir: false,
      target: 'esnext',
      lib: {
        entry: path.resolve(__dirname, 'src/background/chrome-background.ts'),
        name: 'VietDubChromeBackground',
        formats: ['es'],
        fileName: () => 'chrome-background.js'
      },
      rollupOptions: {
        output: {
          inlineDynamicImports: true
        }
      }
    }
  });
}

// 4. Build Content Script as STRICT STANDALONE IIFE (No imports, no shared chunks!)
console.log(`[Extension Build] Step 3: Building Standalone IIFE Content Script...`);
await build({
  configFile: false,
  build: {
    outDir: path.resolve(outDir, 'content'),
    emptyOutDir: false,
    target: 'esnext',
    lib: {
      entry: path.resolve(__dirname, 'src/content/content.ts'),
      name: 'VietDubContentScript',
      formats: ['iife'],
      fileName: () => 'content.js'
    },
    rollupOptions: {
      output: {
        extend: true,
        inlineDynamicImports: true
      }
    }
  }
});

// 5. Copy Manifest
const manifestSource = isFirefox ? 'manifest.firefox.json' : 'manifest.chrome.json';
const targetManifest = path.resolve(outDir, 'manifest.json');
fs.copyFileSync(path.resolve(__dirname, manifestSource), targetManifest);
console.log(`[Extension Build] Copied ${manifestSource} -> ${targetManifest}`);

// 6. Ensure Offscreen HTML location for Chrome
if (!isFirefox) {
  const offscreenTargetDir = path.resolve(outDir, 'src/offscreen');
  if (!fs.existsSync(offscreenTargetDir)) fs.mkdirSync(offscreenTargetDir, { recursive: true });
  fs.copyFileSync(
    path.resolve(__dirname, 'src/offscreen/offscreen.html'),
    path.resolve(offscreenTargetDir, 'offscreen.html')
  );
}

console.log(`[Extension Build] Successfully completed build for ${target.toUpperCase()}!\n`);
