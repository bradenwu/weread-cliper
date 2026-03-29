/**
 * WeRead Clipper - Content Script
 * 仅负责页面内预览与剪贴板兜底，不再承担正文提取。
 */

(function () {
  'use strict';

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
      navigator.clipboard.writeText(text).then(() => {
        const button = document.getElementById('weread-cliper-copy');
        button.textContent = '✅ 已复制！';
        setTimeout(() => {
          button.textContent = '📋 复制全部';
        }, 2000);
      });
    });

    document.addEventListener('keydown', escHandler);
  }

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'copyToClipboard') {
    navigator.clipboard.writeText(request.text).then(() => {
      sendResponse({ success: true });
      }).catch(() => {
        const textarea = document.createElement('textarea');
        textarea.value = request.text;
        textarea.style.cssText = 'position:fixed;opacity:0';
        document.body.appendChild(textarea);
        textarea.select();
        try {
          document.execCommand('copy');
          sendResponse({ success: true });
        } catch (error) {
          sendResponse({ success: false, error: '复制失败' });
        }
        document.body.removeChild(textarea);
      });
      return true;
    }

    if (request.action === 'selectText') {
      try {
        showOverlay(request.text || '');
        sendResponse({ success: true });
      } catch (error) {
        sendResponse({ success: false, error: error.message });
      }
      return true;
  }

  return false;
});

console.log('[WeRead Clipper] Content script loaded');

function injectNetworkCaptureHook() {
  if (window.__wereadNetworkCaptureInjected) return;
  window.__wereadNetworkCaptureInjected = true;

  const hookScript = `
  (function() {
    if (window.__wereadNetworkCaptureInstalled) return;
    window.__wereadNetworkCaptureInstalled = true;

    const MIN_CAPTURE_LEN = 220;
    const MAX_CANDIDATES = 60;
    const candidates = [];
    const seen = new Set();
    const decoder = new TextDecoder('utf-8');

    function normalizeCandidate(text) {
      return (text || '')
        .replace(/[\\r\\t]/g, '')
        .replace(/\\s{2,}/g, ' ')
        .trim();
    }

    function storeCandidate(source, url, text, detail = '') {
      const normalized = normalizeCandidate(text);
      if (!normalized || normalized.length < MIN_CAPTURE_LEN) return;
      const fingerprint = \`\${source}|\${url}|\${normalized.slice(0, 160)}\`;
      if (seen.has(fingerprint)) return;
      seen.add(fingerprint);
      candidates.push({
        source,
        url: url || '',
        detail,
        text: normalized,
        length: normalized.length,
        capturedAt: Date.now(),
      });
      if (candidates.length > MAX_CANDIDATES) {
        const removed = candidates.shift();
        seen.delete(\`\${removed.source}|\${removed.url}|\${removed.text.slice(0, 160)}\`);
      }
    }

    window.__wereadNetworkCapture = {
      getCandidates: function() {
        return candidates.slice();
      }
    };

    function attachResponseHook(methodName, handler) {
      const original = Response.prototype[methodName];
      if (!original) return;
      Response.prototype[methodName] = function() {
        return original.apply(this, arguments).then((value) => {
          try {
            handler.call(this, value);
          } catch (error) {
            console.warn('WeReadCliper capture error', error);
          }
          return value;
        });
      };
    }

    attachResponseHook('text', function(value) {
      storeCandidate('response.text', this.url, String(value), 'text');
    });

    attachResponseHook('json', function(value) {
      storeCandidate('response.json', this.url, JSON.stringify(value), 'json');
    });

    attachResponseHook('arrayBuffer', function(buffer) {
      const contentType = this.headers ? this.headers.get('content-type') : '';
      if (!contentType || !/(text|json|xml)/i.test(contentType)) return;
      const text = decoder.decode(buffer);
      storeCandidate('response.arrayBuffer', this.url, text, 'arrayBuffer');
    });

    if (window.XMLHttpRequest) {
      const origOpen = window.XMLHttpRequest.prototype.open;
      const origSend = window.XMLHttpRequest.prototype.send;

      window.XMLHttpRequest.prototype.open = function() {
        try {
          this.__wereadCaptureUrl = arguments[1];
        } catch (error) {}
        return origOpen.apply(this, arguments);
      };

      window.XMLHttpRequest.prototype.send = function() {
        this.addEventListener('load', () => {
          if (this.responseType && this.responseType !== 'text') return;
          storeCandidate(
            'xhr.responseText',
            this.__wereadCaptureUrl || this.responseURL,
            this.responseText,
            'xhr'
          );
        });
        return origSend.apply(this, arguments);
      };
    }
  })();
  `;

  const script = document.createElement('script');
  script.textContent = hookScript;
  document.documentElement.appendChild(script);
  script.remove();
}

injectNetworkCaptureHook();
})();
