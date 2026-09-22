# Hex 第二批：失败草稿诊断与执行耗时可见化

日期：2026-09-16。状态：本批源码、整体检查与开发站截图验收完成；未发布 3000。

## 固定范围

承接[里程碑](../architecture/hex-alignment-roadmap.md)的 M1，补齐首批尚未提供的用户可见诊断，不开始 M2 Cell 注册或 M3 结果仓库。本批不新增统计口径工具、模型调用、数据库、运行权限或失败草稿采用能力。

1. 将两条 Notebook 工具路径最后一次合法失败草稿投影为独立、有界、只读诊断；与成功的可采用 `notebookArtifact` 分开。
2. 展示已取得的环境准备 / 执行耗时、失败阶段；未取得回执时明确未知，取消 / 撤权不回传代码。
3. 诊断仅供当前窗口查看，不保存进项目、localStorage、备份或后续模型上下文；不展示表格原始行、stdout / stderr 或原始异常正文。
4. 按用户要求为已实现界面留存实际截图与场景记录，使用隔离合成项目，区分真实执行和明确的 SSE 回放。

源码可能包含业务字面量，不能宣称简单脱敏即可保证无敏感内容；诊断沿当前任务授权范围返回，并保留省略标记，不作为可执行或完整成果。当前窗口内持有不等于服务器从未在任务内存或幂等缓存中保留它。

## 修改前基线与工作区保护

- `feature/eds-analysis-dashboard` 上的首批未提交源码和新文件均保留，不清理、提交、推送或切换分支。
- 开始时 stable / dev / capture 健康；开发站重启数 2 为首批已记录历史值，不是本批启停。
- 本批重新运行 `npm test -- --reporter=dot --maxWorkers=2`：138 文件 / 1,178 项通过，1 文件 / 3 项原有跳过，另 14 项 Node 工具测试通过。[基线日志](../../.runtime/hex-cells-2026-09-16/tests-baseline.log)。
- 原 `NotebookCellRun.timing` 已用于手动 API 和模型工具观察，但公开 Harness Trace / 最终任务没有承载诊断，UI 也未呈现分段耗时。首批架构中将其描述为已沿 SSE 回传过宽，本批同步更正，不把工具内部观察当作浏览器证据。

## 工作记录

| 切片 | 当前记录 |
| --- | --- |
| 两条工具路径的合法草稿 / 运行投影与最终授权检查 | 已完成；增量 / 整稿共用收集器，按代次拒绝迟到回执；取消、授权曾拒绝和最终撤权不回传代码 |
| 失败诊断与手动 Notebook 共用耗时展示 | 已完成；默认折叠、React 文本转义、未知不伪造 0、准备失败标明执行未开始 |
| localStorage / 项目 / 备份不持久化 | 先复现 4 项失败，再通过共用保存解析剔除临时字段，实时任务及正式文档不变 |
| 后续聊天上下文不包含诊断 | 客户端请求和服务端 Conversation Store 回归通过，不复制到模型记忆 |
| 幂等缓存 / 共享在途最终回传门 | 先复现 5 项失败，补齐 JSON / SSE 共用授权复验；仅从响应副本剔除诊断，不改缓存和原任务状态 |
| 隔离浏览器截图、实际 Python 与明确回放 | 最终 7 组 / 10 张通过，逐张实际查看；截图与场景断言见下方 |
| 架构维护、类型、回归与构建 | 正文 / 变更记录维护完成，131 文件指纹与检查器通过，最终测试 / 类型 / 构建通过 |

## 实际模块和关键文件

```text
site/
  core/harness/notebook-diagnostics.ts       # 最终诊断契约、任务内收集与有界投影
  core/harness/runtime.ts                    # 独立生命周期和最终授权，不承接 UI / 存储
  core/harness/notebook-cell-tools.ts         # 增量编辑 / 运行接线
  core/harness/tool-registry.ts               # 整稿路径接线，保留原成功产物
  core/repository/studio-repository.ts        # 所有持久化入口共用剔除规则
  app/api/ai/harness/handler.ts               # JSON / SSE / 缓存统一最终回传门
  components/studio/HarnessNotebookDiagnostics.tsx
  components/studio/notebook/NotebookRunTiming.tsx
  scripts/verify-notebook-diagnostics.mjs      # 隔离浏览器验收与截图清单
  scripts/fixtures/notebook-diagnostics.mjs   # 脚本模型 + 真实 Harness / Python
```

`contracts.ts` 仅增加可选 `notebookDiagnostics`，旧任务仍可读；没有新 API 路径、事件种类或快照版本。`HarnessTrace.tsx` 和 `NotebookPanel.tsx` 组合新视图，样式分别在 `harness-trace.css` / `notebook-cells.css`，Notebook 组件仍不依赖 Harness。新增诊断、阶段展示与持久化回归文件，扩展现有工具、Trace、SSE、助手与 API 测试。没有删除或批量移动代码。

运行器仍通过原 Model / Notebook Runner 端口工作；此次没有改模型适配器、SQL 驱动、Dataset 存储、Dashboard binding 或 ChangeSet。更换 Python / SQL 执行实现仍在原 Notebook 服务端组装；只要遵守运行契约，诊断视图无需依赖具体执行器。新的收集器不提供执行或采用能力，未来持久化失败代码必须另行决定授权范围与生命周期。

## 截图与真实执行证据

最终目录：[浏览器报告与逐图断言](../../.runtime/notebook-diagnostics-2026-09-16/browser-1789556390033/report.json)。下面文件均位于该目录，10 张已逐张查看：状态文字和计时可读，长 JSON 在内部滚动，无整页横向溢出。

| 页面 / 场景 | 实际截图 | 结果 |
| --- | --- | --- |
| Notebook 成功 | [1440](../../.runtime/notebook-diagnostics-2026-09-16/browser-1789556390033/01-manual-success-1440.png)、[1024](../../.runtime/notebook-diagnostics-2026-09-16/browser-1789556390033/02-manual-success-1024.png) | 真实 Python 输出 1、2、0.5，环境准备 / 执行分别显示 |
| Python 失败、下游 SQL 阻断 | [1440](../../.runtime/notebook-diagnostics-2026-09-16/browser-1789556390033/03-manual-failure-1440.png)、[1024](../../.runtime/notebook-diagnostics-2026-09-16/browser-1789556390033/04-manual-failure-1024.png) | 无结果表也显示失败阶段，不使用旧成功结果 |
| 人工取消 | [取消界面](../../.runtime/notebook-diagnostics-2026-09-16/browser-1789556390033/05-manual-cancelled.png) | 真实 HTTP abort，无伪造结果 / 耗时 |
| AI 只读失败草稿 | [1440](../../.runtime/notebook-diagnostics-2026-09-16/browser-1789556390033/06-failed-diagnostic-1440.png)、[1024](../../.runtime/notebook-diagnostics-2026-09-16/browser-1789556390033/07-failed-diagnostic-1024.png) | 实际 Harness / Python 失败回执通过浏览器 SSE 回放，源码按文本显示，无运行 / 保存 / 采用按钮 |
| 诊断限长 | [省略说明](../../.runtime/notebook-diagnostics-2026-09-16/browser-1789556390033/07b-bounded-source-notice.png) | 显示部分单元 2863 / 4010 字符和另 1 单元省略，不冒充完整定义 |
| Harness 取消 | [取消回执](../../.runtime/notebook-diagnostics-2026-09-16/browser-1789556390033/08-cancelled-harness.png) | 取消任务没有诊断；区别于人工场景的在途 HTTP abort |
| 保存 / 刷新 | [重开正式文档](../../.runtime/notebook-diagnostics-2026-09-16/browser-1789556390033/09-refreshed-formal-notebook.png) | 2 个正式单元不变，诊断代码不落项目，刷新后消失 |

手动运行通过实际开发站 HTTP / Python，Agent 动作由脚本模型决定，调用真实 Harness、工具和 Python，再将真实终态回执明确回放到浏览器；**不是实际 LLM 端到端验收**。页面异常、意外外部请求和真实模型调用均为 0。首轮脚本错误地假设预算拒绝前不会进行下一次动作选择，修正验收前提后通过；失败现场保留，没有改变产品预算或弱化断言。第一次 9 图通过后补拍独立省略说明，再完整运行得到上述 10 图版本。

## 检查记录

- 后端相关 8 文件 / 185 项、前端与边界 3 文件 / 25 项、持久化 / 会话 / SSE 相关 6 文件 / 49 项通过。这些分组存在重叠，不相加。后端新增 16 项、UI 新增 12 项；持久化 / 会话 / SSE 新增 7 项。
- 严格 ESLint 首次在并行编辑的 API 测试中发现 1 个未使用变量警告，已通过显式副本删除改正，21 个本批代码 / 测试 / 验收脚本最终严格检查通过。没有关闭规则。
- 独立 CSS 解析探测因既有依赖未暴露对应入口而未执行，不新增依赖；实际浏览器和生产构建覆盖了两份样式。
- `npm test -- --reporter=dot --maxWorkers=2`：最终 **141 文件 / 1,213 项通过**，1 文件 / 3 项原有跳过，另 14 项 Node 工具测试通过。本批新增 35 项，无待处理新增回归。[本次完整日志](../../.runtime/hex-cells-2026-09-16/tests-final.log)。
- `npm run typecheck -- --incremental false`：通过，重新生成路由类型后无错误；绕过该脚本的子任务直接 tsc 曾遇旧 `.next` 路由类型错误，不将旧生成物视为源码错误。[最终类型日志](../../.runtime/hex-cells-2026-09-16/typecheck-closeout.log)。
- `node node_modules/eslint/bin/eslint.js <本批 21 个 TS / TSX / MJS 文件> --max-warnings=0`：通过；未运行全仓 lint。两份验收脚本 `node --check` 通过。
- `npm run build`：最终通过；仍有既有部分 chunk 超过 500 kB 的提示，不是失败。[构建日志](../../.runtime/hex-cells-2026-09-16/build-closeout.log)。
- `npm run docs:agent:sync`、`npm run docs:agent:check`（131 文件）、`npm run docs:agent:test`（1 项）通过；同步指纹前已更新正文和变更记录。[检查器日志](../../.runtime/hex-cells-2026-09-16/docs-checker.log)。
- `node scripts/verify-notebook-diagnostics.mjs`：最终 7 组 / 10 图通过；全工作区 `git diff --check` 与新增文件空白检查通过。没有关闭检查或弱化失败断言。

## 工作区与启用状态

仍在 `feature/eds-analysis-dashboard`，此前未提交改动与本批修改均保留，未提交 / 推送 / 切换分支。只在 3001 实际验收；3000 未发布。最后 `npm run site:status` 显示 stable / dev / capture 全部健康，进程、修订和重启数与本批开始一致，没有启停网站服务。[状态记录](../../.runtime/hex-cells-2026-09-16/services-final.log)。

截图要求已写入根 `AGENTS.md` 和视觉规范，不只依赖聊天记忆。验收合成项目、截图和运行记录保留于忽略目录；根 `TASK-LOG.md` 沿既有规则仅本地保留。没有触碰用户原件或更新数据库；AdventureWorks 链路沿用首批成果，本批未重新作实库验收。

## 本轮不处理

Cell 插件注册、完整 DAG、参数单元、结果仓库、统计口径产品约束和跨任务失败代码恢复继续按原里程碑推进。没有真实付费模型、生产或远端数据库验收；M1 整体不因本切片完成而自动标为全部完成。
