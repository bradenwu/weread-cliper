describe('popup 用户界面', () => {
  let runtimeListener;

  beforeEach(() => {
    jest.resetModules();
    jest.useFakeTimers();
    runtimeListener = null;
    document.body.innerHTML = `
      <section id="status" class="status">正在读取任务状态…</section>
      <progress id="progress" max="1" value="0"></progress>
      <div id="meta"></div>
      <textarea id="result" readonly></textarea>
      <button id="start">开始提取当前章节</button>
      <button id="copy" disabled>复制文本</button>
      <button id="preview" disabled>页面预览</button>
      <button id="export" disabled>导出 TXT</button>
    `;

    global.chrome = {
      runtime: {
        sendMessage: jest.fn(async () => ({
          success: true,
          task: {
            status: 'failed',
            error: 'Could not establish connection. Receiving end does not exist.',
            text: '',
          },
        })),
        onMessage: {
          addListener: jest.fn((callback) => { runtimeListener = callback; }),
        },
      },
      tabs: { query: jest.fn(), sendMessage: jest.fn() },
      downloads: { download: jest.fn() },
    };
    Object.defineProperty(window, 'close', {
      configurable: true,
      value: jest.fn(),
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('展示已保存的页面连接失败，不伪装成等待状态', async () => {
    require('../popup.js');
    await Promise.resolve();
    await Promise.resolve();

    expect(runtimeListener).toEqual(expect.any(Function));
    expect(document.getElementById('status').textContent)
      .toBe('Could not establish connection. Receiving end does not exist.');
    expect(document.getElementById('status').className).toContain('error');
  });

  test('启动成功后保持 popup 打开以实时展示进度', async () => {
    chrome.runtime.sendMessage.mockImplementation(async (message) => {
      if (message.type === 'GET_TASK_STATUS') {
        return { success: true, task: { status: 'idle', text: '', message: '等待开始提取' } };
      }
      if (message.type === 'START_EXTRACTION') {
        return { success: true, task: { status: 'running', text: '', message: '任务已启动' } };
      }
      return { success: true };
    });

    require('../popup.js');
    await Promise.resolve();
    await Promise.resolve();

    document.getElementById('start').click();
    await Promise.resolve();
    await Promise.resolve();

    jest.runOnlyPendingTimers();
    expect(window.close).not.toHaveBeenCalled();
    expect(document.getElementById('status').textContent).toBe('任务已启动');
  });
});
