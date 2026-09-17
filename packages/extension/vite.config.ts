import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import fs from 'node:fs';

export default defineConfig(({ mode }) => {
  const isFirefox = mode === 'firefox';
  const outDir = isFirefox ? 'dist/firefox' : 'dist/chrome';

  return {
    plugins: [
      react(),
      {
        name: 'copy-manifest-and-assets',
        closeBundle() {
          const manifestSource = isFirefox ? 'manifest.firefox.json' : 'manifest.chrome.json';
          const outFullPath = path.resolve(__dirname, outDir);
          if (!fs.existsSync(outFullPath)) {
            fs.mkdirSync(outFullPath, { recursive: true });
          }
          const targetManifest = path.resolve(outFullPath, 'manifest.json');
          fs.copyFileSync(path.resolve(__dirname, manifestSource), targetManifest);
          console.log(`[Extension Build] Copied ${manifestSource} -> ${targetManifest}`);

          // Copy offscreen.html for chrome
          if (!isFirefox) {
            const offscreenDir = path.resolve(outFullPath, 'src/offscreen');
            if (!fs.existsSync(offscreenDir)) fs.mkdirSync(offscreenDir, { recursive: true });
            fs.copyFileSync(
              path.resolve(__dirname, 'src/offscreen/offscreen.html'),
              path.resolve(offscreenDir, 'offscreen.html')
            );
          }
        }
      }
    ],
    build: {
      outDir,
      emptyOutDir: true,
      target: 'esnext',
      rollupOptions: {
        input: {
          popup: path.resolve(__dirname, 'src/popup/index.html'),
          ...(isFirefox
            ? {
                'background/firefox-background': path.resolve(__dirname, 'src/background/firefox-background.ts'),
                'content/content': path.resolve(__dirname, 'src/content/content.ts')
              }
            : {
                'background/chrome-background': path.resolve(__dirname, 'src/background/chrome-background.ts'),
                'offscreen/offscreen': path.resolve(__dirname, 'src/offscreen/offscreen.ts'),
                'content/content': path.resolve(__dirname, 'src/content/content.ts')
              })
        },
        output: {
          entryFileNames: '[name].js',
          chunkFileNames: 'chunks/[name]-[hash].js',
          assetFileNames: 'assets/[name].[ext]'
        }
      }
    }
  };
});
