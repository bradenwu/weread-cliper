(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.WeReadTextStitch = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DEFAULT_OPTIONS = {
    // 搜索回溯上限，仅作为超长文本的安全护栏；真实重叠不会超过 next 长度，由其自然限定。
    maxOverlap: 4000,
    minOverlap: 10,
    similarityThreshold: 0.85,
    // 用于定位接缝的锚点窗口长度（中文字符数）。
    anchorLength: 16,
    // 锚点在 next 开头的多个起始偏移，用于跳过顶部被截断的噪声行。
    anchorSkips: [0, 3, 6, 10],
    // 校验时比对的最大窗口（中文字符数）：足以区分真接缝与偶然短串，避免对超长重叠做整段 Levenshtein。
    verifyLength: 64,
    // 通过锚点初筛后，最多对多少个候选位置做校验，控制最坏耗时。
    maxVerifications: 16,
    gapMarker: '\n\n[可能存在断层，需人工校对]\n\n',
  };

  // OCR 常把中文句读识别成半角符号；在中文语境下转回全角，数字千分位/英文不受影响。
  const HALF_TO_FULL_PUNCT = { ',': '，', ';': '；', ':': '：', '!': '！', '?': '？' };
  const toFullWidthPunct = (mark) => HALF_TO_FULL_PUNCT[mark] || mark;

  function normalizeOcrText(text) {
    return String(text || '')
      .replace(/\r/g, '')
      // 左侧为中文（可隔空格）的半角句读 → 全角
      .replace(/(?<=[㐀-鿿][ \t　]*)[,;:!?]/g, toFullWidthPunct)
      // 右侧为中文（可隔空格）的半角句读 → 全角
      .replace(/[,;:!?](?=[ \t　]*[㐀-鿿])/g, toFullWidthPunct)
      .replace(/(?<=[㐀-鿿。，、；：！？…“”‘’（）【】「」『』])[ \t　]+(?=[㐀-鿿。，、；：！？…“”‘’（）【】「」『』])/g, '')
      .replace(/[ \t　]+\n/g, '\n')
      .replace(/\n[ \t]+/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/(?<!\n)\n(?=\S)/g, '')
      .trim();
  }

  function chineseCharactersWithOffsets(text) {
    const characters = [];
    const offsets = [];

    Array.from(String(text || '')).forEach((character, index) => {
      if (/[\u3400-\u9fff]/.test(character)) {
        characters.push(character);
        offsets.push(index);
      }
    });

    return { characters, offsets };
  }

  function levenshteinDistance(left, right) {
    if (left === right) return 0;
    if (!left.length) return right.length;
    if (!right.length) return left.length;

    let previous = Array.from({ length: right.length + 1 }, (_, index) => index);

    for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
      const current = [leftIndex + 1];
      for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
        const substitutionCost = left[leftIndex] === right[rightIndex] ? 0 : 1;
        current.push(Math.min(
          current[rightIndex] + 1,
          previous[rightIndex + 1] + 1,
          previous[rightIndex] + substitutionCost
        ));
      }
      previous = current;
    }

    return previous[right.length];
  }

  function similarity(left, right) {
    const longest = Math.max(left.length, right.length);
    if (!longest) return 1;
    return 1 - (levenshteinDistance(left, right) / longest);
  }

  const NOT_FOUND = { found: false, overlapLength: 0, similarity: 0, nextCutIndex: 0 };

  // \u5c06 next \u7684\u300c\u4e2d\u6587\u5b57\u7b26\u4e0b\u6807\u300d\u6362\u7b97\u6210\u539f\u59cb\u5b57\u7b26\u4e32\u91cc\u7684\u5207\u5272\u4f4d\u7f6e\uff08\u4fdd\u7559\u8be5\u4e0b\u6807\u53ca\u5176\u4e4b\u540e\u7684\u5185\u5bb9\uff09\u3002
  function nextCharIndexToStringOffset(nextText, offsets, charIndex) {
    if (charIndex <= 0) return 0;
    if (charIndex >= offsets.length) return nextText.length;
    let cut = offsets[charIndex - 1] + 1;
    while (cut < nextText.length && !/[\u3400-\u9fff]/.test(nextText[cut])) {
      cut += 1;
    }
    return cut;
  }

  // \u63a5\u7f1d\u5b9a\u4f4d\uff08\u951a\u70b9\u6cd5\uff09\uff1a
  // \u65e7\u5b9e\u73b0\u8981\u6c42\u300cprevious \u540e\u7f00\u300d\u4e0e\u300cnext \u524d\u7f00\u300d\u957f\u5ea6\u5b8c\u5168\u76f8\u7b49\u624d\u5339\u914d\uff0c\u4e00\u65e6\u771f\u5b9e\u91cd\u53e0
  // \u8d85\u8fc7 maxOverlap\uff08\u5bc6\u96c6\u9875\u3001\u672b\u5c4f\u6eda\u52a8\u88ab clamp \u65f6\u5e38\u89c1\uff09\uff0c\u6240\u6709\u7b49\u957f\u7a97\u53e3\u90fd\u662f\u9519\u4f4d\u6bd4\u8f83\uff0c
  // \u5fc5\u7136\u5931\u8d25\u5e76\u63d2\u5165\u65ad\u5c42\u6807\u8bb0\u3002\u65b0\u5b9e\u73b0\u6539\u4e3a\uff1a\u4ece next \u5934\u90e8\u53d6\u4e00\u4e2a\u77ed\u951a\u70b9\uff0c\u5728 previous \u5c3e\u90e8
  // \u6ed1\u52a8\u5b9a\u4f4d\u5176\u51fa\u73b0\u4f4d\u7f6e\uff0c\u7531\u6b64\u63a8\u7b97\u4efb\u610f\u957f\u5ea6\u7684\u91cd\u53e0\uff0c\u518d\u505a\u6574\u6bb5\u6821\u9a8c\u3002\u8017\u65f6\u968f next \u957f\u5ea6\u7ebf\u6027\u589e\u957f\u3002
  function findOverlap(previousText, nextText, options = {}) {
    const config = { ...DEFAULT_OPTIONS, ...options };
    const previous = chineseCharactersWithOffsets(previousText);
    const next = chineseCharactersWithOffsets(nextText);
    const previousLength = previous.characters.length;
    const nextLength = next.characters.length;

    if (previousLength < config.minOverlap || nextLength < config.minOverlap) {
      return { ...NOT_FOUND };
    }

    const anchorLength = Math.min(config.anchorLength, nextLength);
    // \u91cd\u53e0\u4e0d\u4f1a\u8d85\u8fc7 next \u81ea\u8eab\u957f\u5ea6\uff1bmaxOverlap \u4ec5\u4f5c\u4e3a\u8d85\u957f\u6587\u672c\u7684\u5b89\u5168\u4e0a\u9650\u3002
    const searchSpan = Math.min(nextLength, config.maxOverlap);
    const minPosition = Math.max(0, previousLength - searchSpan);

    // \u7b2c\u4e00\u6b65\uff1a\u7528\u77ed\u951a\u70b9\u5728 previous \u5c3e\u90e8\u521d\u7b5b\u53ef\u80fd\u7684\u5bf9\u9f50\u4f4d\u7f6e\uff08\u5ec9\u4ef7\uff09\u3002
    const candidates = [];
    for (const skip of config.anchorSkips) {
      if (skip + anchorLength > nextLength) continue;
      const anchor = next.characters.slice(skip, skip + anchorLength);
      for (let position = minPosition; position + anchorLength <= previousLength; position += 1) {
        const window = previous.characters.slice(position, position + anchorLength);
        const score = similarity(anchor, window);
        if (score >= config.similarityThreshold) {
          candidates.push({ position, skip, anchorScore: score });
        }
      }
    }

    if (!candidates.length) return { ...NOT_FOUND };

    // \u6821\u9a8c\u987a\u5e8f\uff1a\u5148\u6309\u951a\u70b9\u76f8\u4f3c\u5ea6\uff0c\u518d\u6309\u300c\u8d8a\u9760\u8fd1 previous \u5c3e\u90e8\u8d8a\u4f18\u5148\u300d\u3002
    // \u6eda\u52a8\u622a\u5c4f\u7684\u771f\u5b9e\u63a5\u7f1d\u5fc5\u7136\u843d\u5728\u7d2f\u8ba1\u6587\u672c\u7684\u5c3e\u90e8\uff0c\u800c\u4e66\u4e2d\u5176\u5b83\u4f4d\u7f6e\u7684\u91cd\u590d\u77ed\u8bed\uff08\u540c\u6837\u53ef\u80fd\u4e0e
    // \u951a\u70b9\u7b49\u5206\uff09\u5219\u8fdc\u5728\u4e0a\u65b9\uff1b\u9760\u5c3e\u90e8\u4f18\u5148\u53ef\u786e\u4fdd\u771f\u5b9e\u63a5\u7f1d\u5728\u6821\u9a8c\u9884\u7b97\u5185\u88ab\u547d\u4e2d\uff0c\u907f\u514d\u88ab\u524d\u9762\u7684
    // \u91cd\u590d\u4e32\u5360\u6ee1\u9884\u7b97\u540e\u8bef\u5224\u65ad\u5c42\u3002
    candidates.sort((a, b) => b.anchorScore - a.anchorScore || b.position - a.position);

    // \u7b2c\u4e8c\u6b65\uff1a\u5bf9\u5019\u9009\u505a\u91cd\u53e0\u6821\u9a8c\uff0c\u6311\u51fa\u6700\u53ef\u9760\u7684\u63a5\u7f1d\u3002
    let best = null;
    const limit = Math.min(candidates.length, config.maxVerifications);
    for (let index = 0; index < limit; index += 1) {
      const { position, skip } = candidates[index];
      // previous[position] \u5bf9\u9f50 next[skip]\uff0c\u91cd\u53e0\u5ef6\u4f38\u81f3 previous \u672b\u5c3e\uff08\u6216 next \u672b\u5c3e\uff0c\u53d6\u8f83\u77ed\uff09\u3002
      const overlapLength = Math.min(previousLength - position, nextLength - skip);
      if (overlapLength < config.minOverlap) continue;

      // \u4ec5\u6bd4\u5bf9\u524d verifyLength \u4e2a\u5b57\u7b26\u5373\u53ef\u533a\u5206\u771f\u63a5\u7f1d\u4e0e\u5076\u7136\u77ed\u4e32\uff0c\u907f\u514d\u5bf9\u8d85\u957f\u91cd\u53e0\u505a\u6574\u6bb5 Levenshtein\u3002
      const verifyLength = Math.min(overlapLength, config.verifyLength);
      const previousWindow = previous.characters.slice(position, position + verifyLength);
      const nextWindow = next.characters.slice(skip, skip + verifyLength);
      const score = similarity(previousWindow, nextWindow);
      if (score < config.similarityThreshold) continue;

      // next \u4e2d\u7b2c\u4e00\u4e2a\u300c\u4e0d\u5c5e\u4e8e\u91cd\u53e0\u300d\u7684\u4e2d\u6587\u5b57\u7b26\u4e0b\u6807\uff0c\u4e4b\u524d\u7684\u5185\u5bb9\u5168\u90e8\u53bb\u91cd\u3002
      const nextCutCharIndex = skip + overlapLength;
      const nextCutIndex = nextCharIndexToStringOffset(nextText, next.offsets, nextCutCharIndex);

      if (!best
        || score > best.similarity
        || (score === best.similarity && overlapLength > best.overlapLength)) {
        best = {
          found: true,
          overlapLength,
          similarity: score,
          nextCutIndex,
        };
      }
    }

    return best || { ...NOT_FOUND };
  }

  function stitchTexts(previousText, nextText, options = {}) {
    const config = { ...DEFAULT_OPTIONS, ...options };
    const previous = normalizeOcrText(previousText);
    const next = normalizeOcrText(nextText);

    if (!previous) return { text: next, overlap: null, degraded: false };
    if (!next) return { text: previous, overlap: null, degraded: false };

    const overlap = findOverlap(previous, next, config);
    if (!overlap.found) {
      return {
        text: `${previous}${config.gapMarker}${next}`,
        overlap,
        degraded: true,
      };
    }

    return {
      text: `${previous}${next.slice(overlap.nextCutIndex)}`,
      overlap,
      degraded: false,
    };
  }

  return {
    DEFAULT_OPTIONS,
    findOverlap,
    levenshteinDistance,
    normalizeOcrText,
    similarity,
    stitchTexts,
  };
});
