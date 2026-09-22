# M6 第六包：Notebook 单元删除影响审阅

日期：2026-09-21。状态：限定范围源码、自动化与 3001 实际流程已完成；不是整个 M6 完成。3000 未发布。

## 冻结范围与依据

原 `NotebookPanel` 只用 `deleteId` 展示下游数量，每次渲染重新计算待删除集合，没有待确认基线；打开提示后编辑文档会改变确认范围，且原确认按钮没有检查正在编辑的状态。

本包保留既有人工确认后级联删除显式下游的行为，改为具体影响清单和过期拒绝，不实现新回收站或通用删除框架，不扩展为整个 M6 / M7。其他会话追加的 DeepSeek Harness 可行性记录保留，不将其研究结论视为迁移授权。

## 实际模块与接口

- `core/notebook/cell-deletion.ts`：纯领域接口 `prepareNotebookCellDeletion` / `isNotebookCellDeletionStale` / `confirmNotebookCellDeletion`。按当前 Notebook 显式依赖构造目标、直接 / 间接下游与保留数量；完整 JSON 基线识别同版本替换；确认重新计算闭包，剩余定义必须通过原校验。
- `components/studio/notebook/NotebookCellDeletionReview.tsx`：只负责标题 / 类型 / ID / 输出变量列表和取消 / 确认 / 过期提示，沿用原按钮文字；不修改业务状态。
- `NotebookPanel.tsx`：本窗口审阅生命周期与确认 guard，审阅期间暂停自动重算，目标消失仍呈现可关闭的过期审阅；成功删除只移除相关内存结果，保留其他结果与步骤，取消自动执行队列。
- `app/notebook-cells.css`：局部暖灰影响区、滚动清单与可换行按钮，不改全站色板或手机适配。

无新第三方依赖、数据库 / 模型调用、工具名称、API 或持久化字段。项目保存仍由原队列及服务端版本检查负责；删除步骤不等于清除原数据、模型或已保存结果。步骤没有回收站，不宣传自动撤销。

## 验证记录

修改前：`npm test -- --run core/notebook/graph.test.ts components/studio/notebook/output-rename-review.test.ts components/studio/notebook/NotebookCapabilities.test.tsx core/notebook/result-cache.test.ts --maxWorkers=2`：4 文件 / 56 项应用 + 14 项 Node 通过。

- 新增纯领域 21 项和审阅 SSR 7 项，共 28 项；覆盖直接 / 传递 / diamond / 文本依赖、显示顺序与同名身份、独立 / 全部删除、完整文档同 revision 变化、展示条目篡改不改计算范围、无效分支删除修复 / 剩余图仍需有效、人工删除关闭态 Python、不可变性、UI 名称 / ID / 保留范围、过期禁用与转义。
- 最终聚焦 `npm test -- --run core/notebook/cell-deletion.test.ts components/studio/notebook/NotebookCellDeletionReview.test.tsx components/studio/notebook/NotebookCapabilities.test.tsx components/studio/notebook/NotebookAutoRun.test.tsx core/notebook/graph.test.ts components/studio/notebook/output-rename-review.test.ts core/notebook/result-cache.test.ts --maxWorkers=2`：7 文件 / 90 项应用 + 14 项 Node 通过。
- `npm test -- --maxWorkers=2`：217 文件 / 2,334 项应用通过，既有 1 文件 / 3 项跳过；14 项 Node 通过，离线 Harness 11/11。不等于真实模型或实库验收。
- `npm run typecheck`、6 个本批 TS / TSX 的严格 ESLint 通过；浏览器脚本 `node --check` / 严格 ESLint 通过。`npm run build` 通过，保留既有大 chunk 和构建插件耗时提示。
- `core/architecture/module-boundaries.test.ts` 27 项通过，`docs:agent:test` 1 项通过；架构正文和变更记录同步后 `docs:agent:sync` / `docs:agent:check` 为 155 文件一致。未重跑全仓 lint，不声称已修复此前生成物 / worker 基线问题。
- 首轮聚焦有 1 项旧能力 UI 断言因新 `data-delete-cell-id` 焦点定位属性失配；更新精确 HTML 预期并仍严格断言 Python 关闭时人工删除未 disabled，复测通过，未弱化行为断言。独立只读复核另跑 4 文件 / 52 项通过，发现编辑中关闭审阅会尝试 focus 禁用按钮；已改为优先可用按钮，否则返回可聚焦的 Notebook 容器。

## 3001 验收

命令：`node scripts/verify-cell-deletion-impact.mjs --reuse-failed-project .runtime/hex-notebook-capability-toggle-2026-09-20/browser-1789916685499/project`。

[最终报告](../../.runtime/hex-cell-deletion-impact-2026-09-21/browser-1789972490814/report.json)：6 组 / 9 图通过，控制台 / 页面 / 路由 / 违规请求错误为 0。真实本地 SQL 运行两次：首次六个 Cell 成功，总额 SQL / 表 / 图 / 文本为 230、独立地区汇总 East=150 / South=80；删除后独立 Data → SQL 再次得到相同地区汇总。

| 页面 / 场景 | 本次截图 | 结论 |
| --- | --- | --- |
| Notebook / 原完整分析链 | [01 · 1440](../../.runtime/hex-cell-deletion-impact-2026-09-21/browser-1789972490814/01-real-table-chart-text-baseline-1440.png) | 六步真实执行成功；运行回执另核验表、图、文本和独立 SQL，不把单张截图当作展示全部六步 |
| Notebook / 删除影响清单 | [02 · 1440](../../.runtime/hex-cell-deletion-impact-2026-09-21/browser-1789972490814/02-four-cell-review-1440.png) | SQL、表、图、文本四项名称 / 类型 / ID 可见，上游和独立 SQL 不在清单 |
| Notebook / 保留取消 | [03 · 1440](../../.runtime/hex-cell-deletion-impact-2026-09-21/browser-1789972490814/03-keep-cancels-without-write-1440.png) | 无保存请求、无清单或步骤变化 |
| Notebook / 编辑后过期拒绝 | [04 · 1024](../../.runtime/hex-cell-deletion-impact-2026-09-21/browser-1789972490814/04-stale-review-disabled-1024.png) | UI 修改上游标题后版本 51→52，旧删除确认禁用，六步保留 |
| Notebook / 关闭后重新审阅 | [05 · 1024](../../.runtime/hex-cell-deletion-impact-2026-09-21/browser-1789972490814/05-fresh-review-ready-1024.png) | 新基线再次列出四项，允许明确确认 |
| Notebook / 确认删除 | [06 · 1024](../../.runtime/hex-cell-deletion-impact-2026-09-21/browser-1789972490814/06-only-independent-branch-remains-1024.png) | 版本 52→53，只删除四个指定 Cell，上游 Data 与独立 SQL 保留 |
| Notebook / 独立分支继续分析 | [07 · 1440](../../.runtime/hex-cell-deletion-impact-2026-09-21/browser-1789972490814/07-independent-sql-still-succeeds-1440.png) | 原件 / 表未归档，独立查询结果正确 |
| Notebook / 关闭标签页重开 | [08 · 1024](../../.runtime/hex-cell-deletion-impact-2026-09-21/browser-1789972490814/08-reopened-definitions-retained-1024.png) | 两个保留步骤及新标题仍在，已删步骤不恢复，页面运行缓存未持久化 |
| 看板 / 旧配置保留 | [09 · 1024](../../.runtime/hex-cell-deletion-impact-2026-09-21/browser-1789972490814/09-reopened-saved-dashboard-1024.png) | 保存的直绑原表 MetricCard 仍显示 230 |

最终 9 张截图全部实际查看，报告 `visualReview.completed=true`；主代理另复看 02 / 04 / 06 / 09，列表、过期说明、删除后步骤和看板可读，无页面横向溢出。最终额外真实 UI 断言：打开审阅后进入 Data 编辑，确认与全部删除按钮禁用；点“保留”后焦点落到 `.notebook-cells`，取消编辑没有保存请求或清单变化。该焦点断言纳入第 2 组，不将截图 03 冒称正在显示编辑中的焦点状态。

Notebook 六单元定义和 MetricCard 通过真实 scoped 项目 API 保存，明确是合成 setup，不是单元创建器或看板快照 UI 验收。新界面、导入、改标题、保留 / 关闭 / 确认删除走真实 UI，运行 / 保存 / 读取响应不替换。仅连接目录与无句柄最近项目列表 GET 用空目录防止显示其他记录。没有真实模型或外部数据库请求。

首轮[失败报告](../../.runtime/hex-cell-deletion-impact-2026-09-21/browser-1789972225438/report.json)是新模块落盘前开发热转换曾生成无扩展名路径，缓存后加载返回 404；尚未进入项目，没有 open / save / run，清单 SHA 未变，失败截图实际查看。只读 GET 确认 `.ts` 模块正常、旧 importer 仍引用无扩展路径后，将本次新增长 import 整理成多行触发重新转换；GET 已转为 `.ts` 并 200，没有重启服务、改端口或伪造响应。第二轮[中间通过报告](../../.runtime/hex-cell-deletion-impact-2026-09-21/browser-1789972322124/report.json) 6 组 / 9 图已通过且实际查看；独立复核的焦点小修后，再完整执行本节最终轮。失败与中间结果保留，不把第一次失败算通过。

由于已有最近项目登记达到 100 条，未改上限或删除登记；验证归属、允许的合成定义 / 数据和全部文件摘要后，复用之前失败测试的项目并先备份清单。最终轮开始的 11 表 / 9 原件 / 9 Notebook、所有旧页面和模型层及旧文件 SHA 保持；只新增该轮独立工作界面、CSV 原件 / 表和六步定义，再由 UI 明确删除其中四步。没有删除任何原件、表或旧资源；删除前定义可从脚本 fixture / 报告运行回执核对，没有 Cell 回收站。

## 保留与未验证项

- 审阅是当前 Notebook 的本窗口确认，不是服务端跨窗口删除锁；其他窗口仍由原项目乐观并发保存保护。JSON 基线只用于本地比较，不入 API / 存储。
- 不解析自由代码、未知 Cell 或跨页依赖；不改变 Agent 草稿编辑 / 删除协议。Python 关闭时人工删除保持允许，自动草稿能力限制不放宽。
- 删除确认后只更新 Notebook；项目写盘仍是原异步队列，保存失败保留本地状态并沿用原错误恢复，不承诺同步磁盘事务。
- 自动重算暂停与恢复、目标消失的关闭退路、`onChange` 同步抛错不清缓存 / 队列由代码复核及相关调度 / SSR 测试支持；不冒称所有这些组合均有真实浏览器截图。
- 保留看板的浏览器测试是直绑本轮原表的 MetricCard，不是本轮完成 Notebook 快照 → ChangeSet → 应用 / 撤销全流程。完整快照闭环、未知 Cell、Python 物理卸载、M7、真实模型 / 外部数据库和稳定站发布保持未完成。

## 工作区与运行

分支 `feature/eds-analysis-dashboard`，HEAD 未变；保留已有未提交内容和其他会话研究记录，无提交、推送、合并、切换、stash 或清理。只新增本轮合成验收资源，未对用户数据做删除；浏览器确认删除只作用于本轮自建四个 Cell 定义，删除前定义保留在测试夹具与证据。没有步骤回收站，不宣称能一键恢复。服务不重启、不停用、不换端口、不改配置，3000 不发布。
