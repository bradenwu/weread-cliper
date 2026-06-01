# 📖 WeRead Clipper

> Chrome 浏览器扩展：自动滚动微信读书章节页面，通过本地 OCR 提取并拼接纯文本。

## 功能

- **一键提取章节**：自动隐藏页面工具栏，从章节顶部逐屏滚动到页面底部。
- **本地离线 OCR**：使用内置 Tesseract.js、WASM core 和 `chi_sim` 简体中文模型识别截图。
- **智能去重拼接**：通过中文字符清洗、滑动窗口和 Levenshtein 相似度消除相邻截图重叠。
- **内存可控**：截图逐屏处理，完成 OCR 后立即释放当前图片，不累计保存整章截图。
- **进度反馈**：弹窗实时展示截屏、识别和累计字数状态。
- **结果导出**：支持复制文本、页面内预览和导出 TXT。

## 安装

1. 克隆仓库：

   ```bash
   git clone https://github.com/bradenwu/weread-cliper.git
   ```

2. 打开 Chrome，进入 `chrome://extensions/`。
3. 开启右上角「开发者模式」。
4. 点击「加载已解压的扩展程序」。
5. 选择本项目根目录。

仓库已经包含离线 OCR 运行资产，无需额外构建。

## 使用

1. 在 Chrome 中打开 [微信读书网页版](https://weread.qq.com/web/reader/) 的章节阅读页。
2. 点击工具栏中的 WeRead Clipper 图标。
3. 点击「开始提取当前章节」。
4. 提取期间保持微信读书标签页位于当前窗口前台。
5. 完成后复制、预览或导出 TXT。

## 架构

| 模块 | 文件 | 职责 |
| --- | --- | --- |
| Popup | `popup.html`、`popup.js` | 发起任务、展示进度和结果、复制与导出。 |
| Service Worker | `background.js` | 调度截图、转发 OCR 请求、持久化任务状态。 |
| Content Script | `content.js`、`content.css` | 隐藏浮层、定位滚动容器、逐屏滚动、恢复页面、展示预览。 |
| Offscreen OCR | `offscreen.html`、`offscreen.js` | 运行 Tesseract.js Worker，串行识别截图并释放图片内存。 |
| 拼接算法 | `text-stitch.js` | 模糊重叠匹配、去重拼接和断层降级标记。 |
| 离线资产 | `vendor/tesseract/` | 浏览器脚本、WASM core 和简体中文模型。 |

## 开发与测试

本次 OCR 架构重构的执行过程、测试演进和踩坑记录见
[`OCR_REFACTOR_LOG.md`](OCR_REFACTOR_LOG.md)。

安装依赖：

```bash
npm install
npx playwright install chromium
```

运行 Jest 单元测试：

```bash
npm test -- --runInBand
```

运行 Chrome 扩展端到端测试：

```bash
npm run test:e2e
```

运行全部自动化测试：

```bash
npm run test:all
```

E2E 会启动 Playwright Chromium，加载临时测试扩展，通过模拟 OCR 文本验证真实的
MV3 service worker、`captureVisibleTab`、offscreen 页面、滚动恢复和 popup 展示链路；
同时实际初始化一次本地中文模型和 WASM core，验证离线资产可以在 MV3 CSP 下加载。

## 文档索引

| 文档 | 用途 |
| --- | --- |
| [`README.md`](README.md) | 面向用户的安装、使用和开发入口。 |
| [`AGENTS.md`](AGENTS.md) | 当前工程架构、约束和测试要求。 |
| [`OCR_REFACTOR_LOG.md`](OCR_REFACTOR_LOG.md) | 2026-06-01 OCR 重构执行记录、测试演进和问题修复。 |
| [`debug_log.md`](debug_log.md) | 2026-03-29 旧 DOM、运行态和网络 hook 方案的归档日志。 |

## 注意事项

- 扩展仅适用于 `https://weread.qq.com/web/reader/*`。
- OCR 结果可能存在错字。无法可靠识别相邻截图接缝时，输出会插入
  `[可能存在断层，需人工校对]`。
- 自动化 E2E 会加载 19MB 中文模型验证 OCR Worker 初始化，但不会对真实章节截图执行
  完整识别。发布前仍应在真实微信读书页面执行一次完整章节验证。
- 请遵守版权法律法规，仅处理你有权使用的内容。

## License

MIT License
