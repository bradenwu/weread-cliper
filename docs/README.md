# WeRead Clipper 文档中心

本文档目录集中保存产品、设计、实施和历史资料。根目录 `README.md` 只保留安装、使用和
开发入口；根目录 `AGENTS.md` 只保留编码代理需要遵守的工程约束。

## 当前文档

| 文档 | 用途 | 维护时机 |
| --- | --- | --- |
| [`prd.md`](prd.md) | 产品目标、用户场景、功能需求、非功能约束和验收标准。 | 产品范围或用户体验发生变化时。 |
| [`technical-design.md`](technical-design.md) | MV3 架构、消息协议、截图流程、OCR 方案、拼接算法和测试策略。 | 模块边界、实现策略或接口发生变化时。 |
| [`implementation-log.md`](implementation-log.md) | 2026-06-01 OCR 重构的执行步骤、测试演进、踩坑和修复。 | 完成重要实施、排障或验证后。 |
| [`archive/dom-runtime-investigation.md`](archive/dom-runtime-investigation.md) | 2026-03-29 DOM、运行态、meta 摘要和网络 hook 旧方案排查记录。 | 仅追加历史证据，不再作为当前方案维护。 |

## 阅读顺序

1. 需要了解产品目标：阅读 [`prd.md`](prd.md)。
2. 需要修改实现：阅读 [`technical-design.md`](technical-design.md) 和根目录
   [`AGENTS.md`](../AGENTS.md)。
3. 需要了解 OCR 重构过程：阅读 [`implementation-log.md`](implementation-log.md)。
4. 需要查询旧方案为何放弃：阅读
   [`archive/dom-runtime-investigation.md`](archive/dom-runtime-investigation.md)。

## 当前状态

- 当前版本：`2.0.0`
- 当前路径：自动滚动截图 + 本地 OCR + 模糊去重拼接
- 离线资产：内置 Tesseract.js、WASM core 和 `chi_sim` 简体中文模型
- 自动化验证：

```text
Jest:       4 suites passed, 19 tests passed
Playwright: 2 E2E tests passed
```

真实微信读书完整章节 OCR、超长章节性能和 OCR 准确率仍需要发布前人工验收。
