const { test, expect, chromium } = require('@playwright/test');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const projectRoot = path.resolve(__dirname, '../..');
let context;
let extensionId;
let server;
let origin;
let tempExtension;

function prepareExtension() {
  tempExtension = fs.mkdtempSync(path.join(os.tmpdir(), 'weread-clipper-e2e-'));
  const files = [
    'background.js', 'content.css', 'content.js', 'manifest.json',
    'offscreen.html', 'offscreen.js', 'popup.html', 'popup.js', 'text-stitch.js',
  ];
  files.forEach((file) => fs.copyFileSync(path.join(projectRoot, file), path.join(tempExtension, file)));
  fs.cpSync(path.join(projectRoot, 'icons'), path.join(tempExtension, 'icons'), { recursive: true });
  fs.cpSync(path.join(projectRoot, 'vendor'), path.join(tempExtension, 'vendor'), { recursive: true });

  const manifestPath = path.join(tempExtension, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.version_name = 'e2e';
  manifest.host_permissions.push('http://127.0.0.1/*');
  manifest.host_permissions.push('<all_urls>');
  manifest.content_scripts[0].matches.push('http://127.0.0.1/*');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
}

test.beforeAll(async () => {
  prepareExtension();

  server = http.createServer((request, response) => {
    const fixture = fs.readFileSync(path.join(__dirname, 'fixtures/reader.html'));
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(fixture);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;

  context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: false,
    args: [
      `--disable-extensions-except=${tempExtension}`,
      `--load-extension=${tempExtension}`,
    ],
  });

  let serviceWorker = context.serviceWorkers()[0];
  if (!serviceWorker) serviceWorker = await context.waitForEvent('serviceworker');
  extensionId = new URL(serviceWorker.url()).host;
});

test.afterAll(async () => {
  await Promise.race([
    context?.close() || Promise.resolve(),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]);
  server?.closeAllConnections?.();
  await new Promise((resolve) => server?.close(resolve) || resolve());
  if (tempExtension) fs.rmSync(tempExtension, { recursive: true, force: true });
});

test('完整调度：截图、模拟 OCR、去重拼接、状态持久化、恢复页面', async () => {
  const page = await context.newPage();
  await page.goto(`${origin}/reader.html`);
  await expect(page.locator('.readerTopBar')).toBeVisible();

  const serviceWorker = context.serviceWorkers()[0];
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.bringToFront();
  const response = await popup.evaluate(async () => chrome.runtime.sendMessage({
    type: 'START_EXTRACTION',
    testMode: true,
    testOcrTexts: [
      '第一屏正文。这是用于验证自动去重拼接的公共文本。',
      '这是用于验证自动去重拼接的公共文本。第二屏正文结束。',
    ],
  }));
  expect(response.success).toBe(true);

  await expect.poll(async () => serviceWorker.evaluate(async () => {
    const result = await chrome.storage.local.get('wereadClipperTask');
    const task = result.wereadClipperTask;
    return task?.status === 'failed' ? `failed: ${task.error}` : task?.status;
  })).toBe('completed');

  const task = await serviceWorker.evaluate(async () => {
    const result = await chrome.storage.local.get('wereadClipperTask');
    return result.wereadClipperTask;
  });
  expect(task.book).toBe('端到端测试书籍');
  expect(task.chapter).toBe('第一章 自动化验证');
  expect(task.pagesProcessed).toBe(2);
  expect(task.text).toContain('第一屏正文');
  expect(task.text).toContain('第二屏正文结束');
  expect(task.text.match(/自动去重拼接/g)).toHaveLength(1);
  await expect(page.locator('.readerTopBar')).toBeVisible();

  await expect(popup.locator('#status')).toContainText('提取完成');
  await expect(popup.locator('#result')).toHaveValue(/第二屏正文结束/);
  await expect(popup.locator('#copy')).toBeEnabled();
  await expect(popup.locator('#export')).toBeEnabled();
});

test('本地 OCR Worker 可以离线加载简体中文模型和 WASM core', async () => {
  test.setTimeout(120000);
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);

  const started = await popup.evaluate(async () => chrome.runtime.sendMessage({
    target: 'offscreen',
    type: 'OCR_START',
  }));
  expect(started.success).toBe(true);

  const warmedUp = await popup.evaluate(async () => chrome.runtime.sendMessage({
    target: 'offscreen',
    type: 'OCR_WARMUP',
  }));
  expect(warmedUp.success).toBe(true);

  const reset = await popup.evaluate(async () => chrome.runtime.sendMessage({
    target: 'offscreen',
    type: 'OCR_RESET',
  }));
  expect(reset.success).toBe(true);
});
