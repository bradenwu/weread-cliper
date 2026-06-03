const MAX_SCREENS = 80;
const CAPTURE_DELAY_MS = 650;
const TASK_KEY = 'wereadClipperTask';
const OFFSCREEN_PATH = 'offscreen.html';
const TEST_MODE = chrome.runtime.getManifest().version_name === 'e2e';
const NO_RECEIVER_ERROR = 'Receiving end does not exist';

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
    tabId: null,
    windowId: null,
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
  if (activeTask.status === 'running') {
    await recoverOrphanedTask();
  }
  return activeTask;
}

async function recoverOrphanedTask() {
  const { tabId } = activeTask;
  if (tabId) {
    await chrome.tabs.get(tabId)
      .then(() => sendToPage(tabId, { type: 'RESTORE_CAPTURE' }))
      .catch(() => {});
  }
  await chrome.runtime.sendMessage({ target: 'offscreen', type: 'OCR_RESET' }).catch(() => {});
  await saveTask({
    status: 'failed',
    phase: 'failed',
    message: '上次提取任务已中断',
    error: '检测到中断的提取任务，页面状态已尝试恢复，请重新开始。',
  });
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
  // offscreen 文档创建后，JS 注册监听器需要短暂时间，遇到连接错误时重试
  for (let delay = 50; ; delay *= 2) {
    try {
      const response = await chrome.runtime.sendMessage({ target: 'offscreen', ...message });
      if (!response?.success) throw new Error(response?.error || 'OCR 后台处理失败');
      return response;
    } catch (error) {
      if (delay <= 400 && error.message.includes(NO_RECEIVER_ERROR)) {
        await sleep(delay);
        continue;
      }
      throw error;
    }
  }
}

async function sendToPage(tabId, message) {
  let response;
  try {
    response = await chrome.tabs.sendMessage(tabId, message);
  } catch (error) {
    if (!error.message.includes(NO_RECEIVER_ERROR)) throw error;
    await injectContentScript(tabId);
    response = await chrome.tabs.sendMessage(tabId, message);
  }
  if (!response?.success) throw new Error(response?.error || '页面控制失败');
  return response;
}

async function injectContentScript(tabId) {
  if (!chrome.scripting?.executeScript) {
    throw new Error('无法注入页面控制脚本，请刷新微信读书页面后重试');
  }

  await chrome.scripting.insertCSS({
    target: { tabId },
    files: ['content.css'],
  }).catch(() => {});
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content.js'],
  });
}

async function assertTargetTab(tabId, windowId) {
  const [tab, lastFocused] = await Promise.all([
    chrome.tabs.get(tabId),
    chrome.windows.getLastFocused({ windowTypes: ['normal'] }),
  ]);
  if (!tab.active || tab.windowId !== windowId || lastFocused.id !== windowId) {
    throw new Error('提取期间请保持微信读书标签页及其 Chrome 窗口位于前台');
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

  let pageNumber = 0;
  try {
    const page = await sendToPage(tabId, { type: 'PREPARE_CAPTURE' });
    await saveTask({ book: page.book, chapter: page.chapter });
    await sendToOffscreen({ type: 'OCR_START' });

    let hitBottom = page.atBottom;
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
    tabId: tab.id,
    windowId: tab.windowId,
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
