describe('background service worker 调度', () => {
  let runtimeListener;
  let storedTask;
  let pageMessages;
  let ocrMessages;

  beforeEach(() => {
    jest.resetModules();
    storedTask = null;
    pageMessages = [];
    ocrMessages = [];

    global.chrome = {
      runtime: {
        getURL: jest.fn((path) => `chrome-extension://test/${path}`),
        getManifest: jest.fn(() => ({})),
        getContexts: jest.fn().mockResolvedValue([]),
        sendMessage: jest.fn(async (message) => {
          if (message.target !== 'offscreen') return { success: true };
          ocrMessages.push(message);
          if (message.type === 'OCR_FINISH') {
            return { success: true, text: '拼接后的章节正文', pagesProcessed: 1, degradedJoins: 0 };
          }
          if (message.type === 'OCR_PAGE') {
            return { success: true, textLength: 8, degraded: false };
          }
          return { success: true };
        }),
        onMessage: {
          addListener: jest.fn((callback) => { runtimeListener = callback; }),
        },
      },
      storage: {
        local: {
          get: jest.fn(async () => ({ wereadClipperTask: storedTask })),
          set: jest.fn(async (value) => { storedTask = value.wereadClipperTask; }),
        },
      },
      offscreen: { createDocument: jest.fn().mockResolvedValue(undefined) },
      scripting: {
        insertCSS: jest.fn().mockResolvedValue(undefined),
        executeScript: jest.fn().mockResolvedValue([{ result: undefined }]),
      },
      windows: {
        get: jest.fn().mockResolvedValue({ id: 3, focused: true }),
      },
      tabs: {
        query: jest.fn().mockResolvedValue([{
          id: 7,
          windowId: 3,
          active: true,
          url: 'https://weread.qq.com/web/reader/test',
        }]),
        get: jest.fn().mockResolvedValue({ id: 7, windowId: 3, active: true }),
        captureVisibleTab: jest.fn().mockResolvedValue('data:image/png;base64,test'),
        sendMessage: jest.fn(async (tabId, message) => {
          pageMessages.push(message.type);
          if (message.type === 'PREPARE_CAPTURE') {
            return { success: true, book: '测试书籍', chapter: '测试章节', atBottom: true };
          }
          if (message.type === 'SCROLL_NEXT') return { success: true, atBottom: true };
          return { success: true };
        }),
      },
    };

    require('../background.js');
  });

  function dispatch(message) {
    return new Promise((resolve) => runtimeListener(message, {}, resolve));
  }

  async function waitForStatus(expected) {
    for (let index = 0; index < 30; index += 1) {
      if (storedTask?.status === expected) return storedTask;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    throw new Error(`任务未进入状态: ${expected}`);
  }

  test('截图一屏、执行 OCR、恢复页面并保存最终状态', async () => {
    const started = await dispatch({ type: 'START_EXTRACTION' });
    expect(started.success).toBe(true);

    const task = await waitForStatus('completed');
    expect(task.text).toBe('拼接后的章节正文');
    expect(task.pagesProcessed).toBe(1);
    expect(pageMessages).toEqual(['PREPARE_CAPTURE', 'RESTORE_CAPTURE']);
    expect(chrome.tabs.captureVisibleTab).toHaveBeenCalledWith(3, { format: 'png' });
    expect(ocrMessages.map((message) => message.type)).toEqual(['OCR_START', 'OCR_PAGE', 'OCR_FINISH']);
  });

  test('非微信读书页拒绝启动任务', async () => {
    chrome.tabs.query.mockResolvedValue([{ id: 7, windowId: 3, active: true, url: 'https://example.com/' }]);
    const result = await dispatch({ type: 'START_EXTRACTION' });
    expect(result).toEqual({ success: false, error: '请先打开微信读书章节阅读页' });
    expect(chrome.tabs.captureVisibleTab).not.toHaveBeenCalled();
  });

  test('service worker 重启后恢复中断任务并允许重新开始', async () => {
    storedTask = {
      status: 'running',
      phase: 'recognizing',
      tabId: 7,
      windowId: 3,
      text: '',
    };

    const status = await dispatch({ type: 'GET_TASK_STATUS' });
    expect(status.task.status).toBe('failed');
    expect(status.task.error).toContain('检测到中断的提取任务');
    expect(pageMessages).toEqual(['RESTORE_CAPTURE']);
    expect(ocrMessages.map((message) => message.type)).toEqual(['OCR_RESET']);

    const restarted = await dispatch({ type: 'START_EXTRACTION' });
    expect(restarted.success).toBe(true);
    await waitForStatus('completed');
  });

  test('OCR 会话初始化失败时仍恢复页面', async () => {
    chrome.runtime.sendMessage.mockImplementation(async (message) => {
      if (message.target !== 'offscreen') return { success: true };
      ocrMessages.push(message);
      if (message.type === 'OCR_START') return { success: false, error: '初始化失败' };
      return { success: true };
    });

    const started = await dispatch({ type: 'START_EXTRACTION' });
    expect(started.success).toBe(true);
    const task = await waitForStatus('failed');
    expect(task.error).toBe('初始化失败');
    expect(pageMessages).toEqual(['PREPARE_CAPTURE', 'RESTORE_CAPTURE']);
  });

  test('页面尚未注入 content script 时自动注入后重试', async () => {
    let prepareAttempts = 0;
    chrome.tabs.sendMessage.mockImplementation(async (tabId, message) => {
      if (message.type === 'PREPARE_CAPTURE') {
        prepareAttempts += 1;
        if (prepareAttempts === 1) {
          throw new Error('Could not establish connection. Receiving end does not exist.');
        }
        pageMessages.push(message.type);
        return { success: true, book: '测试书籍', chapter: '测试章节', atBottom: true };
      }

      pageMessages.push(message.type);
      return { success: true };
    });

    const started = await dispatch({ type: 'START_EXTRACTION' });
    expect(started.success).toBe(true);

    const task = await waitForStatus('completed');
    expect(task.text).toBe('拼接后的章节正文');
    expect(chrome.scripting.insertCSS).toHaveBeenCalledWith({
      target: { tabId: 7 },
      files: ['content.css'],
    });
    expect(chrome.scripting.executeScript).toHaveBeenCalledWith({
      target: { tabId: 7 },
      files: ['content.js'],
    });
    expect(pageMessages).toEqual(['PREPARE_CAPTURE', 'RESTORE_CAPTURE']);
  });

  test('原窗口失去焦点时中止截图并恢复页面', async () => {
    chrome.windows.get.mockResolvedValue({ id: 3, focused: false });

    const started = await dispatch({ type: 'START_EXTRACTION' });
    expect(started.success).toBe(true);
    const task = await waitForStatus('failed');
    expect(task.error).toContain('保持微信读书标签页及其 Chrome 窗口位于前台');
    expect(chrome.tabs.captureVisibleTab).not.toHaveBeenCalled();
    expect(pageMessages).toEqual(['PREPARE_CAPTURE', 'RESTORE_CAPTURE']);
  });
});
