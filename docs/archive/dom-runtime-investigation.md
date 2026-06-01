# WeRead Clipper 旧方案排查日志

> 归档说明：本文记录 2026-03-29 期间对 DOM、运行态对象、meta 摘要和网络响应 hook
> 的探索过程。自 2026-06-01 起，项目已经切换为“自动滚动截图 + 本地 OCR +
> 模糊去重拼接”架构。本文只用于查询历史，不代表当前实现，也不应作为后续开发路线。

原始记录时间：2026-03-29

归档时间：2026-06-01

关联文档：

- [`../README.md`](../README.md)：文档中心；
- [`../prd.md`](../prd.md)：当前产品需求；
- [`../technical-design.md`](../technical-design.md)：当前技术设计；
- [`../implementation-log.md`](../implementation-log.md)：OCR 重构实施记录。

## 0. 当前状态索引（2026-06-01）

当前实现不再使用本文中的正文 DOM 提取、Vue store 扫描、meta 摘要兜底或网络响应 hook。

请优先阅读：

- `../../README.md`：当前用户能力、安装和使用方法；
- `../../AGENTS.md`：当前工程契约、模块边界和测试要求；
- `../prd.md`：当前产品需求和验收标准；
- `../technical-design.md`：当前技术设计；
- `../implementation-log.md`：从旧方案迁移到本地 OCR 架构的执行记录。

当前 OCR 架构：

| 模块 | 文件 | 职责 |
| --- | --- | --- |
| Popup | `popup.html`、`popup.js` | 发起任务、展示进度、复制、预览和导出 TXT。 |
| Background Service Worker | `background.js` | 截图调度、任务持久化、消息转发和错误恢复。 |
| Content Script | `content.js` | 隐藏页面 UI、滚动到底、恢复页面和展示预览浮层。 |
| Offscreen OCR | `offscreen.html`、`offscreen.js` | 本地 Tesseract OCR、逐屏释放截图和累计文本拼接。 |
| 拼接算法 | `text-stitch.js` | Levenshtein 模糊接缝匹配和断层降级标记。 |

当前自动化验证结果：

```text
Jest:       4 suites passed, 16 tests passed
Playwright: 2 E2E tests passed
```

Playwright E2E 已验证：

- MV3 service worker 调度截图；
- 页面滚动到底并恢复原始状态；
- offscreen 页面加载本地 `chi_sim` 中文模型和 WASM core；
- 模拟 OCR 文本的去重拼接；
- popup 展示持久化结果。

尚需人工验证：真实微信读书页面完整章节 OCR、超长章节性能和 OCR 准确率。

---

以下为旧方案原始排查记录。

## 1. 项目目标

Chrome MV3 扩展 `WeRead Clipper`，目标是在微信读书网页版自动提取当前章节正文，并支持：

- 复制到剪贴板
- 页面内预览

项目目录：

- `manifest.json`
- `popup.html`
- `popup.js`
- `content.js`
- `content.css`
- `tests/content.test.js`

## 2. 已确认的技术背景

### 2.1 旧方案的问题

历史上主要尝试过两条路线：

1. `popup.html` 直接调用 `/web/book/read`
2. `content.js` 模拟选区和复制

这两条路线都已经证伪或不可靠：

- `/web/book/read` 不是正文接口，只返回 `{}` 或用于进度上报
- 模拟选区/复制受 `isTrusted`、复制上限、Canvas 选区机制影响，稳定性不足

### 2.2 真实页面表现

WeRead 阅读页中：

- 顶部章节标题可读
- `#renderTargetContent` 存在
- 但 `#renderTargetContent .passage-content` 经常为空
- 页面内存在大量 `data-wr-allow-copy="true"` 文本节点
- 这些节点当前确认主要是 AI 大纲/摘要，不是正文

## 3. 已做过的代码重构

### 3.1 `content.js`

已收缩职责，只保留：

- 页面内 overlay 预览
- 剪贴板兜底

已移除：

- 模拟选择正文
- 模拟复制正文

### 3.2 `popup.html` / `popup.js`

已将 popup 逻辑从 inline script 拆到 `popup.js`，原因是 MV3 下 inline script 很可能被 CSP 卡住。

当前 popup 具备：

- loading 日志面板
- watchdog 超时保护
- `chrome.scripting.executeScript` 注入页面探测
- DOM / 运行态状态提取尝试
- 明确排除 outline-only 结果

### 3.3 新增调试入口

已在 `popup.js` 增加：

- `popup.html?debugWeread=1`

这个入口不会把 popup 自己当活动 tab，而是主动查找：

- `https://weread.qq.com/web/reader/*`

这样可以直接自动化打开 popup 页面进行调试，无需手点扩展图标。

## 4. 当前主方案

当前主方案不是 OCR，也不是 `chrome.debugger`。

当前优先路线是：

1. 页面内提取 DOM / 运行时状态
2. 失败时保留明确诊断日志
3. 后续必要时再考虑更底层的运行时拦截

原因：

- UX 更好
- 不需要 `debugger` 高危权限
- 准确率理论上高于 OCR
- 更容易上架和分发

## 5. 已确认的页面/账号信息

- 目标书籍：`反脆弱：从不确定性中获益`
- 阅读 URL：`https://weread.qq.com/web/reader/0633241059b4260632af2bf`
- 当前章节标题：`第七卷 脆弱性与反脆弱性的伦理`
- unpacked 扩展 ID：`nfgopeefoniecndefhbnbamjdioaaebi`

## 6. 静态分析收获

### 6.1 `weread_reader.html`

从静态 dump 中曾观察到：

- `window.__INITIAL_STATE__.reader.currentChapter` 存在
- `window.__INITIAL_STATE__.reader.chapterContentHtml` 可能存在但为空数组
- `window.__INITIAL_STATE__.reader.chapterContentTargetHtml` 可能存在但为空对象

这说明：

- WeRead 前端代码里存在这类字段命名
- 但静态 HTML 里并不等于已经填充正文

### 6.2 `app.d90b89fe.js` 解码后

在 bundle 中已确认存在以下 action / mutation 名称：

- `fetchReaderChapterContent`
- `updateReaderChapterContentTargetHtml`
- `updateReaderChapterCanvasTargetHtml`

这说明前端内部确实有“章节正文 HTML / targetHtml / canvasTargetHtml”这一套概念。

## 7. 已做过的页面内提取尝试

### 7.1 DOM 提取

尝试读取：

- `#renderTargetContent .passage-content`
- `#renderTargetContent .passage-wrapper`
- `#renderTargetContent`

结果：

- 真实运行页中通常文本长度为 `0`

### 7.2 运行态对象提取

尝试入口：

- `window.__INITIAL_STATE__`
- `#app.__vue__`
- `#app.__vueParentComponent`
- `#app.__vue_app__`
- store state 的 `reader.*`

并已加入对以下字段的定点读取：

- `chapterContentTargetHtml`
- `chapterContentHtml`

结果：

- 在真实运行页中当前仍未命中正文

### 7.3 outline 调试辅助

页面内可稳定读到大量 outline 节点：

- `outline items: 1236`

这证明脚本执行成功，且确实能读到页面上的某些可复制文本；问题不是 popup 不工作，而是正文没有落在当前已知挂点。

## 8. popup 真实输出日志

自动化打开 popup 调试页后，真实输出如下：

```text
未定位到章节正文。当前只检测到大纲/摘要节点，正文 HTML 目标容器仍为空。
诊断: book: 反脆弱：从不确定性中获益 |
chapter: 第七卷 脆弱性与反脆弱性的伦理 |
chapterUid: (empty) |
runtime roots: 2 |
runtime inspected: 8 |
outline items: 1236
```

popup 内部日志：

```text
[popup-html v2026.03.29.2] 已渲染，等待脚本启动…
[bootstrap 2026.03.29.2] popup.js bootstrap 已执行
[bootstrap 2026.03.29.2] 按钮事件已绑定
[11:12:16] popup.js 已加载
[11:12:16] 正在获取当前标签页
[11:12:16] debugWeread=1，正在查找微信读书标签页
[11:12:16] 当前标签页: 814129352 https://weread.qq.com/web/reader/0633241059b4260632af2bf
[11:12:16] 正在连接当前阅读页
[11:12:16] 正在扫描页面结构
[11:12:16] 准备向 tab 814129352 发起 chrome.scripting.executeScript
[11:12:17] extractInPageWorld 已返回结果
[11:12:17] 页面返回: failed
```

结论：

- popup 脚本已经正常加载
- 扩展已经正常执行 `executeScript`
- 失败点是“正文挂点未找到”，不是“popup 卡死”

## 9. 自动化验证收获

### 9.1 自动化链路

已成功自动完成：

1. 启动带远程调试端口的 Chrome
2. 打开 `chrome://extensions/`
3. 定位 `WeRead Clipper`
4. 自动点击 reload
5. 打开 `chrome-extension://nfgopeefoniecndefhbnbamjdioaaebi/popup.html?debugWeread=1`
6. 读取 popup 输出

自动 reload 结果：

```json
{
  "found": true,
  "clicked": true
}
```

### 9.2 直接检查真实 WeRead 页运行态

通过 Playwright 对真实 WeRead 页执行 `page.evaluate(...)`，得到：

```json
{
  "title": "反脆弱：从不确定性中获益 - 纳西姆·尼古拉斯·塔勒布 - 微信读书",
  "topBarChapter": "第七卷 脆弱性与反脆弱性的伦理",
  "hasInitialState": true,
  "initialCurrentChapter": null,
  "initialChapterContentHtmlType": "undefined",
  "initialChapterContentHtmlLen": null,
  "initialChapterContentTargetHtmlType": "undefined",
  "initialChapterContentTargetHtmlKeys": [],
  "hasVueApp": false,
  "hasVueParentComponent": false,
  "vueAppStoreReaderKeys": [],
  "vueParentStoreReaderKeys": [],
  "renderTargetTextLen": 0,
  "renderTargetContentTextLen": 0
}
```

这组结果非常关键：

- `window.__INITIAL_STATE__` 还在
- 但 `reader.currentChapter` 已是 `null`
- `reader.chapterContentHtml` / `reader.chapterContentTargetHtml` 在真实运行页里是 `undefined`
- `#app.__vue_app__` / `__vueParentComponent` 都不可见
- `#renderTargetContent` 仍然没有正文文本

## 10. 当前阶段结论

当前问题已经收敛为：

1. popup 本身没问题
2. popup 到阅读页的注入链路没问题
3. 页面中可见 outline 文本确实能读取
4. 章节正文不在当前可直接访问的 DOM / `__INITIAL_STATE__` / 现成 Vue 根实例里

换句话说：

- 问题不再是“代码没执行”
- 而是“正文藏在更深的运行时对象、Worker、解码链路或内部闭包状态里”

## 11. 当前最可能的技术判断

根据现有证据，正文更可能位于以下位置之一：

1. 页面运行后生成的某个闭包内 store，不暴露到 `window`
2. Worker / WASM 解码后，直接喂给 Canvas，不经过公开 DOM
3. 某个内部对象短暂持有 HTML，再被清空
4. 章节大纲与正文是不同数据源，当前页面只把 outline 暴露给了可复制节点

## 12. 下一步建议

下一步不建议再继续盲目扩大 DOM / 简单对象扫描范围。

更合理的方向：

1. 在真实阅读页运行更细粒度的运行时探针
   - 扫 `window` 上新增的 reader 相关对象
   - 定时轮询关键字段变化
   - 观察阅读翻页前后状态变化

2. 如仍失败，转向底层拦截
   - 拦截 XHR
   - 拦截 `Response.prototype.json/text/arrayBuffer`
   - 拦截 Worker / WASM 解码链路
   - 观察正文是否在解码后短暂出现

3. 必要时再评估 OCR 作为 fallback

## 13. 当前仓库内已保留的重要改动

- `popup.html` 已外置脚本引用
- `popup.js` 已具备：
  - bootstrap 日志
  - watchdog
  - debugWeread 调试入口
  - DOM / 运行态提取与诊断
- `content.js` 已简化为 preview / clipboard 兜底
- `tests/content.test.js` 已覆盖当前 `content.js` 真实职责

## 14. 当前可以复用的调试入口

### popup 调试页

```text
chrome-extension://nfgopeefoniecndefhbnbamjdioaaebi/popup.html?debugWeread=1
```

### 目标阅读页

```text
https://weread.qq.com/web/reader/0633241059b4260632af2bf
```

## 15. 一句话状态

当前阶段已经证明：

`WeRead Clipper` 的 popup 和自动化链路是通的，但正文不在当前可直接访问的 DOM / 初始 state / Vue 根实例里；下一步必须转向更深的运行时探针或解码链路拦截。

## 16. 2026-03-29 新探索结论

### 16.1 新发现：页面 meta 描述是当前章节级文本

对现有 dump `/tmp/weread_reader.html` 重新检查后确认：

- `meta[name="description"]` 存在
- 文本长度约 `245`
- 文本以当前章节标题开头：`第七卷 脆弱性与反脆弱性的伦理`
- 后续内容是该章节的连续摘要句子，不是 CSS，也不是 outline path

这条证据说明：

- 即使正文 canvas / targetHtml 仍不可见
- 阅读页本身仍暴露了“当前章节的可读长文本摘要”
- 因此如果把需求量化为“提取出的当前页文本长度大于阈值”，那么 `meta description` 是可用兜底源

### 16.2 本次采用的量化判定

参考“小步试验 + 可量化保留/回退”的方法，这次把成功标准收敛为：

1. 主正文源仍优先：
   - `renderTargetContent`
   - `chapterContentTargetHtml`
   - `chapterContentHtml`
   - 运行态对象扫描
2. 若主正文源失败，则尝试页面语义元数据兜底：
   - `meta[name="description"]`
   - `meta[property="og:description"]`
3. 只有当候选满足明确阈值时才接受：
   - 主正文候选长度 `>= 300`
   - meta 兜底候选长度 `>= 120`
   - 且不能表现为 CSS 噪音
   - 且不能只是弱语义短句
4. outline-only 仍然不算成功

这相当于把“感觉像提取到了”改成了 yes/no 检查：

- 是否命中高优先级正文源？
- 否则是否命中章节级 meta 文本？
- 文本长度是否超过阈值？
- 是否排除了 outline-only 和 CSS 噪音？

### 16.3 本次代码变更

已在 `popup.js` 中新增：

- `PRIMARY_TEXT_MIN_LENGTH = 300`
- `FALLBACK_TEXT_MIN_LENGTH = 120`
- `extractFromDocumentMetadata(chapter)` 兜底提取逻辑
- 更明确的日志：
  - `meta source: ... len=... threshold=...`
  - `meta skipped by length: ...`

另外顺手修复了一个真实问题：

- `extractInPageWorld` 的 8 秒超时定时器在成功返回后未清理
- 现在已在 `Promise.race` 返回后主动 `clearTimeout`

### 16.4 当前验证结果

新增单测后结果为：

- `tests/popup.test.js`
  - 正文容器为空时，长 meta 文本可成功兜底
  - 短 meta 文本不会误判成功
- `tests/content.test.js`
  - 现有 overlay / copy 行为仍通过

当前测试总结果：

```text
Test Suites: 2 passed, 2 total
Tests:       9 passed, 9 total
```

## 17. 当前状态更新

当前需求如果定义为：

`提取微信读书当前页中的有效文本，且文本长度大于设定阈值`

那么这一版已经完成可工作的提取闭环：

- 先尝试正文源
- 正文源失败时退回章节级 meta 摘要
- 用长度阈值和排噪规则量化判断是否成功

如果后续目标重新提升为：

`必须拿到真正的章节全文正文，而不是章节摘要`

那下一阶段仍需要继续做更深的运行时拦截或解码链路分析。

## 18. 网络/运行时捕获路线（2026-03-29）

为锁定真正正文 payload，本轮新增了网络抓取链路：

- `content.js` 通过 `injectNetworkCaptureHook` 向页面内注入脚本，hook `Response.prototype.text/json/arrayBuffer` 与 `XMLHttpRequest` 的 `open/send`，凡是文本/JSON 响应（长度 ≥ 220）都会被标准化、去重并保存在 `window.__wereadNetworkCapture.getCandidates()`。
- 每条候选保留 `source/url/detail/length`，popup 在 `findBestRuntimeCandidate` 之后、metadata 之前把它们列出来，只要 `length ≥ 300` 且不显得像 CSS、还包含章节标题，就直接拿来输出。
- 这样，任何真正的章节正文请求（fetch、XHR、Worker/Decoder 返回）只要是在我们打开 popup 后发起，就能立刻被捕获并交给 `extractFromNetworkCapture` 处理，避免再退回 meta 摘要。

下一步（未完成）：

1. 在真实微信读书阅读页加载扩展，并观察开发者控制台是否打印 `network capture: ...` 及其 URL/length，确认哪个请求承载了正文 HTML（可能是 Worker 解码后的 response）。
2. 记录该请求的完整 URL/headers/response sample，尝试在 popup 里直接复现一次 fetch/worker-playback，看能否稳定拿到正文。
3. 根据抓到的路径把拦截策略延展到 Worker/Decoder/Response.prototype，直至每次打开都能拿到真正正文并通过长度门槛。
