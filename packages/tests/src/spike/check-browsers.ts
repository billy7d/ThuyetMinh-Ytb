import { chromium, firefox } from 'playwright';

async function checkBrowsers() {
  console.log('Testing browser launches...');
  
  // Test Chromium/Chrome
  try {
    const chromeBrowser = await chromium.launch({
      executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      headless: true,
      args: ['--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required']
    });
    const chromeVersion = chromeBrowser.version();
    console.log(`Chrome launched successfully! Version: ${chromeVersion}`);
    await chromeBrowser.close();
  } catch (err) {
    console.error('Chrome launch error:', err);
  }

  // Test Firefox
  try {
    const firefoxBrowser = await firefox.launch({
      executablePath: 'C:\\Users\\billy\\AppData\\Local\\Microsoft\\WindowsApps\\firefox.exe',
      headless: true,
      firefoxUserPrefs: {
        'media.navigator.permission.disabled': true,
        'media.autoplay.default': 0
      }
    });
    const firefoxVersion = firefoxBrowser.version();
    console.log(`Firefox launched successfully! Version: ${firefoxVersion}`);
    await firefoxBrowser.close();
  } catch (err) {
    console.error('Firefox launch error:', err);
  }
}

checkBrowsers();
