(function () {
  'use strict';

  const elements = {
    status: document.getElementById('status'),
    progress: document.getElementById('progress'),
    meta: document.getElementById('meta'),
    result: document.getElementById('result'),
    start: document.getElementById('start'),
    copy: document.getElementById('copy'),
    preview: document.getElementById('preview'),
    export: document.getElementById('export'),
  };

  let currentTask = null;

  function formatText(task) {
    if (!task?.text) return '';
    return `📖 ${task.book || '未知书籍'}\n📑 ${task.chapter || '未知章节'}\n${'─'.repeat(40)}\n\n${task.text}`;
  }

  function render(task) {
    currentTask = task;
    const completed = task.status === 'completed';
    const running = task.status === 'running';
    elements.status.className = `status ${completed ? 'success' : task.status === 'failed' ? 'error' : ''}`;
    elements.status.textContent = task.error || task.message || '等待开始提取';
    elements.progress.value = running ? (task.ocrProgress || 0) : completed ? 1 : 0;
    elements.meta.textContent = [
      task.book && `书籍：${task.book}`,
      task.chapter && `章节：${task.chapter}`,
      task.pagesProcessed ? `进度：已识别 ${task.pagesProcessed} 屏` : '',
      completed ? `字数：${task.text.length}` : '',
      task.degradedJoins ? `需人工校对接缝：${task.degradedJoins} 处` : '',
    ].filter(Boolean).join(' · ');
    elements.result.value = formatText(task);
    elements.start.disabled = running;
    elements.copy.disabled = !completed;
    elements.preview.disabled = !completed;
    elements.export.disabled = !completed;
  }

  async function request(message) {
    const response = await chrome.runtime.sendMessage(message);
    if (!response?.success) throw new Error(response?.error || '扩展后台没有返回结果');
    return response;
  }

  async function refresh() {
    try {
      const response = await request({ type: 'GET_TASK_STATUS' });
      render(response.task);
    } catch (error) {
      render({ status: 'failed', error: error.message });
    }
  }

  async function sendToActivePage(message) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error('无法获取当前标签页');
    const response = await chrome.tabs.sendMessage(tab.id, message);
    if (!response?.success) throw new Error(response?.error || '页面操作失败');
    return response;
  }

  elements.start.addEventListener('click', async () => {
    try {
      render({ status: 'running', message: '正在启动提取任务…' });
      const response = await request({ type: 'START_EXTRACTION' });
      render(response.task);
    } catch (error) {
      render({ status: 'failed', error: error.message });
    }
  });

  elements.copy.addEventListener('click', async () => {
    const text = formatText(currentTask);
    try {
      await navigator.clipboard.writeText(text);
      elements.status.textContent = '已复制到剪贴板';
    } catch (error) {
      await sendToActivePage({ type: 'COPY_TO_CLIPBOARD', text });
      elements.status.textContent = '已复制到剪贴板';
    }
  });

  elements.preview.addEventListener('click', async () => {
    try {
      await sendToActivePage({ type: 'SHOW_PREVIEW', text: currentTask.text });
      window.close();
    } catch (error) {
      elements.status.textContent = error.message;
    }
  });

  elements.export.addEventListener('click', async () => {
    const blob = new Blob([formatText(currentTask)], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    await chrome.downloads.download({
      url,
      filename: `${currentTask.book || '微信读书'}-${currentTask.chapter || '章节'}.txt`,
      saveAs: true,
    });
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'TASK_UPDATED') render(message.task);
  });

  refresh();
  setInterval(refresh, 1000);
})();
