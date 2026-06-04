(function () {
  'use strict';

  const contentToken = `${Date.now()}:${Math.random()}`;
  window.__wereadClipperActiveToken = contentToken;

  const OVERLAY_ID = 'weread-cliper-highlight';
  const HIDDEN_ATTR = 'data-weread-cliper-hidden';
  const UI_SELECTORS = [
    '.readerTopBar',
    '.readerControls',
    '.readerBottomBar',
    '.readerCatalog',
    '.readerCatalogPanel',
    '.readerNotePanel',
    '.readerMemberCardTips',
    '.wr_dialog',
  ];

  let captureState = null;

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function escapeHtml(text) {
    return String(text || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function removeOverlay() {
    document.getElementById(OVERLAY_ID)?.remove();
  }

  function showOverlay(text) {
    removeOverlay();
    const overlay = document.createElement('div');
    overlay.id = OVERLAY_ID;
    overlay.className = 'weread-cliper-overlay';
    overlay.innerHTML = `
      <div class="weread-cliper-header">
        <span class="weread-cliper-title">📖 WeRead Clipper - OCR 文本预览</span>
        <button class="weread-cliper-close" id="weread-cliper-close">✕</button>
      </div>
      <div class="weread-cliper-body"><pre>${escapeHtml(text)}</pre></div>
      <div class="weread-cliper-footer">
        <span>共 ${text.length} 字 / ${text.split('\n').length} 行</span>
        <button class="weread-cliper-copy-btn" id="weread-cliper-copy">📋 复制全部</button>
      </div>
    `;
    document.body.appendChild(overlay);

    const header = overlay.querySelector('.weread-cliper-header');
    let isDragging = false;
    let startX, startY, startLeft, startTop;

    const onMouseMove = (e) => {
      if (!isDragging) return;
      overlay.style.left = `${startLeft + e.clientX - startX}px`;
      overlay.style.top = `${startTop + e.clientY - startY}px`;
    };

    const onMouseUp = () => {
      isDragging = false;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    header.addEventListener('mousedown', (e) => {
      if (e.target.closest('button')) return;
      const rect = overlay.getBoundingClientRect();
      overlay.style.left = `${rect.left}px`;
      overlay.style.top = `${rect.top}px`;
      overlay.style.transform = 'none';
      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;
      startLeft = rect.left;
      startTop = rect.top;
      e.preventDefault();
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });

    const close = () => {
      overlay.remove();
      document.removeEventListener('keydown', onKeydown);
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
    const onKeydown = (event) => {
      if (event.key === 'Escape') close();
    };

    document.getElementById('weread-cliper-close').addEventListener('click', close);
    document.getElementById('weread-cliper-copy').addEventListener('click', async () => {
      await navigator.clipboard.writeText(text);
      const button = document.getElementById('weread-cliper-copy');
      button.textContent = '✅ 已复制！';
      setTimeout(() => { button.textContent = '📋 复制全部'; }, 2000);
    });
    document.addEventListener('keydown', onKeydown);
  }

  function getBook() {
    return document.querySelector('.readerTopBar_title_link')?.textContent?.trim()
      || document.title.split(' - ')[0]?.trim()
      || '未知书籍';
  }

  function getChapter() {
    return document.querySelector('.readerTopBar_title_chapter')?.textContent?.trim()
      || document.querySelector('.readerChapterTitle')?.textContent?.trim()
      || '未知章节';
  }

  function getScrollMetrics(element) {
    if (element === document.scrollingElement) {
      return {
        scrollTop: element.scrollTop,
        scrollHeight: element.scrollHeight,
        clientHeight: window.innerHeight,
      };
    }
    return {
      scrollTop: element.scrollTop,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
    };
  }

  function findScrollTarget() {
    const root = document.scrollingElement || document.documentElement;
    const candidates = [root, ...document.querySelectorAll('body *')];
    let best = root;
    let bestRange = Math.max(0, getScrollMetrics(root).scrollHeight - getScrollMetrics(root).clientHeight);

    for (const element of candidates) {
      if (!(element instanceof HTMLElement)) continue;
      const style = window.getComputedStyle(element);
      if (!/(auto|scroll)/.test(style.overflowY)) continue;
      const metrics = getScrollMetrics(element);
      const range = metrics.scrollHeight - metrics.clientHeight;
      if (range > bestRange && metrics.clientHeight > 200) {
        best = element;
        bestRange = range;
      }
    }

    return best;
  }

  function hideElement(element) {
    if (!element || element.hasAttribute(HIDDEN_ATTR) || element.id === OVERLAY_ID) return;
    element.setAttribute(HIDDEN_ATTR, element.style.visibility || '');
    element.style.visibility = 'hidden';
  }

  function hideFloatingUi() {
    UI_SELECTORS.forEach((selector) => {
      document.querySelectorAll(selector).forEach(hideElement);
    });

    document.querySelectorAll('body *').forEach((element) => {
      const style = window.getComputedStyle(element);
      if (!['fixed', 'sticky'].includes(style.position)) return;
      const rect = element.getBoundingClientRect();
      if (rect.height < 180 || rect.width < 260) hideElement(element);
    });
  }

  function restoreFloatingUi() {
    document.querySelectorAll(`[${HIDDEN_ATTR}]`).forEach((element) => {
      element.style.visibility = element.getAttribute(HIDDEN_ATTR);
      element.removeAttribute(HIDDEN_ATTR);
    });
  }

  async function setScrollTop(element, value) {
    if (element === document.scrollingElement) {
      window.scrollTo({ top: value, behavior: 'auto' });
    } else {
      element.scrollTop = value;
    }
    await sleep(250);
  }

  async function prepareCapture() {
    if (captureState) await restoreCapture();
    const scrollTarget = findScrollTarget();
    captureState = {
      scrollTarget,
      originalScrollTop: getScrollMetrics(scrollTarget).scrollTop,
    };
    hideFloatingUi();
    await setScrollTop(scrollTarget, 0);
    const metrics = getScrollMetrics(scrollTarget);
    return {
      success: true,
      book: getBook(),
      chapter: getChapter(),
      atBottom: metrics.scrollHeight <= metrics.clientHeight + 4,
    };
  }

  async function scrollNext() {
    if (!captureState) throw new Error('页面尚未进入截图模式');
    const { scrollTarget } = captureState;
    const before = getScrollMetrics(scrollTarget);
    const step = Math.max(1, Math.round(before.clientHeight * 0.78));
    const targetTop = Math.min(before.scrollTop + step, before.scrollHeight - before.clientHeight);
    await setScrollTop(scrollTarget, targetTop);
    const after = getScrollMetrics(scrollTarget);
    return {
      success: true,
      atBottom: after.scrollTop + after.clientHeight >= after.scrollHeight - 4
        || after.scrollTop === before.scrollTop,
      scrollTop: after.scrollTop,
      scrollHeight: after.scrollHeight,
      viewportHeight: after.clientHeight,
    };
  }

  async function restoreCapture() {
    if (!captureState) return { success: true };
    const { scrollTarget, originalScrollTop } = captureState;
    restoreFloatingUi();
    await setScrollTop(scrollTarget, originalScrollTop);
    captureState = null;
    return { success: true };
  }

  async function copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      return { success: true };
    } catch (error) {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.cssText = 'position:fixed;opacity:0';
      document.body.appendChild(textarea);
      textarea.select();
      const copied = document.execCommand('copy');
      textarea.remove();
      return copied ? { success: true } : { success: false, error: '复制失败' };
    }
  }

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (window.__wereadClipperActiveToken !== contentToken) return false;

    (async () => {
      if (request.type === 'PREPARE_CAPTURE') sendResponse(await prepareCapture());
      if (request.type === 'SCROLL_NEXT') sendResponse(await scrollNext());
      if (request.type === 'RESTORE_CAPTURE') sendResponse(await restoreCapture());
      if (request.type === 'COPY_TO_CLIPBOARD') sendResponse(await copyToClipboard(request.text || ''));
      if (request.type === 'SHOW_PREVIEW') {
        showOverlay(request.text || '');
        sendResponse({ success: true });
      }
    })().catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  });

  window.__wereadClipperContentForTests = {
    escapeHtml,
    prepareCapture,
    restoreCapture,
    scrollNext,
    showOverlay,
  };
})();
