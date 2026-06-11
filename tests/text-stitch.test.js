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

  // 构造确定性的汉字串：每个字符唯一，便于断言去重
  function buildHan(count, seed) {
    let text = '';
    for (let index = 0; index < count; index += 1) {
      text += String.fromCharCode(0x4e00 + ((seed + index * 7) % 2000));
    }
    return text;
  }

  test('重叠区远超 maxOverlap（密集页）仍能正确拼接，不产生断层', () => {
    const shared = buildHan(350, 100);
    const previous = `前文独有内容${buildHan(120, 1)}${shared}`;
    const next = `${shared}${buildHan(120, 1500)}后文独有内容`;

    const result = stitchTexts(previous, next);

    expect(result.degraded).toBe(false);
    expect(result.text).toContain('前文独有内容');
    expect(result.text).toContain('后文独有内容');
    // 共享区只应保留一份
    expect(result.text.split(shared).length - 1).toBe(1);
  });

  test('末屏几乎整屏重叠（滚动被 clamp）仍能正确拼接', () => {
    const shared = buildHan(600, 200);
    const previous = `${buildHan(60, 1)}${shared}`;
    const next = `${shared}${buildHan(40, 1800)}末屏新增内容`;

    const result = stitchTexts(previous, next);

    expect(result.degraded).toBe(false);
    expect(result.text).toContain('末屏新增内容');
    expect(result.text.split(shared).length - 1).toBe(1);
  });

  test('next 头部锚点在前文尾部重复时优先校验靠尾部的真实接缝', () => {
    // next 开头的 16 字锚点在 previous 尾部多次出现（重复小标题/短语），这些假命中
    // 与真实接缝锚点同分；真实接缝在最靠近尾部处。若只按锚点分数、升序位置校验，前面
    // 的重复会先占满校验预算导致真实接缝漏检、误判断层。这里用较小的 maxVerifications
    // 放大预算压力，验证「靠尾部优先」的排序能稳定命中真实接缝。
    const anchorHead = buildHan(16, 500);
    const falseBlock = `${anchorHead}${buildHan(1, 50)}`; // 以锚点开头但后续不同
    const shared = `${anchorHead}${buildHan(30, 900)}`; // 真正与 next 重叠的内容
    const previous = `${buildHan(20, 1)}${falseBlock.repeat(10)}${shared}`;
    const next = `${shared}${buildHan(120, 1700)}下一屏新增`;

    const result = stitchTexts(previous, next, { maxVerifications: 3 });

    expect(result.degraded).toBe(false);
    expect(result.text).toContain('下一屏新增');
    expect(result.text.split(shared).length - 1).toBe(1);
  });

  test('下一屏顶部有截断噪声行时仍能定位接缝', () => {
    const shared = buildHan(200, 300);
    const previous = `${buildHan(80, 1)}${shared}`;
    // 模拟顶部被截断的半行噪声
    const next = `噪声残行x9\n${shared}${buildHan(50, 1900)}正文结尾`;

    const result = stitchTexts(previous, next);

    expect(result.degraded).toBe(false);
    expect(result.text).toContain('正文结尾');
  });

  test('清理 OCR 多余空白但保留段落', () => {
    expect(normalizeOcrText(' 第一行  \n\n\n 第二行 \r\n')).toBe('第一行\n\n第二行');
  });

  test('移除中文字符之间的 OCR 空格', () => {
    expect(normalizeOcrText('这 是 一 段 文 字')).toBe('这是一段文字');
    expect(normalizeOcrText('第 一 行\n第 二 行')).toBe('第一行第二行');
  });

  test('合并段落内的软换行，保留空行分段', () => {
    expect(
      normalizeOcrText('研究人员发现\n智商提高的迹象。\n\n第二段开始\n继续内容')
    ).toBe('研究人员发现智商提高的迹象。\n\n第二段开始继续内容');
  });

  test('保留段首缩进，不误并真正的分段', () => {
    expect(normalizeOcrText('上一段结尾。\n　　新段落开头')).toBe('上一段结尾。\n　　新段落开头');
  });

  test('合并自然换行并清理标点周围的 OCR 空格', () => {
    const raw = [
      '脑力训练游戏的效果如何 ？ 我们见证了一门新生意的兴起 ， 它声',
      '称大脑就像肌肉一样 ，',
      '可以通过网络游戏和视频来训练 ， 从而打造人的认知能力 。 这',
      '类产品大部分都基于',
      '2008 年报道的在瑞士进行的一项研究 ， 但这项研究的范围非常窄',
      '， 而且成果无法重现 。',
    ].join('\n');

    expect(normalizeOcrText(raw)).toBe(
      '脑力训练游戏的效果如何？我们见证了一门新生意的兴起，它声称大脑就像肌肉一样，'
        + '可以通过网络游戏和视频来训练，从而打造人的认知能力。这类产品大部分都基于'
        + '2008 年报道的在瑞士进行的一项研究，但这项研究的范围非常窄，而且成果无法重现。'
    );
  });

  test('合并行尾汉字与下一行数字之间的换行', () => {
    expect(normalizeOcrText('组成智商的智力有两种\n4 岁的孩子')).toBe('组成智商的智力有两种4 岁的孩子');
  });

  test('中文语境下的半角标点转全角并去除前后空格', () => {
    expect(
      normalizeOcrText('对别人来说 , 时间只是一条射线 ; 可对我们来说 , 时间是一个半径可以几何级数增长的管道。')
    ).toBe('对别人来说，时间只是一条射线；可对我们来说，时间是一个半径可以几何级数增长的管道。');
    expect(normalizeOcrText('相信科学才是更靠谱、更有效的途径 , 甚至是唯一途径 !')).toBe(
      '相信科学才是更靠谱、更有效的途径，甚至是唯一途径！'
    );
  });

  test('保留数字千分位与英文中的半角标点', () => {
    expect(normalizeOcrText('总计 1,000 元')).toBe('总计 1,000 元');
    expect(normalizeOcrText('版本 v1.2.3 已发布')).toBe('版本 v1.2.3 已发布');
  });

  test('行首的半角空格视为 OCR 噪声，不阻止软换行合并', () => {
    expect(normalizeOcrText('研究人员发现\n 智商提高')).toBe('研究人员发现智商提高');
  });
});
