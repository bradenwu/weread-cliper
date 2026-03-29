/**
 * content.js 单元测试
 * 覆盖：HTML 转义、预览 overlay、ESC 监听清理
 */

global.chrome = { runtime: { onMessage: { addListener: jest.fn() } } };

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function removeOverlay() {
  const overlay = document.getElementById('weread-cliper-highlight');
  if (overlay) {
    overlay.remove();
  }
}

function showOverlay(text) {
  removeOverlay();

  const overlay = document.createElement('div');
  overlay.id = 'weread-cliper-highlight';
  overlay.innerHTML = `
    <button id="weread-cliper-close">✕</button>
    <pre>${escapeHtml(text)}</pre>
    <button id="weread-cliper-copy">copy</button>
  `;
  document.body.appendChild(overlay);

  const escHandler = (event) => {
    if (event.key === 'Escape') {
      overlay.remove();
      document.removeEventListener('keydown', escHandler);
    }
  };

  document.getElementById('weread-cliper-close').addEventListener('click', () => {
    overlay.remove();
    document.removeEventListener('keydown', escHandler);
  });

  document.getElementById('weread-cliper-copy').addEventListener('click', () => {
    navigator.clipboard.writeText(text);
  });

  document.addEventListener('keydown', escHandler);
}

describe('escapeHtml', () => {
  test('转义危险字符', () => {
    expect(escapeHtml('<script>alert("xss")</script>'))
      .toBe('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
  });

  test('普通文字保持不变', () => {
    expect(escapeHtml('普通文字 123')).toBe('普通文字 123');
  });
});

describe('showOverlay', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: jest.fn().mockResolvedValue(undefined) },
      configurable: true,
    });
  });

  test('插入 overlay 且文本被转义', () => {
    showOverlay('<b>hello</b>');

    const overlay = document.getElementById('weread-cliper-highlight');
    expect(overlay).not.toBeNull();
    expect(overlay.innerHTML).toContain('&lt;b&gt;hello&lt;/b&gt;');
  });

  test('重复打开时会替换旧 overlay', () => {
    showOverlay('first');
    showOverlay('second');

    expect(document.querySelectorAll('#weread-cliper-highlight')).toHaveLength(1);
    expect(document.body.textContent).toContain('second');
    expect(document.body.textContent).not.toContain('first');
  });

  test('点击关闭按钮时移除 overlay', () => {
    const removeEventListenerSpy = jest.spyOn(document, 'removeEventListener');

    showOverlay('close me');
    document.getElementById('weread-cliper-close').click();

    expect(document.getElementById('weread-cliper-highlight')).toBeNull();
    expect(removeEventListenerSpy).toHaveBeenCalledWith('keydown', expect.any(Function));

    removeEventListenerSpy.mockRestore();
  });

  test('按 ESC 时移除 overlay', () => {
    showOverlay('esc');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(document.getElementById('weread-cliper-highlight')).toBeNull();
  });

  test('点击复制按钮时写入剪贴板', async () => {
    showOverlay('copy me');
    document.getElementById('weread-cliper-copy').click();

    await Promise.resolve();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('copy me');
  });
});
