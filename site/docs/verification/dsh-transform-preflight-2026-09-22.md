# DSH 零步骤受限：Transform 接入与初始化诊断

## 本次范围与定位

用户要求解决“分析input文件”在零步骤时受限的问题。本次处理已确认的 Notebook Transform 接入遗漏，补齐安全初始化诊断，并修复真实模型验收新暴露的普通分析交付判断；不解除数据范围、附件、Python、数据库、语义模型或正式采用限制，不修改用户项目。

只读核对截图 15:57:26 对应任务：`blocked / missingRequirements`，模型和工具计数均为 0，目标为同一工作界面的 Notebook。该页面当前有 7 个单元：Data、SQL、SQL、Chart、Transform、SQL、SQL；没有 Python。项目没有 EDS 上下文，已选语义模型属于另一工作界面，五个持久化来源未删除且 AI 策略为 `not-required`。没有读取数据行、原件内容或向模型发送用户数据。

`core/harness/server/notebook-tool-bridge.ts` 原 notebook profile 只允许 Data/SQL/Table/Chart/warehouseSql/启用的 Python；构造时检查整个已有 Notebook，所以合法 Transform 也会拒绝整项任务。这是当前文档可直接复现的确定阻塞点，不是文件损坏或 cellSearch 版本错误。历史完整请求未保留，不能声称排除了当时所有其他输入差异。

## 实际修改

- 工具桥 notebook profile 加入 `transform`，编辑 Schema 仍从统一 `editNotebookCellsSchema` 裁剪，计算仍由已有 DataRecipe / Notebook runtime 执行。既有 Transform 可以保留、编辑、真实运行并随草稿提交；Data 来源与人工采用保护不变。历史 `csv` 试点保持原四种单元，不扩展 text/parameter/semanticQuery。
- `core/harness/server/bridge-preflight.ts` 定义有限错误类型和静态提示，区分缺上下文、来源不可用、附件不匹配、未支持单元、引用不可用、Python 未启用等。仅初始化 guard 使用；运行中的工具拒绝不改成初始化故障。
- `core/agent-engines/server/dsh-engine.ts` 只在构建工具桥阶段识别可信类型；未知初始化异常为“初始化失败，未确认原因”，不再误报确定缺能力。取消、撤权和超时优先，不输出原始异常、文件名、数据标识、路径或凭据。
- 公共 HTTP JSON/SSE 回归覆盖已有 Transform → 编辑下游 → 真实 SQL 150/80 → 提交待确认；正式请求保持不变。未支持单元返回具体安全码、零模型调用及无草稿。

## 真实模型验收暴露的第二个问题

第一次在 3001 隔离项目使用真实模型提问“分析input文件”：Data → Transform → SQL → Table 已实际运行成功，输出 East 150 / South 80；模型纠正一次检索版本错误后直接回答，没有编辑和提交草稿。旧的普通分析终结契约仍要求草稿，因而以 `verificationFailed` 结束。本轮该次任务 5 次模型 / 5 次工具调用，失败报告原样保留，不把“计算成功”包装成“交付成功”。

对应回归先运行：公共 JSON/SSE 两项均复现 `completed` 预期与实际 `verificationFailed` 不符；同批其余 17 项通过。修复仍保持普通分析完整工具目录，而不是将全部分析预路由为只读。只对完整句子表达的泛指文件 / 数据分析开放“依据本轮已有链路结果回答”的备选终结；明确新计算、图表、修改、未知目标仍要求草稿。命名来源须匹配本次来源元数据，不能拿无关文件结果交付。所有编辑 / 提交尝试（包括失败）都会取消回答分支；验证过的草稿优先保留人工确认。本轮工具观察、成功输出、版本 / 运行归属、权限和桥会话仍必须通过校验。

独立复核另补本次分支调整的终结竞态保护：验证回调期间若工具桥关闭、草稿失效，不能采用之前缓存的草稿；回答提交前重新检查完整工具尝试账本，验证期间开始的编辑也不得绕过草稿要求。仅在尚未尝试修改且真实运行成功时，DSH 运行回执提示“回答或继续编辑”两条合法路径，底层工具的原提交协议不变。

## 验证记录

旧实现下先新增合法 Transform 构造回归，实际失败后才修复。桥 64 项通过；终结修复后的四文件定向回归 162 项通过，其中公共 HTTP JSON/SSE 20 项，包含先失败的直接回答用例。原 CSV、未授权来源、未知依赖、伪造文件/SQL/脚本步骤继续拒绝。初始化类型测试覆盖有限码、伪造异常、隐私、取消/撤权/超时优先和运行阶段不能伪报初始化。最终全量检查在源码冻结后重新执行，不沿用中间版本结果。

| 本次执行 | 结果 |
| --- | --- |
| `npm test -- --maxWorkers=2` | 最终 256 文件 / 2,912 应用测试 + 26 Node 工具测试通过；原 1 文件 / 3 项跳过保持 |
| `node --test scripts/check-agent-architecture.test.mjs runtime/dsh/driver.test.mjs runtime/dsh/tool-diagnostics.test.mjs` | 19 项通过 |
| `npm run build` | 通过，既有大 chunk 提示保留；未启动/发布产物 |
| `npm run typecheck` | 修改后及构建后均通过 |
| 本次 9 个 TS 实现/测试及 4 个浏览器脚本严格 ESLint（`--max-warnings=0`） | 通过，不放宽断言或忽略类型 |
| `docs:agent:sync / check` | 先更新正文，192 源码指纹一致 |

最终日志 `.runtime/dsh-preflight-final-{test,build,typecheck,lint}.log` 及 `.runtime/dsh-preflight-sdk-final.log`；中间失败 / 通过日志保留。此前批次测试/截图不算本轮验收。

服务前后 PID/worker、revision、启动时间、重启次数及稳定 release 逐项一致，三服务健康；没有停止或发布服务。

## 3001 真实模型与截图

共两次真实付费任务、合计 8 次模型调用；首轮失败、修复后第二轮成功，没有第三次或自动收费重试。未取得完整计费 usage，不推算金额。隔离浏览器只过滤无项目范围的最近项目 / 连接列表及远程字体样式；模型、公开接口、SSE、计算、项目保存均未替换。测试只涉及合成数据。

- 首轮[失败报告](../../.runtime/dsh-transform-browser-2026-09-22/browser-1790064991804/report.json)和[真实失败过程](../../.runtime/dsh-transform-browser-2026-09-22/browser-1790064991804/03-real-trace-1440.png)保留：5 次模型 / 5 次工具，计算成功但没有可采用草稿，不能计为整体通过。
- 第二轮[通过报告](../../.runtime/dsh-transform-browser-2026-09-22/browser-1790065326600/report.json)：新项目提问“分析input文件”，3 次模型 / 2 次成功工具，`cellSearch` → `runNotebookCells`，4 个单元真实运行 969ms；回答 East 150 / South 80 / 合计 230，`completed`，无工具失败、无编辑 / 提交 / 草稿 / 采用。正式 Notebook / AppSpec 逐值不变，仍 1 表 / 1 原件，页面 / 路由异常 0；DSH revision 7、活动任务 0 前后不变。
- 第二轮[已有 Transform](../../.runtime/dsh-transform-browser-2026-09-22/browser-1790065326600/01b-existing-transform-1440.png)、[数值回答1440](../../.runtime/dsh-transform-browser-2026-09-22/browser-1790065326600/02-real-answer-1440.png)、[成功过程1440](../../.runtime/dsh-transform-browser-2026-09-22/browser-1790065326600/03-real-trace-1440.png)、[折叠完成1024](../../.runtime/dsh-transform-browser-2026-09-22/browser-1790065326600/04-answer-1024.png)均已由主代理实际查看。1024剩余答案在正常滚动区，既有纯文本Markdown符号保持，不冒充新增富文本表格。
- 不支持单元的[报告](../../.runtime/dsh-unsupported-browser-2026-09-22/browser-1790065277191/report.json)、[1440原因](../../.runtime/dsh-unsupported-browser-2026-09-22/browser-1790065277191/01-safe-diagnostic-1440.png)、[1024原因](../../.runtime/dsh-unsupported-browser-2026-09-22/browser-1790065277191/02-safe-diagnostic-1024.png)是明确 fixture：真实引擎 / 工具桥初始化拒绝、固定 driver、可信测试上下文和浏览器缓冲 SSE 回放。零模型 / 零工具；不是官方 SDK 或公共 handler 全链。两图均实际查看，主代理复看1024。公开 JSON/SSE 的同类拒绝另由上述接口测试覆盖。

本次没有额外收费取消 / 撤权截图；这些边界由离线回归验证。真实 Excel / Python / 数据库、用户原文件与所有命名简写的分析效果不由本次合成 CSV 验收代替。

## 工作区与主要入口

- 核心：`core/harness/server/notebook-tool-bridge.ts` / `bridge-preflight.ts`、`core/agent-engines/server/dsh-engine.ts` / `readonly-answer.ts` 及相应测试；公共回归 `app/api/ai/harness/dsh-engine.route.test.ts`。
- 验收：`scripts/verify-dsh-transform-browser.mjs` 复用 `verify-dsh-readonly-browser.mjs`；`dsh-tool-diagnostic-fixture.ts` / `verify-dsh-tool-diagnostic-browser.mjs` 明确无模型拒绝场景。完整运行目录保留用于复核。
- 文档：唯一 Agent 架构入口、视觉规范、runtime README 与根任务日志同步；没有依赖升级或锁文件重写。
- 分支 `feature/eds-analysis-dashboard`，开场 381 条既有 Git 状态保留，收尾 385 条；没有提交、推送、分支或服务生命周期操作。任务日志历史字节前缀保持。

## 保留边界

- 未扩展 text/parameter/semanticQuery、图片、EDS 或外部工具；这些请求仍会明确受限。
- 未改“分析input文件”的原件附件启发规则，也未自动按文件名读取本地文件。当前定位页面没有 Python 文件引用；本次不是原件全链重做。
- 未改来源超过十项时的选择规则；当前项目五个来源，该问题不属于本次实际阻塞。
- 命名缩写不是数据授权或目标证明。比如仅选中 `input-copy-Sheet1` 不自动当作名为 `input` 的文件；这一类请求仍按普通草稿流程执行。若只希望分析当前所选数据，可明确提问“分析当前数据”。合成 `input.csv` 验收不冒充用户原工作簿的付费分析。
- 正式 Notebook/看板必须仍由用户确认采用；验证使用新的隔离合成项目，不清理或修改用户原任务。
- 未发布 3000、未操作服务生命周期、未提交或推送。SDK 风险沿用既有记录。
