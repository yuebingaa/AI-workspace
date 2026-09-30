# Notebook 实时分析过程 · 2026-09-28

按 [Hex 录屏差距报告](../research/hex-video-gap-2026-09-27.md) 的第一批范围实施：让分析过程及时出现在 Notebook，而非等最终回答后一次出现。本批为源码 / 3001；不更换 DSH、Notebook 运行时或现有图表组件，不发布 3000。

## 已落地的链路与边界

`Notebook 执行器 → 可选进度观察接口 → 受授权的 Notebook 工具桥 → DSH SSE → 窗口内版本化草稿 → 现有代码 / 表格 / 图表组件`

- 编辑工具成功后推送当前草稿；真实运行产生排队、单元开始、成功、失败、下游阻断事件。每次编辑整体失效已有预览，避免拿旧结果解释新代码。
- 单元结果随实际执行回执进入有界展示：每表最多 50 行且行 JSON 不超过 16,000 字节，文本最多 2,000 字；保留 runId / cellId / revision / AI 访问模式及截断信息，剔除 stdout / stderr。完整计算仍由原执行器处理，展示限制不是新增计算额度。
- 草稿、正式文档、最终待确认预览分别由既有业务状态和新增窗口内状态管理。取消、旧序号、旧编辑版本、不符运行身份、范围变化不覆盖当前草稿；实时载荷不写入任务历史、项目文件或幂等重放缓存。
- 官方 DSH Web 保留，公共输入区插槽显示真实过程列表；同一次运行 / 单元的开始被完成回执更新，技术工具名在详情中，定位按钮复用官方 Button。定位仅滚动 / 聚焦当前任务单元，没有新增修改权限。
- 成功提交的最终草稿仍由当前权限和数据重新执行隔离预览，再整稿确认 / 撤销。此阶段说明“重新读取当前数据并复核”，没有盲目复用生成阶段样本作为缓存；正式 Notebook / 看板的保存边界不变。

## 主要文件

| 归属 | 文件与职责 |
| --- | --- |
| Notebook 契约 / 状态 | 新增 `core/notebook/live-progress.ts`、`live-state.ts`；执行观察协议、有界结果和纯展示 reducer |
| 计算 / 工具桥 | `core/notebook/server/execution.ts`、`execution-contracts.ts`、`core/harness/server/notebook-tool-bridge.ts`；真实计算事件、授权 / 身份检查和兼容回执 |
| DSH / SSE | `core/agent-engines/server/dsh-engine.ts`、`core/harness/contracts.ts`、`runtime.ts`、`app/api/ai/harness/handler.ts`；观察事件和实时 / 历史载荷分离 |
| 网站状态 / UI | `components/studio/workspace/assistant.ts`、`StudioWorkspace.tsx`、`notebook/NotebookPanel.tsx`、新增 `NotebookLivePreview.tsx`；任务通知、范围隔离、只读草稿与原确认流程衔接 |
| 官方聊天适配 | 新增 `core/dsh-web/progress.ts`，更新 `protocol.ts`、`DshWebFrame.tsx`、`AiBuilderAssistant.tsx`、`runtime/dsh/web-client.mjs`；小型过程投影与受校验的定位命令 |
| 验证 | 新增 reducer / 过程测试与 `scripts/verify-notebook-live-progress.mjs`，扩展 DSH / 工具桥 / SSE 回归；未安装新依赖 |

## 验证记录

- 改动前定向基线：DSH、工具桥、assistant、Notebook 依赖执行共 **223 项通过**。
- 改动后定向命令：`npx vitest run core/notebook/live-state.test.ts core/dsh-web/progress.test.ts core/harness/stream.test.ts core/harness/server/notebook-tool-bridge.test.ts core/agent-engines/server/dsh-engine.test.ts components/studio/workspace/assistant.test.ts core/notebook/server/dependency-execution.test.ts core/dsh-web/protocol.test.ts --maxWorkers=2`，**8 文件、251 项通过**。
- 该组包含真实 DuckDB SQL 经 DSH 测试驱动、工具桥、逐单元观察、SSE 编解码的集成验证，以及失败 / 阻断 / 修复、取消 / 撤权、迟到回调、版本 / 引用检查、有界结果、历史载荷剥离。驱动是显式替身，不冒称收费模型。
- `npm run typecheck` 通过；对本批 TS / TSX / runtime / 验收脚本逐文件执行 `npx eslint …`，零错误、零警告。
- `npm run docs:agent:sync`、`npm run docs:agent:check` 通过，253 个纳管源码文件；已同步架构正文与变更记录，不仅修改指纹。
- `node --test runtime/dsh/web-client.test.mjs runtime/dsh/web-assets.test.mjs`：**28 通过、1 因 Windows 无 symlink 权限失败**。失败发生在既有测试夹具创建链接时（EPERM），未到资源拒绝断言；不跳过或弱化断言，不将此项记为通过。
- `npm test -- --maxWorkers=2`：**287 文件通过、1 文件预设跳过；3630 项通过、3 项预设跳过**，随后 **26 项 Node 工具测试通过**，退出码 0。没有新增 skip 或关闭检查。
- `npm run build` 通过，生成独立构建但没有发布；保留打包体积超过 500 kB 与插件耗时提示。收尾再次 `npm run typecheck`、`docs:agent:check` 和 `git diff --check` 通过。

开发中发现并修正：可选观察者不应改变未启用进度的原 runner 参数；ref 更新改为 effect；测试夹具的表格 Schema 与请求端点对齐。早期浏览器脚本一次拦截旧端点、一次读取未完成保存的状态而失败，均修正后重新从隔离项目完整验收，没有放行真实模型作为替代。

## 3001 实际截图

运行：`node scripts/verify-notebook-live-progress.mjs`。最终 [机器报告](../../.runtime/notebook-live-progress-20260928/browser-1790594816549/report.json) 通过，页面错误和意外请求均为零。使用新建的合成站点 XLSX（24 行、12 个工站），没有打开用户项目。以下 **12 张均已实际查看**，不是设计稿或仅 DOM 断言。

| 截图 | 场景与结论 |
| --- | --- |
| [01 草稿先出现](../../.runtime/notebook-live-progress-20260928/browser-1790594816549/01-live-draft-before-result.png) | 最终回答、运行结果出现前已显示 Data / SQL / 图表草稿，标为未保存 |
| [02 单元执行状态](../../.runtime/notebook-live-progress-20260928/browser-1790594816549/02-per-cell-running.png) | Data 实际输出、SQL 运行中、图表排队清晰区分 |
| [03 图表与过程](../../.runtime/notebook-live-progress-20260928/browser-1790594816549/03-live-chart-and-process.png) | 真实 Top10 结果图在最终回答前可见，过程定位可聚焦图表单元 |
| [04 最终确认](../../.runtime/notebook-live-progress-20260928/browser-1790594816549/04-final-preview-confirmation.png) | 最终本地复核成功仍等待人工确认，正式定义未改 |
| [05 已采用](../../.runtime/notebook-live-progress-20260928/browser-1790594816549/05-adopted-definition.png) | 确认后保存三单元及定义，保留本窗口结果 |
| [06 SQL 失败](../../.runtime/notebook-live-progress-20260928/browser-1790594816549/06-sql-failure-blocks-chart.png) | 真实缺字段错误展示在 SQL 单元，下游为阻断而非旧成功 |
| [07 新版本失效](../../.runtime/notebook-live-progress-20260928/browser-1790594816549/07-edited-invalidates-results.png) | 修正 SQL 后 v2 清除旧结果，明确等待重算 |
| [08 修正为 Top5](../../.runtime/notebook-live-progress-20260928/browser-1790594816549/08-top5-repaired.png) | 同任务新运行获得五行结果，确认前仍为草稿；之后撤销保留正式 Top10 |
| [09 取消](../../.runtime/notebook-live-progress-20260928/browser-1790594816549/09-cancelled-ignores-late-receipts.png) | 停止后显示已取消，注入迟到结果不改变界面 / 正式定义 |
| [10 失败终态 / 1024px](../../.runtime/notebook-live-progress-20260928/browser-1790594816549/10-terminal-failure-narrow.png) | 未修复错误如实停止，无采用入口；窄屏无整页横向溢出 |
| [11 查看正式文档](../../.runtime/notebook-live-progress-20260928/browser-1790594816549/11-formal-document-still-readable.png) | 失败草稿旁可查看原 Top10 与先前结果，未覆盖正式步骤 |
| [12 重新打开](../../.runtime/notebook-live-progress-20260928/browser-1790594816549/12-reopened-no-transient-results.png) | 仅恢复保存定义 / 既有待确认草稿，不恢复实时结果、不自动执行历史任务 |

浏览器中的模型回复和 SSE 为显式门控夹具，表格上传、SQL、图表、确认保存及重开使用真实网站 API / 组件。夹具将用户运行的引用访问模式映射为 AI 展示，仅用于 UI 验收；真实 AI-mode 回执与授权另由服务端集成测试验证。不能把浏览器回放描述成完整真实模型执行。

夹具记录首条事件、首草稿、首结果、最终回执的时间。Top10 场景约 **0.1 / 28.5 / 1445.1 / 2721.9 ms**；包含有意暂停、真实计算和截图等待，仅证明阶段顺序，不代表 DeepSeek 延迟、模型提速或线上性能。取消场景的迟到结果尝试也记录在原报告，但断言确认未被 UI 采用。

## 保留与未验证

- 原 Harness 保留；普通 Notebook HTTP 运行没有改成逐单元 SSE。当前 DSH 编辑一个批次后展示该批次，不在模型尚未完成参数时展示半截 SQL。
- 窗口内结果不能作为持久化计算缓存；最终复核仍会重跑。跨任务 / 用户 / 数据版本的结果缓存、依赖增量调度、逐单元确认留待后续。
- 历史草稿在撤销预览后仍可作为待确认草稿出现在重开页面，这是原有行为；本批没有增加“永久丢弃历史草稿”规则。
- 第二批拖宽侧栏、图表业务标签 / 单位等不在本轮范围；不宣称已复制 Hex 的全部能力或内部架构。
- 未新增真实付费模型、Python / 实库 / 外部服务端到端验收，未制作本批便携包；沿用已有接口不等同于本批实测全部运行时。
- 当前分支 `feature/eds-analysis-dashboard`；既有 Notebook 独立插件 / 便携脚本未提交修改完整保留，本批不认领为新增成果。未 Git 提交 / 推送、未触碰生产数据、未启停服务。
- 收尾 `npm run site:status`：3000 / 3001 / 3198 全部健康，服务 / worker PID、运行版本与重启数均与开始检查一致。
