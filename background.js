const MAX_SCREENS = 80;
const CAPTURE_DELAY_MS = 650;
const TASK_KEY = 'wereadClipperTask';
const OFFSCREEN_PATH = 'offscreen.html';
const TEST_MODE = chrome.runtime.getManifest().version_name === 'e2e';

let activeTask = null;
let creatingOffscreen = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultTask() {
  return {
    status: 'idle',
    phase: 'idle',
    message: '等待开始提取',
    pageNumber: 0,
    pagesProcessed: 0,
    totalPages: null,
    ocrProgress: 0,
    text: '',
    book: '',
    chapter: '',
    degradedJoins: 0,
    error: '',
    updatedAt: Date.now(),
  };
}

async function saveTask(patch) {
  activeTask = { ...(activeTask || defaultTask()), ...patch, updatedAt: Date.now() };
  await chrome.storage.local.set({ [TASK_KEY]: activeTask });
  chrome.runtime.sendMessage({ type: 'TASK_UPDATED', task: activeTask }).catch(() => {});
  return activeTask;
}

async function getTask() {
  if (activeTask) return activeTask;
  const stored = await chrome.storage.local.get(TASK_KEY);
  activeTask = stored[TASK_KEY] || defaultTask();
  return activeTask;
}

async function ensureOffscreenDocument() {
  const url = chrome.runtime.getURL(OFFSCREEN_PATH);
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [url],
  });
  if (contexts.length) return;

  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen.createDocument({
      url: OFFSCREEN_PATH,
      reasons: ['WORKERS'],
      justification: '在隐藏页面中运行本地 Tesseract OCR Worker 并流式拼接章节文本',
    }).finally(() => {
      creatingOffscreen = null;
    });
  }
  await creatingOffscreen;
}

async function sendToOffscreen(message) {
  await ensureOffscreenDocument();
  const response = await chrome.runtime.sendMessage({ target: 'offscreen', ...message });
  if (!response?.success) throw new Error(response?.error || 'OCR 后台处理失败');
  return response;
}

async function sendToPage(tabId, message) {
  const response = await chrome.tabs.sendMessage(tabId, message);
  if (!response?.success) throw new Error(response?.error || '页面控制失败');
  return response;
}

async function assertTargetTab(tabId, windowId) {
  const tab = await chrome.tabs.get(tabId);
  if (!tab.active || tab.windowId !== windowId) {
    throw new Error('提取期间请保持微信读书标签页位于当前窗口前台');
  }
}

async function captureChapter(tab, options = {}) {
  const tabId = tab.id;
  const windowId = tab.windowId;

  await saveTask({
    status: 'running',
    phase: 'preparing',
    message: '正在隐藏页面工具栏并滚动到章节顶部',
    pageNumber: 0,
    pagesProcessed: 0,
    totalPages: null,
    text: '',
    error: '',
    ocrProgress: 0,
  });

  const page = await sendToPage(tabId, { type: 'PREPARE_CAPTURE' });
  await saveTask({ book: page.book, chapter: page.chapter });
  await sendToOffscreen({ type: 'OCR_START' });

  let pageNumber = 0;
  let hitBottom = page.atBottom;
  try {
    while (pageNumber < MAX_SCREENS) {
      pageNumber += 1;
      await assertTargetTab(tabId, windowId);
      await saveTask({
        phase: 'capturing',
        message: `正在截屏第 ${pageNumber} 屏`,
        pageNumber,
        ocrProgress: 0,
      });

      const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
      await saveTask({
        phase: 'recognizing',
        message: `正在识别第 ${pageNumber} 屏`,
      });

      const ocr = await sendToOffscreen({
        type: 'OCR_PAGE',
        dataUrl,
        pageNumber,
        mockText: TEST_MODE ? options.testOcrTexts?.[pageNumber - 1] : undefined,
      });
      await saveTask({
        pagesProcessed: pageNumber,
        message: `第 ${pageNumber} 屏识别完成，累计 ${ocr.textLength} 字`,
      });

      if (hitBottom) break;

      const scroll = await sendToPage(tabId, { type: 'SCROLL_NEXT' });
      if (scroll.atBottom) {
        hitBottom = true;
      }
      await sleep(CAPTURE_DELAY_MS);
    }

    if (!hitBottom && pageNumber >= MAX_SCREENS) {
      throw new Error(`已达到 ${MAX_SCREENS} 屏安全上限，请检查页面是否能正常触底`);
    }

    const result = await sendToOffscreen({ type: 'OCR_FINISH' });
    await saveTask({
      status: 'completed',
      phase: 'completed',
      message: `提取完成：共识别 ${result.pagesProcessed} 屏`,
      totalPages: result.pagesProcessed,
      pagesProcessed: result.pagesProcessed,
      text: result.text,
      degradedJoins: result.degradedJoins,
      ocrProgress: 1,
    });
  } finally {
    await sendToPage(tabId, { type: 'RESTORE_CAPTURE' }).catch(() => {});
  }
}

async function startExtraction(options = {}) {
  const task = await getTask();
  if (task.status === 'running') {
    throw new Error('已有提取任务正在运行');
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const isReaderPage = tab?.url?.startsWith('https://weread.qq.com/web/reader/');
  const isTestPage = TEST_MODE && options.testMode && tab?.url?.startsWith('http://127.0.0.1:');
  if (!tab?.id || (!isReaderPage && !isTestPage)) {
    throw new Error('请先打开微信读书章节阅读页');
  }

  await saveTask({
    status: 'running',
    phase: 'preparing',
    message: '任务已启动',
    text: '',
    error: '',
  });

  captureChapter(tab, options).catch(async (error) => {
    await sendToOffscreen({ type: 'OCR_RESET' }).catch(() => {});
    await saveTask({
      status: 'failed',
      phase: 'failed',
      message: '提取失败',
      error: error.message,
    });
  });

  return activeTask;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target === 'offscreen') return false;

  (async () => {
    if (message.type === 'START_EXTRACTION') {
      sendResponse({ success: true, task: await startExtraction(message) });
      return;
    }

    if (message.type === 'GET_TASK_STATUS') {
      sendResponse({ success: true, task: await getTask() });
      return;
    }

    if (message.type === 'OCR_PROGRESS') {
      if ((await getTask()).status === 'running') {
        await saveTask({
          message: message.message,
          ocrProgress: message.ocrProgress ?? activeTask.ocrProgress,
        });
      }
      sendResponse({ success: true });
    }
  })().catch((error) => {
    sendResponse({ success: false, error: error.message });
  });

  return true;
});
