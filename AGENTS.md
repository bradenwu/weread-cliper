# AGENTS.md

## 项目概述

WeRead Clipper 是 Chrome Manifest V3 扩展。它面向
`https://weread.qq.com/web/reader/*`，通过自动滚动、逐屏截图和本地 OCR 提取当前
章节文本。不要恢复旧的 DOM、运行态对象或网络响应探测方案：当前产品路径是视觉截图。

仓库根目录可直接作为未打包扩展加载，不需要构建。`vendor/tesseract/` 已内置约 36MB
OCR 运行资产，包括 `chi_sim` 简体中文模型。

## 模块职责

| 文件 | 职责 |
| --- | --- |
| `manifest.json` | MV3 权限、service worker、content script 和 CSP。 |
| `background.js` | 全局任务状态机：截图调度、消息转发、任务持久化、错误恢复。 |
| `content.js` | 页面控制器：隐藏固定 UI、定位滚动容器、滚动、恢复页面、复制兜底和预览浮层。 |
| `content.css` | 页面内预览浮层样式。 |
| `offscreen.html`、`offscreen.js` | 隐藏 OCR 容器：初始化 Tesseract Worker、逐屏识别、及时释放截图字符串、累计拼接文本。 |
| `text-stitch.js` | 无浏览器依赖的 OCR 文本拼接算法，同时支持浏览器全局变量和 CommonJS 测试导入。 |
| `popup.html`、`popup.js` | 用户控制面板：启动任务、查询进度、展示结果、复制、预览、导出 TXT。 |
| `vendor/tesseract/` | Tesseract.js、worker、四种 WASM core 包装文件和 `chi_sim.traineddata.gz`。 |
| `tests/` | Jest 单元测试和 Playwright 扩展 E2E。 |

## 工作流

1. Popup 向 service worker 发送 `START_EXTRACTION`。
2. Service worker 要求 content script 执行 `PREPARE_CAPTURE`：隐藏固定 UI，记录原始滚动位置并滚动到顶部。
3. Service worker 通过 `chrome.tabs.captureVisibleTab` 截取当前视口。
4. Offscreen 页面立即对单张截图 OCR，并调用 `text-stitch.js` 与累计文本拼接。
5. 截图字符串处理完成后不再保留，service worker 请求 content script 向下滚动 `78%` 视口高度。
6. 最后一屏完成识别后，service worker 恢复页面 UI 和原始滚动位置，并将结果保存到 `chrome.storage.local`。

任务不能依赖 popup 持续打开。popup 关闭后，service worker 和 offscreen 页面仍要继续执行。

## 拼接算法约束

- 只使用中文字符参与匹配，降低 OCR 空白、换行和标点噪声影响。
- 默认最大重叠长度 `150`，最小重叠长度 `10`，相似度阈值 `0.85`。
- 必须遍历候选接缝并优先选择相似度最高的结果；不能直接选择最长可接受候选，否则容易过度截断。
- 找不到可靠接缝时必须保留两段文本，并插入 `[可能存在断层，需人工校对]`。
- 不允许为了追求连贯而静默丢弃无法确认的文本。

## 性能与安全约束

- 截图必须串行处理。不要在内存中累计保存整章 Base64 图片。
- `background.js` 当前最多处理 `80` 屏，防止滚动容器判断失效后无限循环。
- 提取期间目标微信读书标签页必须保持在当前窗口前台，否则截图结果不可信，应中止任务。
- 无论成功还是失败，都必须执行 `RESTORE_CAPTURE`。
- Popup 和 offscreen 页面禁止内联 JavaScript，遵循 MV3 CSP。
- Tesseract worker、WASM core 和语言包必须从扩展本地路径加载，禁止运行时依赖 CDN。
- 浮层文本写入 `innerHTML` 前必须转义；关闭浮层时必须移除 `Escape` 键监听器。

## 测试要求

安装依赖和 Playwright Chromium：

```bash
npm install
npx playwright install chromium
```

运行全部自动化测试：

```bash
npm run test:all
```

测试分层如下：

- `tests/text-stitch.test.js`：Levenshtein、OCR 容错拼接、断层降级。
- `tests/content.test.js`：UI 隐藏、滚动、恢复、预览转义和复制。
- `tests/background.test.js`：截图调度、OCR 消息流、任务状态和错误拒绝。
- `tests/assets.test.js`：离线 OCR 发布资产完整性。
- `tests/e2e/extension.spec.js`：真实 Playwright Chromium 扩展上下文，验证
  service worker、截图 API、offscreen 页面、滚动到底、恢复页面、popup 展示，
  以及本地中文模型和 WASM core 热启动。

E2E 使用测试页面和模拟 OCR 文本验证稳定的拼接结果，并额外实际加载一次 19MB 中文模型。
它不会对真实章节截图执行完整识别。涉及 OCR 引擎版本、模型、CSP 或真实页面滚动结构的
改动，发布前必须额外在真实微信读书页面跑一次完整章节。

## 文档维护

用户行为变化时更新 `README.md`。架构或测试约束变化时更新 `AGENTS.md`。
`debug_log.md` 保存旧方案排查历史，不代表当前实现。`OCR_REFACTOR_LOG.md` 保存从旧方案
迁移到本地 OCR 架构的执行记录、测试演进和已修复问题。
