# M6 第四包：语义模型删除影响与保护

日期：2026-09-21。本包范围固定为模型删除导致已保存 Notebook 引用失效的问题，及已删除模型的旧草稿重新采用保护。源码、聚焦 / 全量回归、类型 / 构建及 3001 主流程 4 组 / 7 图已通过；旧草稿分支只有自动化验证，截图缺口见下文。3000 未发布，整个 M6 未完成。

## 依据、范围与实际文件

原 `core/semantic/model.ts` 的 `deleteSemanticModel` 仅验证角色和模型存在，随后直接移除模型与选择；`workspace/semantics.ts` 的确认也没有展示 Notebook 影响。Notebook 保存 `semanticQuery.modelId / modelVersion`，原 `LocalProjectStore.saveState` 只检查 Dataset 引用，因此留下失效模型引用仍能保存，到下次执行才报错。

| 文件 | 本次职责 |
| --- | --- |
| `core/semantic/model-references.ts`（新增） | 纯分析全部 Notebook 显式 `modelId` 引用；返回稳定页面 / 单元 ID 和名称，不截断判断、不依赖 React / SDK / 文件系统 |
| `core/semantic/model.ts` | 保留权限与存在检查，引用存在则拒绝删除；仅诊断展示前三处与余数 |
| `components/studio/workspace/semantics.ts` | 确认前和确认后从最新状态复查；保留取消、权限、保存及状态所有权 |
| `SemanticModelDeletionImpact.tsx`（新增，位于 `components/studio/`）、`SemanticModelManager.tsx`、`StudioWorkspace.tsx` | 当前 Notebook 层传入管理弹窗；先展示影响、禁用带引用删除，无引用沿用原确认 |
| `app/semantic-models.css` | 五条局部浅色样式，长标题换行和列表内部滚动，不改全局色板 |
| `core/projects/server/store.ts` | 保存版本校验后复查本次移除的模型；候选仍有引用返回 409、清单不写；同时明确移除引用与模型允许 |
| `core/notebook/client-state.ts`、`components/studio/notebook/NotebookPanel.tsx` | 旧草稿缺模型时展示阻断、采用回调再检查；不以旧成功回执推断当前模型存在 |

新增引用、API 保存、展示和草稿测试，并扩充原模型 / 控制器测试；没有删除或移动源码、增加依赖、修改存储格式 / 路由 / 工具或自动删除下游。Agent / Harness 无新能力；语义模块拥有引用规则，Project 使用该纯接口复查，UI 不导入服务端存储。后续更换存储须保留候选定义的引用验证与版本冲突边界。

## 工作记录与验证

- 开工基线：`npm test -- --run core/semantic/model.test.ts components/studio/workspace/semantics.test.ts core/projects/server/store.test.ts app/api/projects/route.test.ts --maxWorkers=2`，4 文件 / 45 应用 + 14 Node 通过。
- 红灯：核心删除 5 项在原实现未抛错；API 新测试 2 项直接保存返回 200、预期 409。修复后均通过，没有删除或弱化断言。
- 聚焦：`npx vitest run core/semantic/model.test.ts core/semantic/model-references.test.ts core/notebook/semantic-adoption.test.ts components/studio/SemanticModelDeletionImpact.test.tsx components/studio/notebook/NotebookSemanticAdoption.test.tsx components/studio/workspace/semantics.test.ts app/api/projects/semantic-deletion.test.ts core/projects/server/store.test.ts app/api/projects/route.test.ts --maxWorkers=2`：9 文件 / 78 项通过。
- `npm run typecheck` 通过；本包 16 个 TS / TSX 定向 `npx eslint ... --max-warnings 0` 通过。
- `npm test -- --maxWorkers=2` 退出 0：212 文件 / 2,285 项应用通过，既有 1 文件 / 3 项跳过；14 项 Node 通过，离线 Harness 11/11。本包新增 33 项，不将旧跳过记为通过。
- `npm run build` 退出 0，保留既有大 chunk 警告，未发布；验收脚本的 `node --check` 与严格 ESLint 通过。
- 架构正文及变更记录更新后，`npm run docs:agent:sync` / `npm run docs:agent:check` 为 153 文件一致，`npm run docs:agent:test` 1 项通过。
- `npx vitest run core/architecture/module-boundaries.test.ts --maxWorkers=2`：27 项通过，无新增运行时循环、前端到服务端 import 或领域到 UI 的依赖。`git diff --check` 检查本批已跟踪差异通过。
- 独立只读复核未发现本包阻断问题，另实际执行架构、控制器、采用与 API 共 44 项通过；保留其发现的“删除差量保护不是全局孤儿校验”和“未来采用入口需显式调用 preflight”边界。全仓 lint 本轮未重跑，上一包生成物 / 旧 worker 的基线问题未处理，不冒称已修复。

## 3001 浏览器证据

执行 `node scripts/verify-semantic-model-deletion.mjs --reuse-failed-project .runtime/hex-notebook-capability-toggle-2026-09-20/browser-1789916685499/project`。本机已有 100 条登记，未删除登记或调高上限；核验原失败合成项目归属与固定数据、备份清单后，每轮只添加独立资源。

[最终报告](../../.runtime/hex-semantic-model-deletion-2026-09-21/browser-1789969740460/report.json)的 4 组 / 7 张真实截图通过并全部实际查看，主代理另复看 02 / 03 / 05 / 07。

| 场景 | 本次证据与结果 |
| --- | --- |
| 实际分析与删除阻断 | [实际语义计算](../../.runtime/hex-semantic-model-deletion-2026-09-21/browser-1789969740460/01-real-semantic-query-1440.png)：Data → semanticQuery → table 得 East=150 / South=80；[引用影响](../../.runtime/hex-semantic-model-deletion-2026-09-21/browser-1789969740460/02-referenced-model-blocked-1440.png)列 Notebook / Cell 名和 ID、删除禁用 |
| 服务端拒绝 | 独立 API 实际保存请求返回 409，版本 36 → 36、清单全部字节不变；[1024 界面](../../.runtime/hex-semantic-model-deletion-2026-09-21/browser-1789969740460/03-model-retained-after-real-api-409-1024.png)是仍保留模型的正常引用阻断，不是伪造错误弹窗 |
| 明确解除引用、取消和删除 | Notebook 原有[依赖删除提示](../../.runtime/hex-semantic-model-deletion-2026-09-21/browser-1789969740460/04-notebook-dependency-delete-confirmation-1440.png)先“保留”取消，再明确确认删除本轮语义单元及一个下游表格；模型原生确认先 dismiss，[取消后定义保持](../../.runtime/hex-semantic-model-deletion-2026-09-21/browser-1789969740460/05-unreferenced-model-delete-cancelled-1440.png)，再 accept，[删除后原数据保留](../../.runtime/hex-semantic-model-deletion-2026-09-21/browser-1789969740460/06-model-deleted-source-retained-1024.png) |
| 关闭标签页后重开 | [重开后的看板](../../.runtime/hex-semantic-model-deletion-2026-09-21/browser-1789969740460/07-reopened-dashboard-and-data-retained-1024.png)显示原表指标 230；模型 / 选择仍已删除，剩余 Data Cell、原表、原件及已有看板 / 历史不变，没有自动运行 Notebook |

导入、新界面及删除交互来自实际 UI；模型、Notebook 和一个直绑原表的 MetricCard 用声明的合成定义通过真实 scoped save 创建，不把夹具设置称为模型创建 UI 验收。目录和无句柄最近项目 GET 使用明确空列表隐藏其他记录；保存、导入、计算、读取及重开不使用响应替身。409 来自独立 APIRequest，不是页面请求；控制台 / 页面 / 路由错误、违规请求均为 0。没有真实模型、远端数据库或服务重启。

首轮打开项目后读取已被 Chromium 丢弃的响应正文而失败，尚未添加本轮资源；[失败报告](../../.runtime/hex-semantic-model-deletion-2026-09-21/browser-1789969717203/report.json)和实际查看的 failure.png 保留并列入 `attemptHistory`。只修正脚本为断言 open 状态、再通过 scoped GET 获取响应，未改产品迎合脚本。首轮未执行到最终资源比对（其 preserved 标记为 false，并非已证明数据丢失）；主代理另对两轮 prior-manifest.json 执行 SHA-256 核对，完全一致，最终轮完成旧文件与定义校验。

最终原 8 表 / 6 原件 / 6 Notebook / 0 模型及旧页面的元数据、ID、文件摘要与定义保留。本轮仅新增 1 界面 / 1 表 / 1 原件，随后经明确 UI 确认删除自己创建的模型及两个 Cell，留下 Data 单元；不删除原数据或用户资源。模型 / Cell 无独立回收站，本轮合成定义可从验收保存的状态证据查看。

旧草稿引用已删除模型的分支有纯函数 4 项和 NotebookPanel SSR 2 项，本轮**未做该分支的实际浏览器截图**。未来新增采用入口须调用 `notebookSemanticModelIssue`，不能仅调用不拥有模型列表的 `adoptNotebookDraft`；不把 SSR 当作点击 / 截图验证。

## 保留边界

- 模型删除不是永久删除表格，不新建模型回收站或自动级联；仍需用户明确移除 / 更换 Notebook 引用。原件文件名引用、通用 Cell 删除影响和完整看板快照闭环不在本包。
- 只统计已存在产品 Notebook 定义的显式引用，不扫 SQL / Python 文本，不把模型选择、已生成看板 / 结果快照、所有历史 Agent 产物都视作活依赖。
- 服务端守卫只针对本次删除的原有模型。已有孤儿定义可保留和无关保存；不假装全量修复任意坏项目。模型同 ID 修订或成员变化仍可能需要调整单元版本，原执行检查保留，本包不处理自动迁移。
- 旧草稿缺模型的客户端采用保护不新增服务端全局 Schema 校验；自行构造全新孤儿引用仍沿用原执行拒绝路径。浏览器草稿分支未验收时需明确标记，不能以 SSR 代替实际截图。
- 仅本机 3001、合成数据和无费用模型替身 / 纯测试；无生产系统、真实模型、外部数据库或稳定站发布。保留已有未提交内容，不提交 / 推送 / 切换 / 合并 / 清理用户文件。

工作区分支仍为 `feature/eds-analysis-dashboard`，HEAD 未变；源码由 3001 热更新承载，没有提交或发布。前后 `npm run site:status` 的 stable / dev / capture 均健康，PID、运行修订和重启次数一致；3000 仍保持既有发布版本。本包没有运行开关，不表示所有 M6 / M7 或全仓 lint 已完成。
