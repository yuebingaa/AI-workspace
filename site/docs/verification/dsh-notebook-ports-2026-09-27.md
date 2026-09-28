# DSH 共享执行端口与真实数据分析复验

日期：2026-09-26 夜间开始，2026-09-27 收尾。仅源码和 3001；未发布 3000、提交或推送。

后续状态复核（2026-09-27）：下文保留当时验收记录。原两处语义表单类型错误已在随后完成的前端批次中修复；本次“继续修正”重新运行全量类型检查通过。不是关闭检查或增加类型断言；表单按 `measures` 分组读取已知类型的指标，维度不参与聚合校验。本次追加 20 项聚合校验回归测试，最终 5 文件 60 项相关测试、目标 ESLint 和 236 文件架构检查通过，不改业务源码和界面。两次全仓测试及两次构建均收到进程终止信号（退出码 `-1073741510`），来源未确认，没有完整结论，不能算通过；没有改用下方历史成功记录替代本次检查。详细命令和边界见根目录任务日志中本次条目。

## 本批完成边界

将 Notebook 执行、运行环境查询、连接 Schema 查询及已解析工作簿的能力类型交回所属模块。DSH 和旧 Harness 消费相同契约；旧 Harness 与共享业务工具保留。没有更改 API、工具名称、权限、执行保护、草稿确认或持久化格式，也没有增加新的模型或数据库实现。

实际结构与职责：

```text
core/notebook/execution-contracts.ts       NotebookDraftRunner / 最小执行输入 / 运行环境查询类型
core/connections/contracts.ts             ConnectionSchemaInspector
core/eds/analysis.ts                      EdsRawWorkbook
core/agent-engines/server/
  authorized-ports.ts                    服务端已授权能力集合
  dsh-engine.ts                          DSH 调度与回执适配，直接依赖领域能力类型
core/harness/
  notebook-runner.ts                      从工具请求投影隔离的 Notebook 执行输入
  notebook-cell-tools.ts                  增量工具调用同一执行端口
  tools/notebook.ts                      整稿工具调用同一执行端口
  tools/contracts.ts                     旧工具契约，保留原工作簿类型别名
  server/notebook-tool-bridge.ts          两引擎共用工具业务及私有草稿状态
app/api/ai/harness/handler.ts             授权、身份/项目与实际执行依赖组装
scripts/verify-dsh-analysis-web.mjs        当前官方 Web 的有界付费验收及单次安全续验
```

`NotebookDraftExecutionContext` 仅包含 `revision`、`sources`、`semanticModels`、`taskId`、`signal`。来源只取草稿引用的数据；定义、行数据和语义模型深复制，取消信号保持同一对象。执行器不能通过输入对象修改聊天请求、原数据或工具会话。新增整稿 / 增量两条变异测试验证这一点，并验证下一次运行仍拿到未污染数据。代码审查发现的新增纯类型环已在收尾消除，helper 直接依赖请求字段子集，不再引用整个工具上下文。

后续替换 Notebook 运行实现主要提供 `NotebookDraftRunner` 并在 HTTP 组装处接入；数据库连接的凭据、权限与 SQL 执行仍由已有 Connections 模块负责；模型服务与 DSH SDK 仍由 `core/agent-engines/server/dsh-driver.ts` 和 `runtime/dsh/` 负责。本批没有使不同模型 / SQL 方言零成本互换。

## 真实收费验证与失败记录

新建脚本自有合成项目，上传三行 CSV：East100、East50、South80。隔离浏览器仅使用 3001，屏蔽其他项目列表及连接列表，写请求必须匹配本次项目；不读用户数据或连接真实数据库。首轮与追问共两个唯一收费任务，`deepseek-v4-flash`、当前已安装 DSH SDK，合计 9 次模型调用 / 7 次工具调用。回执未提供可用的实际费用，不能据此计算金额。

1. 第一轮 `awaitingConfirmation`、原生会话 `new`，6 模型 / 5 工具。模型保留原 Data，新增 SQL、表格、柱状图；真实 `editNotebookCells`、`runNotebookCells`、`submitNotebookDraft` 均成功。随后网页自动调用一次真实 Notebook 运行 API；各输出含 East150 / South80，图表字段与数值一致。确认前正式 Notebook 仍是原来的单 Data，看板未改。
2. 脚本在后续 SVG 定位时失败：图例和主体都叫 `recharts-surface`，不构成模型或产品失败。已修正选择器到实际 `role="application"` 的主体 SVG。首轮回执和截图保留，未再发第一轮模型请求。
3. 第一次恢复脚本把上传原文件名误当 AppSpec 来源字段，安全拦截器拒绝了打开回执；0 新收费任务。改为检查项目表描述符后续验。此误报及截图保留，不作为产品故障或成功验收。
4. 成功恢复原项目与原草稿；历史任务没有自动重跑。用户路径显式“采用草稿”保存四个单元，随后显式“全部运行”成功，图表和结果表为 150 / 80。再刷新保留定义、不自动运行。
5. 第二轮 `completed`、原生会话 `resumed`，3 模型 / 2 工具。重新检索并运行现有 Notebook，只读回答 East150、South80、合计230；无编辑 / 提交工具、无新草稿 / ChangeSet、无网页自动预览请求、正式 Notebook 和看板保持不变。

证据：[首轮真实回执与自动预览](../../.runtime/dsh-analysis-web/browser-1790438601176/report.json)、[零付费恢复误报](../../.runtime/dsh-analysis-web/browser-1790438694325/report.json)、[成功恢复与第二轮](../../.runtime/dsh-analysis-web/browser-1790438760506/report.json)。恢复模式验证首轮报告 / 项目归属，第二轮发送前写排他 claim，不允许重复收费续发。

此轮实际证明“收费生成 / 试运行 / 自动预览”与“恢复历史草稿 / 显式采用运行 / 刷新续聊”；由于首轮脚本退出，没有把它写成同一窗口从自动预览到确认保存的连续实测。该确认不重复执行的行为另由本轮离线 UI 回归覆盖。

## 本次截图

8 张均由主代理实际逐张查看，报告内 `actualImageReviewed` 已标记。只含合成数据，失败截图也保留原始情况。

- [导入及单 Data](../../.runtime/dsh-analysis-web/browser-1790438601176/01-prepared-synthetic-data.png)
- [真实自动预览待确认](../../.runtime/dsh-analysis-web/browser-1790438601176/02-preview-awaiting-confirmation.png)
- [首轮脚本停止时网页正常](../../.runtime/dsh-analysis-web/browser-1790438601176/failure.png)
- [恢复脚本拦截误报](../../.runtime/dsh-analysis-web/browser-1790438694325/failure.png)
- [历史草稿恢复](../../.runtime/dsh-analysis-web/browser-1790438760506/01-resumed-historical-draft.png)
- [采用后真实图表及数值](../../.runtime/dsh-analysis-web/browser-1790438760506/02-resumed-confirmed-chart.png)
- [刷新保留定义、不重跑](../../.runtime/dsh-analysis-web/browser-1790438760506/05-refresh-no-auto-replay.png)
- [原生会话只读追问](../../.runtime/dsh-analysis-web/browser-1790438760506/06-readonly-followup.png)

本次无产品界面样式修改；不覆盖并行视觉规范或前端表单改动。未重复执行浏览器取消 / 模型失败场景，相关取消、超时与失败恢复由下列离线回归覆盖。

## 验证命令与结果

均在 `site/` 执行。修改前选定三个核心测试文件 181 项通过。修改后以下三组共 499 项通过；helper 去除类型环后另补跑 `notebook-receipt-integration.test.ts` 38 项通过，不重复计入 499。

```text
npx vitest run core/harness/server/notebook-tool-bridge.test.ts core/harness/notebook-receipt-integration.test.ts core/agent-engines/server/dsh-engine.test.ts core/agent-engines/server/dsh-conversation.test.ts core/agent-engines/server/dsh-semantic.test.ts core/agent-engines/server/dsh-parameter.test.ts core/agent-engines/server/dsh-text.test.ts core/agent-engines/server/dsh-readonly-delivery.test.ts --maxWorkers=2 --reporter=dot
# 248 passed

npx vitest run core/harness/notebook-cell-tools.test.ts core/harness/notebook-capabilities.test.ts core/harness/notebook.test.ts core/harness/tool-budget.test.ts core/harness/notebook-text-references.test.ts core/harness/notebook-parameters.test.ts core/harness/server/notebook-semantic-bridge.test.ts core/agent-engines/server/dsh-capabilities.test.ts --maxWorkers=2 --reporter=dot
# 79 passed

pnpm exec vitest run app/api/ai/harness/route.test.ts app/api/ai/harness/dsh-engine.route.test.ts app/api/ai/harness/dsh-capabilities.route.test.ts app/api/ai/harness/notebook-cells.route.test.ts app/api/ai/harness/stream/route.test.ts components/studio/notebook/NotebookAutoRun.test.tsx components/studio/notebook/ai-run-scheduler.test.ts components/studio/notebook/run-control.test.ts --maxWorkers=2 --reporter=dot
# 172 passed

node scripts/verify-dsh-capabilities.mjs
node scripts/verify-dsh-dispatch.mjs
# 两组离线真实 SDK 夹具通过；前者实际本地 Excel/Python/DuckDB，数据库端口为替身

node scripts/verify-dsh-analysis-web.mjs --confirm-paid-model
node scripts/verify-dsh-analysis-web.mjs --resume-paid-run .runtime/dsh-analysis-web/browser-1790438601176
# 首次 paid 首轮成功后脚本误报；resume 首次零付费误报，修正后续验通过，全部失败原记录保留

npm run docs:agent:sync
npm run docs:agent:check
npm run build
git diff --check
# 通过；架构指纹 236 文件，构建保留既有大 chunk 提示，Git 有行尾转换警告

npm run typecheck
# 未通过：并行新增 components/studio/semantic-form.ts 第38/39行两处 unknown 类型错误
```

目标实现 / 测试 19 文件严格 ESLint、HTTP handler 与新验收脚本严格 ESLint 通过。离线 SDK 证据：[能力夹具](../../.runtime/dsh-capabilities-1790438780004/report.json)、[派发夹具](../../.runtime/dsh-dispatch-1790438798959/report.json)。本批未重跑全仓 `npm test` / 全仓 lint，前轮全量结果不冒充本次结果；构建成功不替代类型检查。

## 保留项与运行状态

- 全量类型检查的两处语义表单错误在本批边界修改之外，保留并行文件，未用断言 / 忽略指令掩盖。
- DSH 仍使用 Harness 请求、任务和事件协议，以及原共享工具桥 / Schema / 业务实现；下一次可继续迁移真实共用协议，本次没有删除旧 Harness 或旧规划 API。
- 仍使用现有 rows 契约；未新建全量数据仓库、分页、模型长期记忆、插件任意执行或数据库权限体系。
- 无真实数据库端到端、无通用分析准确率结论；合成成功不能代表所有 Excel 和复杂 Notebook 均成功。
- 当前分支 `feature/eds-analysis-dashboard`，用户及并行未提交修改全部保留。本次未升级依赖、改凭据、提交、推送或发布稳定站。起止 `site:status` 的 3000 / 3001 / 截图服务均健康，进程和重启计数不变；没有手动启停服务。
