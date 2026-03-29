const BUILD_ID = '2026.03.29.4';

function bootstrapLog(message) {
  const logElement = document.getElementById('loadingLog');
  if (!logElement) {
    console.log('[WeRead Clipper bootstrap]', message);
    return;
  }

  const existing = logElement.textContent || '';
  logElement.textContent = `${existing}\n[bootstrap ${BUILD_ID}] ${message}`;
  logElement.scrollTop = logElement.scrollHeight;
  console.log('[WeRead Clipper bootstrap]', message);
}

window.addEventListener('error', (event) => {
  bootstrapLog(`window.error: ${event.message || 'unknown error'}`);
});

window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason instanceof Error ? event.reason.message : String(event.reason);
  bootstrapLog(`unhandledrejection: ${reason}`);
});

bootstrapLog('popup.js bootstrap 已执行');

let extractedData = null;
let initWatchdog = null;
let loadingStartedAt = 0;
let stageTicker = null;
let currentStage = '等待开始…';

function showToast(message) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2000);
}

function appendLog(message) {
  const timestamp = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const line = `[${timestamp}] ${message}`;
  const logElement = document.getElementById('loadingLog');
  if (logElement) {
    logElement.textContent += `\n${line}`;
    logElement.scrollTop = logElement.scrollHeight;
  }
  console.log('[WeRead Clipper]', message);
}

function setLoadingStage(message) {
  currentStage = message;
  const loadingText = document.getElementById('loadingText');
  if (loadingText) {
    const seconds = loadingStartedAt ? Math.floor((Date.now() - loadingStartedAt) / 1000) : 0;
    loadingText.textContent = `${message}${loadingStartedAt ? `（${seconds}s）` : ''}`;
  }
  appendLog(message);
}

function startStageTicker() {
  stopStageTicker();
  loadingStartedAt = Date.now();
  stageTicker = setInterval(() => {
    const loadingText = document.getElementById('loadingText');
    if (loadingText) {
      const seconds = Math.floor((Date.now() - loadingStartedAt) / 1000);
      loadingText.textContent = `${currentStage}（${seconds}s）`;
    }
  }, 1000);
}

function stopStageTicker() {
  if (stageTicker) {
    clearInterval(stageTicker);
    stageTicker = null;
  }
}

function clearInitWatchdog() {
  if (initWatchdog) {
    clearTimeout(initWatchdog);
    initWatchdog = null;
  }
}

function armInitWatchdog() {
  clearInitWatchdog();
  initWatchdog = setTimeout(() => {
    appendLog('watchdog 触发：10s 未完成');
    showError('页面扫描超时。请刷新阅读页并重新加载扩展后再试。');
  }, 10000);
}

async function extractInPageWorld(tabId) {
  appendLog(`准备向 tab ${tabId} 发起 chrome.scripting.executeScript`);
  const execution = chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: async () => {
      const log = [];
      const startedAt = Date.now();
      const deadline = () => Date.now() - startedAt > 2500;
      const PRIMARY_TEXT_MIN_LENGTH = 300;
      const FALLBACK_TEXT_MIN_LENGTH = 120;

      function normalizeText(text) {
        return (text || '')
          .replace(/\r/g, '')
          .replace(/\u00a0/g, ' ')
          .replace(/[ \t]+\n/g, '\n')
          .replace(/\n{3,}/g, '\n\n')
          .replace(/[ \t]{2,}/g, ' ')
          .trim();
      }

      function sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
      }

      function getCurrentChapter() {
        const selectors = [
          '.readerTopBar_title_chapter',
          '.readerChapterTitle',
          '.chapterTitle',
          '.chapter_title',
          '.readerChapterName',
        ];

        for (const selector of selectors) {
          const element = document.querySelector(selector);
          const text = element?.textContent?.trim();
          if (text) return text;
        }

        return '';
      }

      function getCurrentChapterUid() {
        const stateUid = window.__INITIAL_STATE__?.reader?.currentChapter?.chapterUid;
        if (stateUid !== undefined && stateUid !== null) return String(stateUid);
        return '';
      }

      function getCurrentBook() {
        const selectors = [
          '.readerTopBar_title_link',
          '.readerCatalog_bookInfo_title_txt',
        ];

        for (const selector of selectors) {
          const element = document.querySelector(selector);
          const text = element?.textContent?.trim();
          if (text) return text;
        }

        return document.title.split(' - ')[0]?.trim() || '未知书籍';
      }

      function extractTextFromNode(node) {
        if (!node) return '';

        const clone = node.cloneNode(true);
        clone.querySelectorAll(
          'script,style,svg,img,button,textarea,input,.wr_dialog,.passageCodeEditorWrapper'
        ).forEach((element) => element.remove());

        return normalizeText(clone.innerText || clone.textContent || '');
      }

      function htmlToText(html) {
        const container = document.createElement('div');
        container.innerHTML = html;
        return extractTextFromNode(container);
      }

      function looksLikeCss(text) {
        return /font-family:|text-indent:|background-image:|\.readerChapterContent/.test(text);
      }

      function looksLikeOutlinePath(path) {
        return /outline/i.test(path);
      }

      function countSentenceMarks(text) {
        return (text.match(/[。！？；!?]/g) || []).length;
      }

      function isLongEnough(text, minLength) {
        return Boolean(text) && text.length >= minLength;
      }

      function scoreCandidate(raw, chapter, path) {
        if (!raw || raw.length < 80) return -1000;

        let score = 0;
        const text = raw.trim();

        score += Math.min(80, Math.floor(text.length / 50));

        if (/[\u4e00-\u9fff]/.test(text)) score += 20;
        if (/<[^>]+>/.test(text)) score += 15;
        if (/passage|readerChapterContent|renderTargetContent|content\d?/.test(text)) score += 20;
        if (path && /chapter|content|reader/i.test(path)) score += 12;
        if (chapter && text.includes(chapter)) score += 30;

        if (looksLikeCss(text)) score -= 80;
        if (looksLikeOutlinePath(path)) score -= 40;
        if (/outline_section_item_content_text_content/.test(text)) score -= 40;
        if (/https?:\/\//.test(text) && text.length < 600) score -= 20;

        return score;
      }

      function pushRoot(roots, seen, value, label) {
        if (!value || seen.has(value)) return;
        seen.add(value);
        roots.push({ value, label });
      }

      function extractTextCandidates(value, chapterUid, depth = 0, seen = new WeakSet()) {
        if (!value || depth > 4) return [];

        if (typeof value === 'string') return [value];
        if (typeof value !== 'object') return [];
        if (seen.has(value)) return [];
        seen.add(value);

        if (Array.isArray(value)) {
          return value.slice(0, 20).flatMap((item) => extractTextCandidates(item, chapterUid, depth + 1, seen));
        }

        const keys = Object.keys(value);
        const orderedKeys = [];
        if (chapterUid && Object.prototype.hasOwnProperty.call(value, chapterUid)) {
          orderedKeys.push(chapterUid);
        }

        const preferred = [
          'targetHtml',
          'chapterContentTargetHtml',
          'chapterContentHtml',
          'contentHtml',
          'content',
          'html',
          'body',
          'text',
        ];

        for (const key of preferred) {
          if (Object.prototype.hasOwnProperty.call(value, key) && !orderedKeys.includes(key)) {
            orderedKeys.push(key);
          }
        }

        for (const key of keys) {
          if (!orderedKeys.includes(key)) orderedKeys.push(key);
        }

        return orderedKeys
          .slice(0, 20)
          .flatMap((key) => extractTextCandidates(value[key], chapterUid, depth + 1, seen));
      }

      function extractBestStructuredCandidate(value, chapter, chapterUid, path) {
        const rawCandidates = extractTextCandidates(value, chapterUid);
        let best = null;

        for (const raw of rawCandidates) {
          const score = scoreCandidate(raw, chapter, path);
          if (score <= 20) continue;

          const text = /<[^>]+>/.test(raw)
            ? htmlToText(raw)
            : normalizeText(raw);

          if (!isLongEnough(text, PRIMARY_TEXT_MIN_LENGTH)) continue;
          if (looksLikeCss(text)) continue;
          if (/outline_section_item_content_text_content/.test(raw)) continue;

          if (!best || score > best.score || text.length > best.text.length) {
            best = { text, score };
          }
        }

        return best ? { text: best.text, source: path } : null;
      }

      function getRuntimeRoots() {
        const roots = [];
        const seen = new Set();
        const elements = document.querySelectorAll(
          '#app, #routerView, .routerView, .readerContent, .readerChapterContent, body'
        );

        for (const element of elements) {
          if (element.__vue__) pushRoot(roots, seen, element.__vue__, 'dom.__vue__');
          if (element.__vueParentComponent) {
            pushRoot(roots, seen, element.__vueParentComponent, 'dom.__vueParentComponent');
          }
          if (element.__vue_app__) {
            pushRoot(roots, seen, element.__vue_app__, 'dom.__vue_app__');
            if (element.__vue_app__._instance) {
              pushRoot(roots, seen, element.__vue_app__._instance, 'dom.__vue_app__._instance');
            }
            if (element.__vue_app__._context?.config?.globalProperties?.$store?.state) {
              pushRoot(
                roots,
                seen,
                element.__vue_app__._context.config.globalProperties.$store.state,
                'dom.__vue_app__._context.config.globalProperties.$store.state'
              );
            }
          }
        }

        const app = document.querySelector('#app');
        if (app?.__vue__?.$store?.state) {
          pushRoot(roots, seen, app.__vue__.$store.state, 'app.__vue__.$store.state');
        }
        if (app?.__vueParentComponent?.proxy?.$store?.state) {
          pushRoot(
            roots,
            seen,
            app.__vueParentComponent.proxy.$store.state,
            'app.__vueParentComponent.proxy.$store.state'
          );
        }
        if (app?.__vueParentComponent?.appContext?.config?.globalProperties?.$store?.state) {
          pushRoot(
            roots,
            seen,
            app.__vueParentComponent.appContext.config.globalProperties.$store.state,
            'app.__vueParentComponent.appContext.config.globalProperties.$store.state'
          );
        }
        if (app?.__vue_app__?._instance?.proxy?.$store?.state) {
          pushRoot(
            roots,
            seen,
            app.__vue_app__._instance.proxy.$store.state,
            'app.__vue_app__._instance.proxy.$store.state'
          );
        }
        if (app?.__vue_app__?._instance?.appContext?.config?.globalProperties?.$store?.state) {
          pushRoot(
            roots,
            seen,
            app.__vue_app__._instance.appContext.config.globalProperties.$store.state,
            'app.__vue_app__._instance.appContext.config.globalProperties.$store.state'
          );
        }

        if (window.__INITIAL_STATE__) pushRoot(roots, seen, window.__INITIAL_STATE__, 'window.__INITIAL_STATE__');
        if (window.__NUXT__) pushRoot(roots, seen, window.__NUXT__, 'window.__NUXT__');
        if (window.__INITIAL_STATE__?.reader) {
          pushRoot(roots, seen, window.__INITIAL_STATE__.reader, 'window.__INITIAL_STATE__.reader');
        }

        return roots;
      }

      function isPromisingPath(path) {
        return /targetHtml|contentHtml|chapterContent|readerContent|renderTarget|passage|chapter/i.test(path);
      }

      function shouldSkipPath(path) {
        return /outline|catalog|search|review|avatar|cover|desc|intro|recommend|bookInfo/i.test(path);
      }

      function findDirectStateCandidate(chapter, chapterUid) {
        const app = document.querySelector('#app');
        const directCandidates = [
          {
            path: 'window.__INITIAL_STATE__.reader.chapterContentTargetHtml',
            value: window.__INITIAL_STATE__?.reader?.chapterContentTargetHtml,
          },
          {
            path: 'window.__INITIAL_STATE__.reader.chapterContentHtml',
            value: window.__INITIAL_STATE__?.reader?.chapterContentHtml,
          },
          {
            path: 'app.__vue_app__._instance.proxy.$store.state.reader.chapterContentTargetHtml',
            value: app?.__vue_app__?._instance?.proxy?.$store?.state?.reader?.chapterContentTargetHtml,
          },
          {
            path: 'app.__vue_app__._instance.proxy.$store.state.reader.chapterContentHtml',
            value: app?.__vue_app__?._instance?.proxy?.$store?.state?.reader?.chapterContentHtml,
          },
          {
            path: 'app.__vue_app__._instance.appContext.config.globalProperties.$store.state.reader.chapterContentTargetHtml',
            value: app?.__vue_app__?._instance?.appContext?.config?.globalProperties?.$store?.state?.reader?.chapterContentTargetHtml,
          },
          {
            path: 'app.__vue_app__._instance.appContext.config.globalProperties.$store.state.reader.chapterContentHtml',
            value: app?.__vue_app__?._instance?.appContext?.config?.globalProperties?.$store?.state?.reader?.chapterContentHtml,
          },
          {
            path: 'app.__vueParentComponent.proxy.$store.state.reader.chapterContentTargetHtml',
            value: app?.__vueParentComponent?.proxy?.$store?.state?.reader?.chapterContentTargetHtml,
          },
          {
            path: 'app.__vueParentComponent.proxy.$store.state.reader.chapterContentHtml',
            value: app?.__vueParentComponent?.proxy?.$store?.state?.reader?.chapterContentHtml,
          },
        ];

        for (const candidate of directCandidates) {
          const result = extractBestStructuredCandidate(candidate.value, chapter, chapterUid, candidate.path);
          if (result) {
            log.push(`direct state source: ${candidate.path}`);
            return result;
          }

          if (candidate.value && typeof candidate.value === 'object') {
            const keys = Object.keys(candidate.value).slice(0, 6).join(',');
            log.push(`direct state inspected: ${candidate.path} keys=${keys || '(empty)'}`);
          }
        }

        return null;
      }

      function findBestRuntimeCandidate(chapter) {
        const roots = getRuntimeRoots();
        const queue = roots.map((item) => ({ value: item.value, path: item.label, depth: 0 }));
        const visited = new WeakSet();
        let inspected = 0;

        while (queue.length && inspected < 1500 && !deadline()) {
          const current = queue.shift();
          inspected += 1;

          const value = current.value;
          if (!value) continue;

          if (typeof value === 'string') {
            if (shouldSkipPath(current.path)) continue;

            const score = scoreCandidate(value, chapter, current.path);
            if (score > 20) {
              const text = /<[^>]+>/.test(value)
                ? htmlToText(value)
                : normalizeText(value);

              if (!isLongEnough(text, PRIMARY_TEXT_MIN_LENGTH)) continue;
              if (looksLikeCss(text)) continue;
              if (/outline_section_item_content_text_content/.test(value)) continue;

              log.push(`runtime source: ${current.path}`);
              return { text, source: current.path };
            }
            continue;
          }

          if (typeof value !== 'object') continue;
          if (value === window || value === document || value instanceof Node) continue;
          if (visited.has(value)) continue;

          visited.add(value);
          if (current.depth >= 6) continue;

          let keys = [];
          try {
            if (Array.isArray(value)) {
              const limit = Math.min(value.length, 30);
              for (let index = 0; index < limit; index += 1) {
                keys.push(index);
              }
            } else {
              keys = Object.keys(value).slice(0, 40);
            }
          } catch (error) {
            continue;
          }

          keys.sort((left, right) => {
            const leftPath = `${current.path}.${String(left)}`;
            const rightPath = `${current.path}.${String(right)}`;
            return Number(isPromisingPath(rightPath)) - Number(isPromisingPath(leftPath));
          });

          for (const key of keys) {
            const nextPath = `${current.path}.${String(key)}`;
            if (shouldSkipPath(nextPath) && !isPromisingPath(nextPath)) continue;

            let child;
            try {
              child = value[key];
            } catch (error) {
              continue;
            }

            if (typeof child === 'function') continue;
            queue.push({ value: child, path: nextPath, depth: current.depth + 1 });
          }
        }

        log.push(`runtime roots: ${roots.length}`);
        log.push(`runtime inspected: ${inspected}`);

        return null;
      }

      function isVisible(element) {
        if (!element) return false;
        const style = window.getComputedStyle(element);
        if (style.display === 'none') return false;
        if (style.visibility === 'hidden') return false;
        const rect = element.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return false;
        return true;
      }

      function extractFromRenderTarget(chapter) {
        const selectors = [
          '#renderTargetContent .passage-content',
          '#renderTargetContent .passage-wrapper',
          '#renderTargetContent',
        ];

        const candidates = [];

        for (const selector of selectors) {
          const nodes = document.querySelectorAll(selector);
          nodes.forEach((node) => {
            if (!isVisible(node)) {
              log.push(`renderTarget node not visible: ${selector}`);
              return;
            }
            const text = extractTextFromNode(node);
            if (!isLongEnough(text, PRIMARY_TEXT_MIN_LENGTH)) {
              log.push(`renderTarget node too short: ${selector} len=${text.length}`);
              return;
            }
            candidates.push({ text, source: selector, node });
          });
        }

        if (candidates.length === 0) {
          log.push('renderTarget: no visible candidates found');
          return null;
        }

        let best = null;
        for (const candidate of candidates) {
          if (chapter && !candidate.text.includes(chapter)) {
            log.push(`renderTarget skipped by chapter mismatch: ${candidate.source}`);
            continue;
          }
          if (!best || candidate.text.length > best.text.length) {
            best = candidate;
          }
        }

        if (best) {
          log.push(`renderTarget source: ${best.source} len=${best.text.length}`);
          return { text: best.text, source: best.source };
        }

        log.push('renderTarget: no candidate matched chapter title');
        return null;
      }

      function extractFromDocumentMetadata(chapter) {
        const candidates = [
          {
            source: 'meta[name="description"]',
            value: document.querySelector('meta[name="description"]')?.content,
          },
          {
            source: 'meta[property="og:description"]',
            value: document.querySelector('meta[property="og:description"]')?.content,
          },
        ];

        let best = null;

        for (const candidate of candidates) {
          const text = normalizeText(candidate.value);
          if (!text) continue;

          const chapterMatched = chapter ? text.includes(chapter) : false;
          const sentenceMarks = countSentenceMarks(text);

          if (!isLongEnough(text, FALLBACK_TEXT_MIN_LENGTH)) {
            log.push(`meta skipped by length: ${candidate.source} len=${text.length}`);
            continue;
          }

          if (looksLikeCss(text)) {
            log.push(`meta skipped by css-like text: ${candidate.source}`);
            continue;
          }

          if (!chapterMatched && sentenceMarks < 2) {
            log.push(`meta skipped by weak semantics: ${candidate.source} len=${text.length}`);
            continue;
          }

          const score =
            text.length +
            (chapterMatched ? 120 : 0) +
            Math.min(60, sentenceMarks * 12);

          if (!best || score > best.score) {
            best = { text, score, source: candidate.source };
          }
        }

        if (best) {
          log.push(
            `meta source: ${best.source} len=${best.text.length} threshold=${FALLBACK_TEXT_MIN_LENGTH}`
          );
          return { text: best.text, source: best.source };
      }

        return null;
      }

      function extractFromNetworkCapture(chapter) {
        const capture = window.__wereadNetworkCapture;
        const candidates = capture?.getCandidates?.() || [];
        if (!candidates.length) return null;

        const now = Date.now();
        const maxAge = 30000;
        const recentCandidates = candidates.filter((c) => {
          const age = now - (c.capturedAt || 0);
          if (age > maxAge) {
            log.push(`network capture too old: ${c.source} age=${Math.round(age / 1000)}s`);
            return false;
          }
          return true;
        });

        if (!recentCandidates.length) {
          log.push('network capture: no recent candidates (all > 30s old)');
          return null;
        }

        const sorted = recentCandidates.slice().sort((left, right) => right.length - left.length);

        for (const candidate of sorted) {
          if (!isLongEnough(candidate.text, PRIMARY_TEXT_MIN_LENGTH)) continue;
          if (looksLikeCss(candidate.text)) continue;
          if (chapter && !candidate.text.includes(chapter)) {
            log.push(`network capture skipped by chapter miss: ${candidate.source} len=${candidate.length}`);
            continue;
          }

          const age = Math.round((now - (candidate.capturedAt || 0)) / 1000);
          log.push(
            `network capture: ${candidate.source} len=${candidate.length} age=${age}s url=${candidate.url || '(pv)'}`
          );

          return { text: candidate.text, source: `network:${candidate.source}`, detail: candidate };
        }

        return null;
      }

      function extractOutlineForDebug() {
        const items = Array.from(
          document.querySelectorAll('[data-wr-allow-copy="true"] .outline_section_item_content_text_content')
        ).map((element) => normalizeText(element.textContent));

        return items.filter(Boolean);
      }

      async function waitForRenderTarget(chapter) {
        for (let index = 0; index < 8 && !deadline(); index += 1) {
          const result = extractFromRenderTarget(chapter);
          if (result) return result;
          await sleep(150);
        }
        return null;
      }

      try {
        const book = getCurrentBook();
        const chapter = getCurrentChapter();
        const chapterUid = getCurrentChapterUid();
        log.push(`book: ${book}`);
        log.push(`chapter: ${chapter || '(empty)'}`);
        log.push(`chapterUid: ${chapterUid || '(empty)'}`);

        const renderTarget = await waitForRenderTarget(chapter);
        if (renderTarget) {
          return {
            success: true,
            text: renderTarget.text,
            chapter,
            book,
            source: `dom:${renderTarget.source}`,
            log,
          };
        }

        const directState = findDirectStateCandidate(chapter, chapterUid);
        if (directState) {
          return {
            success: true,
            text: directState.text,
            chapter,
            book,
            source: `state:${directState.source}`,
            log,
          };
        }

        const runtime = findBestRuntimeCandidate(chapter);
        if (runtime) {
          return {
            success: true,
            text: runtime.text,
            chapter,
            book,
            source: `runtime:${runtime.source}`,
            log,
          };
        }

        const network = extractFromNetworkCapture(chapter);
        if (network) {
          return {
            success: true,
            text: network.text,
            chapter,
            book,
            source: network.source,
            log,
          };
        }

        const metadata = extractFromDocumentMetadata(chapter);
        if (metadata) {
          return {
            success: true,
            text: metadata.text,
            chapter,
            book,
            source: `meta:${metadata.source}`,
            log,
          };
        }

        const outlineItems = extractOutlineForDebug();
        if (outlineItems.length) {
          log.push(`outline items: ${outlineItems.length}`);
          log.push(`outline preview: ${outlineItems.slice(0, 4).join(' / ')}`);
        }

        return {
          success: false,
          error: '未定位到章节正文。当前只检测到大纲/摘要节点，正文 HTML 目标容器仍为空。',
          chapter,
          book,
          log,
        };
      } catch (error) {
        return { success: false, error: error.message, log };
      }
    }
  });

  let timeoutId = null;
  const timeout = new Promise((resolve) => {
    timeoutId = setTimeout(() => {
      appendLog('extractInPageWorld 外层超时：8000ms');
      resolve([{
        result: {
          success: false,
          error: '页面扫描超时，已中止本次提取。',
          log: ['popup timeout: 8000ms'],
        }
      }]);
    }, 8000);
  });

  const pendingHint = setTimeout(() => {
    appendLog('页面脚本仍未返回，当前可能卡在 executeScript 或页面运行态扫描');
  }, 3000);

  const results = await Promise.race([execution, timeout]);
  if (timeoutId) {
    clearTimeout(timeoutId);
  }
  clearTimeout(pendingHint);
  appendLog('extractInPageWorld 已返回结果');
  return results?.[0]?.result;
}

async function init() {
  try {
    appendLog('popup.js 已加载');
    startStageTicker();
    armInitWatchdog();
    setLoadingStage('正在获取当前标签页');

    const searchParams = new URLSearchParams(window.location.search);
    const debugWeread = searchParams.get('debugWeread') === '1';
    let tab = null;

    if (debugWeread) {
      appendLog('debugWeread=1，正在查找微信读书标签页');
      const candidates = await chrome.tabs.query({ url: 'https://weread.qq.com/web/reader/*' });
      tab = candidates.find((item) => item.active) || candidates[0] || null;
    } else {
      [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    }

    if (!tab) { showError('无法获取当前标签页'); return; }
    if (!tab.url?.includes('weread.qq.com')) {
      showError('请在微信读书阅读页面使用本插件'); return;
    }

    appendLog(`当前标签页: ${tab.id} ${tab.url}`);
    setLoadingStage('正在连接当前阅读页');

    await new Promise((resolve) => setTimeout(resolve, 0));
    setLoadingStage('正在扫描页面结构');

    const result = await extractInPageWorld(tab.id);
    console.log('[WeRead Clipper] 提取结果:', result);
    console.log('[WeRead Clipper] 诊断日志:', result?.log);
    appendLog(`页面返回: ${result?.success ? 'success' : 'failed'}`);
    if (result?.log?.length) {
      for (const line of result.log.slice(0, 12)) {
        appendLog(`[page] ${line}`);
      }
    }

    if (!result || !result.success) {
      showError((result?.error || '提取失败') + '\n诊断: ' + (result?.log?.join(' | ') || ''));
      return;
    }

    const book = result.book || tab.title?.split(' - ')[0]?.trim() || '未知书籍';
    const chapter = result.chapter || getChapterFromDOM(tab);
    const formatted = `📖 ${book}\n📑 ${chapter}\n${'─'.repeat(40)}\n\n${result.text}`;

    extractedData = {
      success: true,
      text: formatted,
      rawText: result.text,
      chapter,
      book,
      charCount: result.text.length,
      lineCount: result.text.split('\n').length,
      source: result.source,
    };
    showResult(extractedData);
  } catch (error) {
    console.error('[WeRead Clipper] init 异常:', error);
    showError('发生错误: ' + error.message);
  }
}

function getChapterFromDOM(tab) {
  return tab.title?.split(' - ').pop()?.trim() || '未知章节';
}

function showError(message) {
  clearInitWatchdog();
  stopStageTicker();
  document.getElementById('loading').style.display = 'none';
  document.getElementById('content').style.display = 'block';
  document.getElementById('status').className = 'status error';
  document.getElementById('status').textContent = '⚠️ ' + message;
  document.getElementById('info').style.display = 'none';
  document.getElementById('preview').style.display = 'none';
  document.querySelector('.actions').style.display = 'none';
}

function showResult(data) {
  clearInitWatchdog();
  stopStageTicker();
  document.getElementById('loading').style.display = 'none';
  document.getElementById('content').style.display = 'block';
  document.getElementById('status').className = 'status success';
  document.getElementById('status').textContent = '✅ 成功提取文本内容';

  document.getElementById('bookName').textContent = data.book || '未知';
  document.getElementById('chapterName').textContent = data.chapter || '未知';
  document.getElementById('charCount').textContent = (data.charCount || 0) + ' 字';

  const previewText = data.rawText || data.text || '';
  document.getElementById('previewText').textContent =
    previewText.length > 200 ? previewText.substring(0, 200) + '...' : previewText;

  document.getElementById('btnCopy').disabled = false;
  document.getElementById('btnPreview').disabled = false;
}

function bindUIEvents() {
  const copyButton = document.getElementById('btnCopy');
  const previewButton = document.getElementById('btnPreview');

  if (!copyButton || !previewButton) {
    bootstrapLog('按钮节点缺失，无法绑定事件');
    return;
  }

  copyButton.addEventListener('click', async () => {
    if (!extractedData) return;

    try {
      await navigator.clipboard.writeText(extractedData.text);
      showToast('✅ 已复制到剪贴板！');

      copyButton.textContent = '✅ 已复制！';
      setTimeout(() => {
        copyButton.textContent = '📋 复制全部文本';
      }, 2000);
    } catch (error) {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab) {
        chrome.tabs.sendMessage(tab.id, {
          action: 'copyToClipboard',
          text: extractedData.text
        }, (response) => {
          if (response && response.success) {
            showToast('✅ 已复制到剪贴板！');
          } else {
            showToast('❌ 复制失败，请手动复制');
          }
        });
      }
    }
  });

  previewButton.addEventListener('click', async () => {
    if (!extractedData) return;

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) {
      chrome.tabs.sendMessage(tab.id, { action: 'selectText', text: extractedData.rawText }, () => {
        window.close();
      });
    }
  });

  bootstrapLog('按钮事件已绑定');
}

bindUIEvents();
init();
