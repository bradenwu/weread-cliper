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
});
