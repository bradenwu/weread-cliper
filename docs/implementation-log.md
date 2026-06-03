# WeRead Clipper OCR 重构执行记录

更新时间：2026-06-01

关联文档：

- [`README.md`](README.md)：文档中心；
- [`prd.md`](prd.md)：产品需求；
- [`technical-design.md`](technical-design.md)：当前技术设计；
- [`archive/dom-runtime-investigation.md`](archive/dom-runtime-investigation.md)：旧方案归档。

## 1. 文档用途

本文记录 WeRead Clipper 从“DOM、运行态对象和网络响应探测”迁移到“自动滚动截图 +
本地 OCR + 模糊去重拼接”方案的完整实施过程，方便后续查询设计依据、测试方法和已解决问题。

旧方案的实验历史保留在 `archive/dom-runtime-investigation.md`。当前工程契约以根目录
`AGENTS.md` 为准。

## 2. 重构背景

微信读书 Web 版正文可能使用 Canvas 或高度混淆结构渲染。旧实现尝试过：

- 从 `#renderTargetContent` 提取 DOM 文本；
- 扫描 `window.__INITIAL_STATE__` 和 Vue store；
- hook `Response.text()`、`Response.json()`、XHR 等网络响应；
- 在正文不可见时退回 `meta[name="description"]` 章节摘要。

这些路径无法稳定保证拿到完整章节正文。因此本轮根据新 PRD 改为视觉截屏方案：

1. 自动隐藏固定 UI；
2. 从章节顶部开始逐屏截图；
3. 在扩展本地执行中文 OCR；
4. 逐屏释放图片内存；
5. 使用模糊匹配消除截图重叠文本；
6. 输出完整文本供复制、预览和 TXT 导出。

## 3. 架构决策

### 3.1 为什么不能把任务放在 Popup 中

Chrome popup 在用户点击页面后可能随时关闭。如果 OCR 和滚动循环依赖 popup，任务会中断。

最终拆分为：

| 模块 | 文件 | 职责 |
| --- | --- | --- |
| Popup | `popup.html`、`popup.js` | 启动任务、轮询进度、展示结果、复制、预览、导出。 |
| Background Service Worker | `background.js` | 任务状态机、截图调度、消息转发、错误恢复。 |
| Content Script | `content.js` | 隐藏 UI、定位滚动容器、滚动、触底判断、恢复页面。 |
| Offscreen OCR | `offscreen.html`、`offscreen.js` | 持有 Tesseract Worker，串行 OCR 和文本拼接。 |
| 拼接算法 | `text-stitch.js` | 清洗文本、Levenshtein 相似度、接缝消除、断层降级。 |

任务状态通过 `chrome.storage.local` 保存。即使 popup 关闭，再次打开时仍可恢复进度和结果。

### 3.2 为什么使用 Offscreen Document

Manifest V3 service worker 没有 DOM，也不适合长期持有 OCR Worker。Offscreen Document 提供
隐藏扩展页面，可在不展示 UI 的情况下加载 Tesseract.js、WASM core 和中文模型。

### 3.3 为什么内置 OCR 资产

PRD 要求核心抓取和识别阶段支持离线运行。本轮将以下资产复制到 `vendor/tesseract/`：

- `tesseract.min.js`
- `worker.min.js`
- 四种 `tesseract-core*.wasm.js`
- `chi_sim.traineddata.gz`

总大小约 `36MB`，其中简体中文模型约 `19MB`。运行时路径使用 `chrome.runtime.getURL()`，
不依赖 CDN。

## 4. 实施步骤

### 4.1 依赖与 Manifest

执行：

```bash
npm install tesseract.js@^6.0.1 --save
npm install --save-dev @playwright/test@^1.52.0
npx playwright install chromium
```

`manifest.json` 升级为 `2.0.0`，新增：

- `background.service_worker`
- `offscreen`
- `downloads`
- `storage`
- `content_security_policy.extension_pages`

CSP 使用：

```text
script-src 'self' 'wasm-unsafe-eval'; object-src 'self'
```

### 4.2 Background 截图循环

`background.js` 的核心步骤：

1. 查询当前活动微信读书标签页；
2. 发送 `PREPARE_CAPTURE`；
3. 创建 offscreen OCR 会话；
4. 调用 `chrome.tabs.captureVisibleTab` 截取当前视口；
5. 将单张 Base64 图片发送到 offscreen 页面 OCR；
6. OCR 完成后不再保存该截图；
7. 发送 `SCROLL_NEXT`，按视口高度的 `78%` 向下滚动；
8. 最后一屏完成识别后退出循环；
9. 无论成功或失败，都发送 `RESTORE_CAPTURE`。

安全限制：

- 最多处理 `80` 屏，避免触底判断失效时无限循环；
- 每次截图前检查目标标签页及其 Chrome 窗口仍在前台；
- 任务状态持续写入 `chrome.storage.local`。

### 4.3 Content Script 页面控制

`content.js` 负责：

- 识别书名和章节名；
- 搜索实际滚动容器；
- 隐藏已知工具栏，以及尺寸较小的 `fixed` 或 `sticky` 浮层；
- 保存原始滚动位置；
- 滚动到顶部并逐屏下移；
- 触底后恢复被隐藏元素和原始滚动位置；
- 保留复制兜底和页面内 OCR 文本预览。

### 4.4 OCR 与内存回收

`offscreen.js` 通过 Tesseract.js 初始化：

```javascript
Tesseract.createWorker('chi_sim', 1, {
  workerPath: chrome.runtime.getURL('vendor/tesseract/worker.min.js'),
  corePath: chrome.runtime.getURL('vendor/tesseract/core'),
  langPath: chrome.runtime.getURL('vendor/tesseract/lang'),
  workerBlobURL: false,
  gzip: true,
});
```

每次只识别一张图片。OCR 完成后仅保留累计文本，不将截图加入数组，满足长章节内存可控要求。

### 4.5 模糊去重拼接

`text-stitch.js` 的默认配置：

```javascript
{
  maxOverlap: 150,
  minOverlap: 10,
  similarityThreshold: 0.85,
  gapMarker: '\n\n[可能存在断层，需人工校对]\n\n',
}
```

算法步骤：

1. 对前一段尾部和后一段头部只保留中文字符；
2. 遍历长度为 `10` 到 `150` 的候选重叠区域；
3. 计算 Levenshtein 编辑距离和相似度；
4. 在达标候选中优先选择相似度最高者，长度仅作为次级条件；
5. 删除下一屏重复区域并拼接剩余文本；
6. 找不到可靠接缝时保留两段文本，并插入人工校对标识。

## 5. 自动化测试建设

### 5.1 Jest 单元测试

运行：

```bash
npm test -- --runInBand
```

覆盖范围：

| 文件 | 覆盖内容 |
| --- | --- |
| `tests/text-stitch.test.js` | Levenshtein 距离、相似度、OCR 错字容忍、重叠去除、断层降级、空白清理。 |
| `tests/content.test.js` | 预览 HTML 转义、复制、关闭浮层、隐藏固定 UI、滚动和恢复原位置。 |
| `tests/background.test.js` | 截图调度、OCR 消息序列、任务完成状态、非微信读书页面拒绝启动。 |
| `tests/assets.test.js` | 本地 Tesseract 脚本、worker、WASM core 和中文模型是否完整打包。 |

最终结果：

```text
Test Suites: 4 passed, 4 total
Tests:       16 passed, 16 total
```

### 5.2 Playwright Chrome 扩展 E2E

运行：

```bash
npm run test:e2e
```

E2E 使用 Playwright Chromium 加载临时未打包扩展。测试 manifest 仅在临时目录增加：

- `version_name: "e2e"`
- `http://127.0.0.1/*`
- `<all_urls>`

这些改动用于本地 fixture 页面和自动化截图权限，不会进入生产 `manifest.json`。

E2E 覆盖两个场景：

1. **完整调度链路**
   - 打开本地模拟阅读页；
   - 从扩展 popup 页面触发 `START_EXTRACTION`；
   - 真实执行 `captureVisibleTab`；
   - 使用模拟 OCR 文本稳定验证拼接结果；
   - 验证滚动到底、页面恢复、任务持久化和 popup 展示。

2. **本地 OCR 热启动**
   - 创建 offscreen 页面；
   - 实际加载 `chi_sim` 模型和 WASM core；
   - 验证 MV3 CSP 下无需 CDN 即可初始化 OCR Worker；
   - 终止 Worker，释放资源。

最终结果：

```text
2 passed
```

### 5.3 总回归

运行：

```bash
npm run test:all
```

最终通过：

```text
Jest:       4 suites passed, 16 tests passed
Playwright: 2 E2E tests passed
```

同时通过：

```text
git diff --check
node --check background.js
node --check content.js
node --check offscreen.js
node --check popup.js
node --check text-stitch.js
node --check tests/e2e/extension.spec.js
```

## 6. 测试过程中发现并修复的问题

### 6.1 Playwright 使用系统 Chrome 无法侧载扩展

现象：

```text
beforeAll hook timeout
context.waitForEvent('serviceworker')
```

原因：Playwright 官方文档指出，Google Chrome 和 Edge 已移除测试所需的侧载扩展命令行
参数。扩展测试应使用 Playwright 随附的 Chromium。

修复：

```javascript
chromium.launchPersistentContext('', {
  channel: 'chromium',
  args: [
    `--disable-extensions-except=${tempExtension}`,
    `--load-extension=${tempExtension}`,
  ],
});
```

### 6.2 临时测试扩展漏复制图标

现象：使用 Chromium 后仍无法观察到 service worker。

原因：E2E 创建临时扩展时漏复制 `icons/`，但 manifest 引用了图标文件，导致扩展加载失败。

修复：将 `icons/` 一并复制到临时扩展目录。

### 6.3 自动化环境没有 `activeTab` 临时授权

现象：

```text
Either the '<all_urls>' or 'activeTab' permission is required.
```

原因：生产环境由用户点击工具栏 popup 获得 `activeTab` 临时授权；E2E 通过脚本触发任务，
没有真实点击授权。

修复：仅在临时 E2E manifest 中增加 `<all_urls>`。生产扩展仍使用更小权限范围。

### 6.4 底部最后一屏漏抓

现象：E2E 期望识别两屏，实际只处理一屏。

原因：滚动到页面底部后立即退出循环，没有截图底部视口。

修复：滚动后只记录 `hitBottom`，下一轮先截图和 OCR，完成最后一屏后再退出。
短章节在 `PREPARE_CAPTURE` 阶段返回 `atBottom: true`，避免重复截图。

### 6.5 模糊匹配过度截断下一屏首字

现象：

```text
预期：第二屏正文结束
实际：二屏正文结束
```

原因：算法从最长重叠长度开始扫描，并在第一个达到阈值的候选处立即返回。一个略长但不精确的
候选会吞掉下一屏开头的“第”字。

修复：

- 遍历全部候选接缝；
- 优先选择相似度最高的候选；
- 相似度相同时才优先更长重叠；
- 截断后跳过重叠区域末尾残留标点。

### 6.6 生产测试旁路隔离

E2E 使用模拟 OCR 文本，避免每次完整识别截图造成测试波动。为避免生产扩展保留可直接启用
的旁路，`background.js` 仅在临时测试 manifest 包含 `version_name: "e2e"` 时接受
`testMode` 和 `testOcrTexts`。

## 7. 当前边界与后续验证

自动化测试已经验证：

- MV3 service worker 可以调度截图；
- content script 可以隐藏、滚动和恢复页面；
- offscreen 页面可以在 CSP 下加载本地 Tesseract Worker、中文模型和 WASM core；
- 模糊拼接可以处理截图重叠和少量 OCR 错字；
- popup 可以展示持久化结果；
- 发布资产完整。

自动化尚未覆盖：

- 真实微信读书页面完整章节 OCR；
- 不同书籍排版、图片章节、代码块、脚注等复杂页面；
- 超长 `50+` 屏章节的真实性能和浏览器内存峰值；
- OCR 准确率统计和人工校对成本。

发布前仍需在真实微信读书章节执行一次完整验收，并记录：

1. 总屏数；
2. 总耗时；
3. OCR 文本长度；
4. 人工校对接缝数量；
5. 浏览器内存峰值；
6. 是否正确恢复滚动位置和页面 UI。

## 8. 常用命令

```bash
npm install
npx playwright install chromium
npm test -- --runInBand
npm run test:e2e
npm run test:all
```

## 9. 依赖审计备注

安装依赖时 npm 报告：

```text
2 vulnerabilities (1 low, 1 moderate)
```

本轮未自动执行 `npm audit fix`，因为它可能引入依赖升级风险。后续应单独评估。

## 10. PR #1 Review 修复

根据 PR #1 的 review comment，补充了三类异常路径：

1. 新 service worker 读取到遗留 `running` 状态时，尝试向原标签页发送
   `RESTORE_CAPTURE`，重置 OCR 会话，并将任务标记为失败，避免永久阻塞重新提取。
2. 将 `PREPARE_CAPTURE`、任务信息持久化和 `OCR_START` 纳入同一个 `try/finally`，
   保证 OCR 会话初始化失败时仍恢复页面。
3. 每次截图前同时检查目标标签页和原 Chrome 窗口是否位于前台，避免其他窗口抢占焦点后
   截取错误内容。

新增 `tests/background.test.js` 回归用例，覆盖中断任务恢复、OCR 初始化失败清理和窗口失焦
中止截图。

验证结果：

```text
Jest:       4 suites passed, 19 tests passed
Playwright: 2 E2E tests passed
```

## 11. 点击提取无响应修复

时间：2026-06-03 23:39 CST

现象：在已打开的微信读书章节页点击 popup 的“开始提取当前章节”后，界面仍显示
“等待开始提取”，看起来没有任何响应。

根因：

1. 扩展重新加载后，当前已打开的微信读书标签页没有可用的新版 content script。
2. 后台向页面发送 `PREPARE_CAPTURE` 时收到
   `Could not establish connection. Receiving end does not exist.`。
3. popup 曾把该失败状态当作瞬时连接错误展示为 idle，掩盖了真实错误。

修复：

- `background.js` 在页面没有接收端时，自动注入 `content.css` 和 `content.js` 后重试页面消息；
- `manifest.json` 增加 `scripting` 权限，用于 MV3 程序化注入；
- `content.js` 使用当前注入 token 过滤旧监听器，避免重复注入后多个监听器同时滚动页面；
- `popup.js` 只忽略查询任务状态时 service worker 启动瞬间的连接失败，不再隐藏已持久化的任务失败。

新增回归测试：

- content script 缺失时自动注入并重试；
- 重复注入后只有最新 content script 监听器响应；
- popup 展示已保存的页面连接失败，不伪装成等待状态。

验证结果：

```text
Jest:       5 suites passed, 23 tests passed
Playwright: 2 E2E tests passed
```
