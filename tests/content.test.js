describe('content script 页面控制器', () => {
  let listener;

  beforeEach(() => {
    jest.resetModules();
    document.head.innerHTML = '';
    document.body.innerHTML = '';
    listener = null;
    global.chrome = {
      runtime: {
        onMessage: {
          addListener: jest.fn((callback) => { listener = callback; }),
        },
      },
    };
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: jest.fn().mockResolvedValue(undefined) },
    });
    require('../content.js');
  });

  function dispatch(message) {
    return new Promise((resolve) => listener(message, {}, resolve));
  }

  test('预览浮层转义 HTML，支持复制和关闭', async () => {
    const result = await dispatch({ type: 'SHOW_PREVIEW', text: '<script>危险</script>' });
    expect(result.success).toBe(true);

    const overlay = document.getElementById('weread-cliper-highlight');
    expect(overlay.innerHTML).toContain('&lt;script&gt;危险&lt;/script&gt;');

    document.getElementById('weread-cliper-copy').click();
    await Promise.resolve();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('<script>危险</script>');

    document.getElementById('weread-cliper-close').click();
    expect(document.getElementById('weread-cliper-highlight')).toBeNull();
  });

  test('截图准备阶段隐藏固定工具栏，恢复阶段还原样式', async () => {
    document.body.innerHTML = `
      <span class="readerTopBar_title_link">测试书籍</span>
      <span class="readerTopBar_title_chapter">测试章节</span>
      <div id="toolbar" style="position: fixed; visibility: visible;">工具栏</div>
      <div id="scroller" style="overflow-y: auto;"></div>
    `;
    const scroller = document.getElementById('scroller');
    Object.defineProperties(scroller, {
      clientHeight: { value: 600 },
      scrollHeight: { value: 1800 },
      scrollTop: { value: 300, writable: true },
    });

    const prepared = await dispatch({ type: 'PREPARE_CAPTURE' });
    expect(prepared).toEqual({
      success: true,
      book: '测试书籍',
      chapter: '测试章节',
      atBottom: false,
    });
    expect(document.getElementById('toolbar').style.visibility).toBe('hidden');
    expect(scroller.scrollTop).toBe(0);

    const scrolled = await dispatch({ type: 'SCROLL_NEXT' });
    expect(scrolled.atBottom).toBe(false);
    expect(scroller.scrollTop).toBe(468);

    await dispatch({ type: 'RESTORE_CAPTURE' });
    expect(document.getElementById('toolbar').style.visibility).toBe('visible');
    expect(scroller.scrollTop).toBe(300);
  });
});
