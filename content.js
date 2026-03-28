/**
 * WeRead Clipper - Content Script
 * 复制微信读书当前页面所有文本内容
 */

(function () {
  'use strict';

  // 微信读书的页面 DOM 结构：
  // - 阅读区域在 #app 或 .readerContent 内
  // - 章节标题、段落文本分布在不同的 DOM 节点中
  // - 部分内容通过 canvas 或特殊选择器渲染

  const WEREAD_DOMAIN = 'weread.qq.com';

  /**
   * 获取页面当前显示的所有文本内容
   */
  function extractPageText() {
    const lines = [];

    // 策略1：尝试从微信读书的阅读区域选择器提取
    const selectors = [
      // 微信读书常见的阅读内容容器
      '.readerContent',
      '.readerContent .chapter_content',
      '.readingContent',
      '#app .content',
      // 章节标题
      '.chapterTitle',
      '.chapter_title',
      '.readerChapterTitle',
      // 段落
      '.readerParagraph',
      '.readerText',
      '.textItem',
      // 通用 fallback
      '[data-testid="reader-content"]',
      '.readerMainContent',
    ];

    let container = null;
    for (const selector of selectors) {
      container = document.querySelector(selector);
      if (container) break;
    }

    if (container) {
      // 从容器中提取所有文本节点
      extractTextNodes(container, lines);
    } else {
      // 策略2：尝试获取所有可见的文本块
      extractAllVisibleText(lines);
    }

    return lines.join('\n').trim();
  }

  /**
   * 递归提取 DOM 节点中的文本内容
   */
  function extractTextNodes(element, lines) {
    // 获取所有直接子元素和文本节点
    const children = element.childNodes;

    for (const child of children) {
      if (child.nodeType === Node.TEXT_NODE) {
        const text = child.textContent.trim();
        if (text) {
          lines.push(text);
        }
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        const tag = child.tagName.toLowerCase();
        const display = window.getComputedStyle(child).display;

        // 跳过隐藏元素和脚本/样式
        if (display === 'none' || display === 'hidden') continue;
        if (['script', 'style', 'noscript', 'svg', 'img', 'video', 'audio', 'br'].includes(tag)) continue;

        // 对于块级元素，递归提取
        extractTextNodes(child, lines);
      }
    }
  }

  /**
   * Fallback：提取页面上所有可见文本
   */
  function extractAllVisibleText(lines) {
    // 微信读书的文本通常在特定的 class 结构中
    // 尝试从 body 中的所有文本节点提取，但排除导航栏等非内容区域

    const excludeSelectors = [
      'nav', 'header', 'footer',
      '.toolbar', '.menu', '.sidebar',
      '.navBar', '.topBar', '.bottomBar',
      '.chapterList', '.catalogue',
      'button', '.btn', '.icon',
    ];

    // 获取所有元素
    const allElements = document.querySelectorAll('body *');

    for (const el of allElements) {
      // 跳过排除区域
      if (excludeSelectors.some(sel => el.closest(sel))) continue;

      // 只处理直接包含文本的元素（叶子节点）
      if (el.children.length > 0) continue;

      const text = el.textContent.trim();
      if (!text || text.length < 1) continue;

      // 跳过太短的内容（可能是图标文字等）
      if (text.length <= 2 && !/[\u4e00-\u9fff]/.test(text)) continue;

      // 检查是否可见
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;

      // 避免重复
      if (!lines.includes(text)) {
        lines.push(text);
      }
    }
  }

  /**
   * 获取当前章节信息
   */
  function getChapterInfo() {
    // 尝试获取当前章节标题
    const chapterSelectors = [
      '.readerChapterTitle',
      '.chapterTitle',
      '.chapter_title',
      '.readerChapterName',
    ];

    for (const sel of chapterSelectors) {
      const el = document.querySelector(sel);
      if (el && el.textContent.trim()) {
        return el.textContent.trim();
      }
    }

    // Fallback: 从页面 title 提取
    const title = document.title;
    if (title && title.includes(' - ')) {
      return title.split(' - ').pop().trim();
    }

    return '未知章节';
  }

  /**
   * 获取书籍信息
   */
  function getBookInfo() {
    const title = document.title;
    if (title) {
      return title.split(' - ')[0]?.trim() || title.trim();
    }
    return '未知书籍';
  }

  // 监听来自 popup 的消息
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'extractText') {
      try {
        const text = extractPageText();
        const chapter = getChapterInfo();
        const book = getBookInfo();

        if (!text) {
          sendResponse({ success: false, error: '未找到可复制的文本内容。请确保正在阅读页面。' });
          return true;
        }

        // 组装带格式的文本
        const formatted = `📖 ${book}\n📑 ${chapter}\n${'─'.repeat(40)}\n\n${text}`;

        sendResponse({
          success: true,
          text: formatted,
          rawText: text,
          chapter: chapter,
          book: book,
          charCount: text.length,
          lineCount: text.split('\n').length,
        });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
      return true; // 保持 sendResponse 可用
    }

    if (request.action === 'copyToClipboard') {
      const text = request.text;
      navigator.clipboard.writeText(text).then(() => {
        sendResponse({ success: true });
      }).catch(() => {
        // Fallback: 使用旧方法
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        try {
          document.execCommand('copy');
          sendResponse({ success: true });
        } catch (e) {
          sendResponse({ success: false, error: '复制失败' });
        }
        document.body.removeChild(textarea);
      });
      return true;
    }

    if (request.action === 'selectText') {
      try {
        // 高亮显示提取到的文本区域
        highlightText();
        sendResponse({ success: true });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
      return true;
    }
  });

  /**
   * 高亮显示提取到的文本
   */
  function highlightText() {
    // 清除之前的高亮
    const oldHighlight = document.getElementById('weread-cliper-highlight');
    if (oldHighlight) oldHighlight.remove();

    const text = extractPageText();
    if (!text) return;

    // 在页面上显示提取到的文本预览
    const overlay = document.createElement('div');
    overlay.id = 'weread-cliper-highlight';
    overlay.className = 'weread-cliper-overlay';
    overlay.innerHTML = `
      <div class="weread-cliper-header">
        <span class="weread-cliper-title">📖 WeRead Clipper - 文本预览</span>
        <button class="weread-cliper-close" id="weread-cliper-close">✕</button>
      </div>
      <div class="weread-cliper-body">
        <pre>${escapeHtml(text)}</pre>
      </div>
      <div class="weread-cliper-footer">
        <span>共 ${text.length} 字 / ${text.split('\n').length} 行</span>
        <button class="weread-cliper-copy-btn" id="weread-cliper-copy">📋 复制全部</button>
      </div>
    `;

    document.body.appendChild(overlay);

    // 关闭按钮
    document.getElementById('weread-cliper-close').addEventListener('click', () => {
      overlay.remove();
    });

    // 复制按钮
    document.getElementById('weread-cliper-copy').addEventListener('click', () => {
      navigator.clipboard.writeText(text).then(() => {
        const btn = document.getElementById('weread-cliper-copy');
        btn.textContent = '✅ 已复制！';
        setTimeout(() => { btn.textContent = '📋 复制全部'; }, 2000);
      });
    });

    // ESC 关闭
    const escHandler = (e) => {
      if (e.key === 'Escape') {
        overlay.remove();
        document.removeEventListener('keydown', escHandler);
      }
    };
    document.addEventListener('keydown', escHandler);
  }

  function escapeHtml(str) {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  console.log('[WeRead Clipper] Content script loaded');
})();
