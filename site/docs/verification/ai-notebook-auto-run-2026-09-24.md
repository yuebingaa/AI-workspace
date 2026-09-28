# AI 分析完成后自动运行 Notebook 预览

日期：2026-09-24。范围：本次 AI 成功 Notebook 草稿的自动预览运行、显式确认与撤销；不改模型策略、服务端权限、API 或保存格式。

## 实现

- `components/studio/workspace/assistant.ts`：完成任务后仅对合格的新草稿发出一次性回调，捕获独立文档基线，取消/失败/只读回答不触发。
- `components/studio/StudioWorkspace.tsx`：本窗口默认开启开关，绑定项目、界面、会话、数据来源和附件身份，打开 Notebook；不从历史恢复自动执行事件。
- `components/studio/notebook/ai-run-scheduler.ts`：新事件消费、准备预览、等待完整预览文档提交后运行；去重、上下文保护、无自动重试。
- `NotebookPanel.tsx`：预览定义/原缓存与正式文档分离，复用真实运行 API；独立 `draft` lease。确认才保存定义并保留结果，撤销恢复原缓存；失败/停止不能确认。
- `NotebookDraftReview.tsx`、`AiBuilderAssistant.tsx`：预览/确认/撤销和助手提示，复用现有样式。

## 验证

用户参考视频已实际按时间抽帧查看，其中图表与待确认更改同时存在；原视频及参考帧不纳入公开提交。以下均为本批实际执行，不引用上一批付费模型验收代替本次检查。

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck` | 开工与收尾均通过 |
| `npm test -- --maxWorkers=2` | 两轮通过；最后一轮 269 文件通过 / 1 既有跳过，3378 项通过 / 3 既有跳过；另 26 项 Node 工具测试通过 |
| 相关单元测试 | 5 文件、155 项通过；覆盖回调条件、基线、去重、取消、权限、上下文变化、预览文案与运行所有权 |
| `npx eslint … --max-warnings=0` | 本批 12 个 TS / TSX 文件及验收脚本通过，未关闭规则 |
| `npm run build` | 通过；最后交互锁补充后再次通过，保留原有大于 500 kB 分块提示 |
| `npm run docs:agent:sync`、`npm run docs:agent:check` | 209 源码文件指纹同步 / 检查通过 |
| `git diff --check` | 通过 |
| `node scripts/verify-ai-notebook-auto-run.mjs` | 3001 隔离项目 9 组通过，页面 / 路由错误均为 0 |

[最后完整测试日志](../../.runtime/ai-notebook-auto-run-20260924-tests-final.log)、[最后构建日志](../../.runtime/ai-notebook-auto-run-20260924-build-latest.log)。初轮新增测试的可选数组索引类型错误、预览清理位置的 React lint 错误已修复并复验；早期浏览器脚本三次准备失败为控件名称 / 输出变量确认定位问题，修正脚本后通过，不将失败轮记作验收。

### 3001 交互与截图

使用新建本地隔离项目和三行合成 CSV；AI SSE、草稿及生成阶段试运行回执为明确标记的测试替身，**没有真实收费模型请求**。可视 Notebook 使用真实 `/api/notebook/run` 执行 Data → DuckDB SQL → 表格 / 图表，首轮 East 150 / South 80，窄窗口图表 East 900 / South 480。每轮 9 个合成任务、6 次 Notebook 请求：3 次真实计算成功、1 次注入 HTTP 503、2 次受控取消。

验证新草稿只运行一次、确认才保存正式定义且不重复计算；成功预览和运行中撤销均恢复原有非空结果及原 run ID，迟到回执不覆盖；失败 / 停止不允许确认、不自动重试；刷新、历史草稿、普通问答、失败 AI 任务及关闭开关不触发自动执行。正式看板始终保持原样。

完整视觉轮的 13 张截图均实际打开查看，覆盖 1440 px / 1024 px：[完整报告](../../.runtime/ai-notebook-auto-run-20260924/browser-1790230956630/report.json)。最后同步交互锁补充后，重新执行全部 9 组并实际复看成功待确认、确认完成、运行中撤销三张关键截图：[最终回归报告](../../.runtime/ai-notebook-auto-run-20260924/browser-1790231144342/report.json)。未把最终轮另外 10 张未复看的图标记为已阅。

| 页面 / 场景 | 截图与结论 |
| --- | --- |
| Notebook 自动预览 | [结果](../../.runtime/ai-notebook-auto-run-20260924/browser-1790230956630/01-preview-success-not-confirmed.png)、[待确认控件](../../.runtime/ai-notebook-auto-run-20260924/browser-1790230956630/01a-success-pending-confirmation-controls.png)：显示真实结果，尚未保存步骤 |
| 明确确认 | [确认完成](../../.runtime/ai-notebook-auto-run-20260924/browser-1790230956630/02-confirmed-preserves-result.png)：保存定义，保留结果，不再查询 |
| 撤销 | [成功后撤销](../../.runtime/ai-notebook-auto-run-20260924/browser-1790230956630/02b-withdraw-restores-previous-results.png)、[运行中撤销](../../.runtime/ai-notebook-auto-run-20260924/browser-1790230956630/02c-withdraw-running-preserves-results.png)：原结果、原运行身份恢复 |
| 刷新与历史 | [刷新](../../.runtime/ai-notebook-auto-run-20260924/browser-1790230956630/03-refresh-no-run.png)、[历史草稿](../../.runtime/ai-notebook-auto-run-20260924/browser-1790230956630/08-historical-pending-no-run.png)：没有自动执行 |
| 失败 | [HTTP 失败](../../.runtime/ai-notebook-auto-run-20260924/browser-1790230956630/04-http-failure-not-confirmed.png)：错误可见，不保存 / 重试 |
| 停止 | [运行中](../../.runtime/ai-notebook-auto-run-20260924/browser-1790230956630/05-preview-running.png)、[停止后](../../.runtime/ai-notebook-auto-run-20260924/browser-1790230956630/06-preview-cancelled.png)：不能确认，可撤销 |
| 关闭开关 | [手动草稿](../../.runtime/ai-notebook-auto-run-20260924/browser-1790230956630/07-disabled-keeps-manual-draft.png)：保留原手动采用流程 |
| 1024 px 图表 | [待确认](../../.runtime/ai-notebook-auto-run-20260924/browser-1790230956630/09-narrow-chart-pending-confirmation.png)、[真实图表](../../.runtime/ai-notebook-auto-run-20260924/browser-1790230956630/10-narrow-chart-real-result.png)：结果与确认区可用，无新增 CSS |

这些本地证据位于忽略目录，不随普通源码提交上传。脚本每次新建合成项目，不接受用户项目路径；未清理旧轮次证据。

## 边界

不是逐 Cell 流式编辑，也不自动确认看板、生成 Dataset、恢复旧草稿任务或重试失败。没有 Notebook 草稿的回答不会强制创建或运行 Notebook。预览期间需先确认/撤销再发下一轮 AI。工具内试运行和可视预览会分别计算，实际数据可能更新；可视预览本身不新增模型调用。

本批未重新验证真实模型生成、Python 或外部实库端到端；受控取消验证的是前端传输 / 状态所有权，不是数据库服务器长查询终止证明。原有服务端能力、权限与限额不变。本窗口开关不写入项目，刷新默认开启，但不会执行历史草稿。

## 工作区与启用状态

源码和 3001 开发站已生效。前后 `npm run site:status` 均显示 3000 / 3001 / 3198 健康，PID、worker、revision 和重启次数保持不变；没有启停或发布。3000 和已发布 Windows 包未更新。

分支仍为 `feature/eds-analysis-dashboard`，HEAD 保持 `f5ec4e2`；本批修改留在工作区，没有提交、推送或改锁文件。两份原有私有未跟踪案例文件保留，未纳入本任务。根目录任务日志已补充本批实际记录。
