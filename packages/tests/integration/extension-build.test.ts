import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(process.cwd(), '../..');
const extensionRoot = path.join(repositoryRoot, 'packages', 'extension');

describe('extension build artifact regression', () => {
  it('keeps compiled Chrome offscreen HTML when the build completes', async () => {
    await execFileAsync(process.execPath, [path.join(extensionRoot, 'build.mjs'), '--chrome'], {
      cwd: extensionRoot,
      maxBuffer: 4 * 1024 * 1024
    });

    const offscreenHtmlPath = path.join(extensionRoot, 'dist', 'chrome', 'src', 'offscreen', 'offscreen.html');
    const offscreenHtml = fs.readFileSync(offscreenHtmlPath, 'utf8');

    // Nếu bước copy HTML nguồn quay lại, assertion này phải fail ngay.
    expect(offscreenHtml).not.toContain('offscreen.ts');
    expect(offscreenHtml).toContain('offscreen.js');

    await execFileAsync(process.execPath, [path.join(repositoryRoot, 'scripts', 'validate-extension-build.mjs'), '--target', 'chrome'], {
      cwd: repositoryRoot,
      maxBuffer: 4 * 1024 * 1024
    });
  }, 30000);
});
