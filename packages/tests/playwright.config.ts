import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './src/e2e',
  timeout: 30000,
  expect: {
    timeout: 5000
  },
  fullyParallel: false,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    trace: 'on-first-retry',
    viewport: { width: 1280, height: 720 },
    video: 'retain-on-failure'
  },
  projects: [
    {
      name: 'chromium',
      testMatch: /extension-chrome\.spec\.ts/
    },
    {
      name: 'firefox',
      testMatch: /extension-firefox\.spec\.ts/,
      use: {
        browserName: 'firefox',
        launchOptions: {
          firefoxUserPrefs: {
            'media.navigator.permission.disabled': true,
            'media.autoplay.default': 0,
            'media.volume_scale': '1.0'
          }
        }
      }
    },
    {
      name: 'bundle-smoke',
      testMatch: /extension-bundle-smoke\.spec\.ts/
    }
  ]
});
