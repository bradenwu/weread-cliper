function createPopupShell() {
  document.body.innerHTML = `
    <div id="loading">
      <span id="loadingText"></span>
      <pre id="loadingLog"></pre>
    </div>
    <div id="content" style="display:none;">
      <div id="status"></div>
      <div id="info">
        <span id="bookName"></span>
        <span id="chapterName"></span>
        <span id="charCount"></span>
      </div>
      <div id="preview">
        <div id="previewText"></div>
      </div>
      <div class="actions">
        <button id="btnCopy" disabled></button>
        <button id="btnPreview" disabled></button>
      </div>
    </div>
    <div id="toast"></div>
  `;
}

function installPageDom({ chapter, book, metaDescription, outlineTexts = [] }) {
  document.title = `${book} - 作者 - 微信读书`;

  const titleLink = document.createElement('span');
  titleLink.className = 'readerTopBar_title_link';
  titleLink.textContent = book;
  document.body.appendChild(titleLink);

  const chapterNode = document.createElement('span');
  chapterNode.className = 'readerTopBar_title_chapter';
  chapterNode.textContent = chapter;
  document.body.appendChild(chapterNode);

  const renderTarget = document.createElement('div');
  renderTarget.id = 'renderTargetContent';
  renderTarget.innerHTML = '<div class="passage-wrapper"><div class="passage-content"></div></div>';
  document.body.appendChild(renderTarget);

  if (metaDescription !== undefined) {
    const meta = document.createElement('meta');
    meta.name = 'description';
    meta.content = metaDescription;
    document.head.appendChild(meta);
  }

  for (const text of outlineTexts) {
    const wrapper = document.createElement('div');
    wrapper.setAttribute('data-wr-allow-copy', 'true');
    wrapper.innerHTML = `<span class="outline_section_item_content_text_content">${text}</span>`;
    document.body.appendChild(wrapper);
  }
}

async function flushAsyncWork() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 1400));
  await Promise.resolve();
}

describe('popup extraction heuristics', () => {
  const tab = {
    id: 1,
    url: 'https://weread.qq.com/web/reader/0633241059b4260632af2bf',
    title: '反脆弱：从不确定性中获益 - 纳西姆·尼古拉斯·塔勒布 - 微信读书',
  };

  beforeEach(() => {
    jest.resetModules();
    document.head.innerHTML = '';
    document.body.innerHTML = '';
    createPopupShell();

    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: jest.fn().mockResolvedValue(undefined) },
      configurable: true,
    });

    global.chrome = {
      tabs: {
        query: jest.fn().mockResolvedValue([tab]),
        sendMessage: jest.fn(),
      },
      scripting: {
        executeScript: jest.fn(async ({ func }) => [{ result: await func() }]),
      },
    };

    window.close = jest.fn();
  });

  test('当正文容器为空时，使用章节级 meta 描述作为长度达标兜底', async () => {
    installPageDom({
      chapter: '第七卷 脆弱性与反脆弱性的伦理',
      book: '反脆弱：从不确定性中获益',
      metaDescription:
        '第七卷 脆弱性与反脆弱性的伦理 道德问题的出现 不透明性和新发现的复杂性使人们可以隐藏风险、伤害他人，同时却可以逍遥法外。医源性损伤往往带来滞后和无形的后果，我们很难看到其中的因果关系。《汉谟拉比法典》的解决方案提供了一个简单方案，即在伤害他人时，只有切身利害才能真正缓和脆弱性。',
    });

    require('../popup.js');
    await flushAsyncWork();

    expect(document.getElementById('status').textContent).toContain('成功提取文本内容');
    expect(document.getElementById('chapterName').textContent).toContain('第七卷 脆弱性与反脆弱性的伦理');
    expect(document.getElementById('previewText').textContent).toContain('道德问题的出现');
    expect(document.getElementById('charCount').textContent).not.toBe('0 字');
    expect(document.getElementById('btnCopy').disabled).toBe(false);
  });

  test('长度不足阈值时不把 meta 文本误判为成功', async () => {
    installPageDom({
      chapter: '第七卷 脆弱性与反脆弱性的伦理',
      book: '反脆弱：从不确定性中获益',
      metaDescription: '第七卷 脆弱性与反脆弱性的伦理 简介',
      outlineTexts: ['这是大纲节点，不应被当成正文结果。'],
    });

    require('../popup.js');
    await flushAsyncWork();

    expect(document.getElementById('status').textContent).toContain('未定位到章节正文');
    expect(document.getElementById('btnCopy').disabled).toBe(true);
  });
});
