(function () {
  'use strict';

  let worker = null;
  let session = null;

  function sendProgress(payload) {
    chrome.runtime.sendMessage({
      target: 'background',
      type: 'OCR_PROGRESS',
      ...payload,
    }).catch(() => {});
  }

  async function getWorker() {
    if (worker) return worker;

    sendProgress({ message: '正在初始化本地中文 OCR 模型' });
    worker = await Tesseract.createWorker('chi_sim', 1, {
      workerPath: chrome.runtime.getURL('vendor/tesseract/worker.min.js'),
      corePath: chrome.runtime.getURL('vendor/tesseract/core'),
      langPath: chrome.runtime.getURL('vendor/tesseract/lang'),
      workerBlobURL: false,
      gzip: true,
      logger: (event) => {
        if (event.status === 'recognizing text') {
          sendProgress({
            message: `正在识别第 ${session?.pageNumber || 1} 屏`,
            ocrProgress: event.progress,
          });
        }
      },
    });
    return worker;
  }

  async function recognizePage(dataUrl, pageNumber, mockText) {
    session.pageNumber = pageNumber;
    let rawText = mockText;
    if (typeof rawText !== 'string') {
      const ocrWorker = await getWorker();
      const result = await ocrWorker.recognize(dataUrl);
      rawText = result.data.text;
    }
    const pageText = WeReadTextStitch.normalizeOcrText(rawText);
    const stitched = WeReadTextStitch.stitchTexts(session.text, pageText);
    session.text = stitched.text;
    session.pagesProcessed += 1;
    if (stitched.degraded) session.degradedJoins += 1;

    return {
      pageTextLength: pageText.length,
      textLength: session.text.length,
      degraded: stitched.degraded,
      overlap: stitched.overlap,
    };
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.target !== 'offscreen') return false;

    (async () => {
      if (message.type === 'OCR_START') {
        session = { text: '', pagesProcessed: 0, degradedJoins: 0, pageNumber: 0 };
        sendResponse({ success: true });
        return;
      }

      if (message.type === 'OCR_PAGE') {
        if (!session) throw new Error('OCR 会话尚未初始化');
        const result = await recognizePage(message.dataUrl, message.pageNumber, message.mockText);
        sendResponse({ success: true, ...result });
        return;
      }

      if (message.type === 'OCR_WARMUP') {
        await getWorker();
        sendResponse({ success: true });
        return;
      }

      if (message.type === 'OCR_FINISH') {
        if (!session) throw new Error('OCR 会话尚未初始化');
        sendResponse({ success: true, ...session });
        session = null;
        return;
      }

      if (message.type === 'OCR_RESET') {
        session = null;
        if (worker) {
          await worker.terminate();
          worker = null;
        }
        sendResponse({ success: true });
      }
    })().catch((error) => {
      sendResponse({ success: false, error: error.message });
    });

    return true;
  });
})();
