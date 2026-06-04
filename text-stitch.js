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
    maxOverlap: 300,
    minOverlap: 10,
    similarityThreshold: 0.85,
    gapMarker: '\n\n[可能存在断层，需人工校对]\n\n',
  };

  function normalizeOcrText(text) {
    return String(text || '')
      .replace(/\r/g, '')
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

  function findOverlap(previousText, nextText, options = {}) {
    const config = { ...DEFAULT_OPTIONS, ...options };
    const previous = chineseCharactersWithOffsets(previousText);
    const next = chineseCharactersWithOffsets(nextText);
    const maximum = Math.min(config.maxOverlap, previous.characters.length, next.characters.length);
    let best = null;

    for (let length = maximum; length >= config.minOverlap; length -= 1) {
      const previousSuffix = previous.characters.slice(-length);
      const nextPrefix = next.characters.slice(0, length);
      const score = similarity(previousSuffix, nextPrefix);
      if (score >= config.similarityThreshold) {
        let nextCutIndex = next.offsets[length - 1] + 1;
        while (nextCutIndex < nextText.length && !/[\u3400-\u9fff]/.test(nextText[nextCutIndex])) {
          nextCutIndex += 1;
        }
        const candidate = {
          found: true,
          overlapLength: length,
          similarity: score,
          nextCutIndex,
        };
        if (!best || score > best.similarity || (score === best.similarity && length > best.overlapLength)) {
          best = candidate;
        }
      }
    }

    return best || { found: false, overlapLength: 0, similarity: 0, nextCutIndex: 0 };
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
