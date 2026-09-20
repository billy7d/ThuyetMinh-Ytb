import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ensureExtensionBuild, repositoryRoot } from './support/test-environment.js';

const extensionRoot = path.join(repositoryRoot, 'packages', 'extension');

test.describe('Extension bundle smoke — kiểm tra artifact đã build', () => {
  test.beforeAll(async () => {
    await ensureExtensionBuild('chrome');
    await ensureExtensionBuild('firefox');
  });

  for (const target of ['chrome', 'firefox'] as const) {
    test(`${target} content bundle là IIFE hợp lệ và không còn import TypeScript`, () => {
      const bundlePath = path.join(extensionRoot, 'dist', target, 'content', 'content.js');
      const bundle = fs.readFileSync(bundlePath, 'utf8');

      expect(bundle).not.toMatch(/(?:^|\n)\s*(?:import|export)\s/);
      expect(bundle).not.toContain('.ts');
      expect(() => new vm.Script(bundle, { filename: bundlePath })).not.toThrow();
    });
  }
});
