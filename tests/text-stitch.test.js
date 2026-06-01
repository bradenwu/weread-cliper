const {
  findOverlap,
  levenshteinDistance,
  normalizeOcrText,
  similarity,
  stitchTexts,
} = require('../text-stitch.js');

describe('OCR 文本拼接算法', () => {
  test('计算 Levenshtein 距离和相似度', () => {
    expect(levenshteinDistance('测试文本', '测试文档')).toBe(1);
    expect(similarity(Array.from('测试文本'), Array.from('测试文档'))).toBeCloseTo(0.75);
  });

  test('忽略空格、换行和标点后定位中文重叠区域', () => {
    const overlap = findOverlap(
      '上一段结尾，这是用于验证自动去重拼接的公共文本。',
      '这是用于验证自动去重拼接的公共文本！下一段继续。',
      { minOverlap: 10 }
    );

    expect(overlap.found).toBe(true);
    expect(overlap.overlapLength).toBeGreaterThanOrEqual(10);
  });

  test('允许少量 OCR 错字并移除下一屏重复内容', () => {
    const result = stitchTexts(
      '第一屏正文。这是用于验证自动去重拼接的公共文本。',
      '这是用于验正自动去重拼接的公共文本。第二屏正文结束。',
      { minOverlap: 10, similarityThreshold: 0.85 }
    );

    expect(result.degraded).toBe(false);
    expect(result.text).toContain('第一屏正文');
    expect(result.text).toContain('第二屏正文结束');
    expect(result.text.match(/自动去重拼接/g)).toHaveLength(1);
  });

  test('无法识别接缝时插入人工校对标识，避免丢失文本', () => {
    const result = stitchTexts('第一页完全不同的内容', '第二页没有任何重叠文本');
    expect(result.degraded).toBe(true);
    expect(result.text).toContain('[可能存在断层，需人工校对]');
    expect(result.text).toContain('第一页完全不同的内容');
    expect(result.text).toContain('第二页没有任何重叠文本');
  });

  test('清理 OCR 多余空白但保留段落', () => {
    expect(normalizeOcrText(' 第一行  \n\n\n 第二行 \r\n')).toBe('第一行\n\n 第二行');
  });
});
