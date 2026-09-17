import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['unit/**/*.test.ts', 'integration/**/*.test.ts'],
    exclude: ['src/e2e/**', 'node_modules/**', 'dist/**']
  }
});
