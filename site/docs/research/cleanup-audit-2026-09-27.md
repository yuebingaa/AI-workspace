# 项目轻量化审查（2026-09-27）

本轮仅研究与文档记录，没有删除或修改业务代码、依赖、用户数据。延续用户要求：旧 Harness 保留。结论基于当前未提交工作区，不代表 GitHub 或 3000 已有相同内容。

## 结论

优先收掉重复的旧聊天展示、未接线的小模块，再退役独立的旧规划 API 和可视化实验后端；不要为了减少文件数删掉仍被 DSH 使用的 Harness 公共能力。代码维护负担、网页加载量、安装包大小是不同问题，本次没有测量压缩包或浏览器性能收益。

## 审查方法与边界

- 阅读协作约定、稳定运行文档、近期任务、README 和相关架构章节；核查服务状态、当前分支与既有修改。
- 使用已有 TypeScript 解析器只读分析 `app`、`components`、`core`、`scripts`、`runtime`、`adapters`、`fixtures`、`portable` 的 858 个 JS / TS 源码及测试文件，从 29 个框架页面 / 路由 / 布局入口检查静态可达关系，随后人工核查候选的符号引用、测试、导出与脚本。检查了字面量动态 import；变量构造的模块路径、外部调用和部署侧约定不能仅靠该图证明不存在。
- 抽查当前工作台、DSH 展示、旧规划、BI、可视化评测、企业微信及相关构建配置；没有逐行全面审计所有文件。未递归扫描 node_modules、缓存、构建输出、证据目录或大型数据内容。
- 没有运行业务测试、构建、真实模型或实库，也没有浏览器验收；这是删除前审查，不是删除后通过证明。没有沿用上一轮通过结果作为本轮结果。

## A. 优先级高、删除风险较低

| 候选 | 代码证据 | 推荐处理与边界 |
| --- | --- | --- |
| 未使用的旧规划客户端 | `core/ai/client.ts` 的 `requestAiPlan` 只有自己的测试和 `core/ai/index.ts` 再导出；当前产品未调用 | 可删除客户端及其专属测试，清理再导出。不要因此直接删除仍有独立路由的规划服务端 |
| 未使用的旧限流器 | `core/ai/server/rate-limit.ts` 的 `InMemoryRateLimiter` / `aiPlannerRateLimiter` 无生产调用，仅专属测试 | 可删除这份闲置实现及专属测试；不等于移除当前授权、并发、取消或查询保护 |
| 无调用的汇总导出文件 | `components/studio/index.ts`、`core/ai/index.ts`、`core/harness/mcp/index.ts` 没有查到仓内导入 | 可删除无消费方的 barrel 文件，实际实现文件保留；不会因此卸载原 Harness 或 MCP |
| 未接线的 BI 同步原型 | `core/bi/{contracts,index,sync-engine}.ts`；`BiSyncEngine` / `testBiConnection` 只有 `sync-engine.test.ts` 使用，未见页面、API、工具接入或具体生产连接器 | 若当前不保留这份未来接入原型，可整组从工作树移除，Git 留历史。不能顺手删除持久化数据描述中的 `bi` 来源类型，也不是删除现有数据库连接能力 |

前三项共 7 个文件（包括专属测试），约 11.5 KiB / 298 行；BI 原型另 4 个文件约 17.5 KiB / 465 行。按当前源码文本统计，仅用于说明范围：它们大部分本来就不在产品入口调用链，删除主要降低维护成本，不能承诺网页明显提速。删除测试仅限随退役实现一同退役的专属测试，不能减少保留功能的断言。

## B. 收益更大，但须成组迁移后再删

### 1. 旧聊天 UI 与样式

`components/studio/StudioWorkspace.tsx:117` 固定组装 `assistantExperience="dsh-conversation"` 和 `officialDshWeb`，首页及 `/dsh`、`/dsh/web` 都使用这个工作台。但 `AiBuilderAssistant.tsx` 仍保留 `useOfficialSurface` 为 false 时的旧消息列表、旧输入框、欢迎建议卡和底部“添加上下文”条。

建议将工作台收敛到当前 DSH 表面，移除不可达的旧 UI 分支及专属行为。随后可核查退役 `AssistantAnswer.tsx`、`assistant-answer-format.ts`、`HarnessTrace.tsx` 及只服务旧 Trace 的 `HarnessNotebookDiagnostics.tsx`，并整理对应测试。它们的当前非测试组件消费方都集中在旧聊天分支及相互调用；应在分支移除后再次检查，而非本轮直接宣告整个文件无用。

`AgentWorkspace.tsx` 不能整文件删除：其中 `WorkspaceModeBar` 仍由 `StudioHeader.tsx` 使用，只能移除旧 `AgentWorkspaceWelcome` 等无用部分。`StudioArtwork` 也仍用于新的 DSH 空白页。

旧样式分布在 `app/globals.css`、`agent-workspace.css`、`composer-context-menu.css`、`studio-theme.css` 和 `studio-layout.css`，例如 `.agent-suggestions`、`.agent-context-bar-menu`、`.conversation-turn`。应按删除后的组件引用逐项收敛，不能整份样式文件删除：工作台、数据菜单、状态反馈仍有共用规则。没有 CSS 覆盖率或前后包体测量，本轮不承诺节省百分比。

必须保留正式 DSH 的重试 / 取消、真实错误反馈、导出、Notebook 草稿入口、看板预览 / 确认，以及原 Harness 的执行与事件协议。删除旧展示不等于删除历史会话和后端验证。

### 2. 旧 `/api/ai/plan` 一次性规划链

`app/api/ai/plan/route.ts` 仍导出可访问的 POST，调用 `core/ai/server/deepseek-planner.ts` 的 `planChangeSetWithDeepSeek`；后者使用 `core/ai/planner-context.ts`。仓内没有发现当前工作台请求该接口，只有旧客户端和专属测试。服务端与上下文的 6 个专属文件（含测试）合计约 47.8 KiB / 1161 行。

建议按废弃接口成组退役，而不是仅删除客户端后留下另一条模型调用路径。HTTP 路由没有前端引用不代表外部无人调用：本轮未查证外部使用，实施时须明确直接撤除还是先返回明确的退役响应，并验证不再产生模型调用。

不能删除整个 `core/ai`：`contracts.ts` 的共享字段 / 元数据仍被多方消费，`operation-output.ts` 仍被 `core/harness/tools/dashboard.ts` 使用，`deepseek-endpoint.ts` 和 `runtime-credentials.ts` 仍被 DSH 使用，原 Harness 的模型适配和组装也保留。

### 3. 已退役可视化测试页的专属后端

上一轮只移除了界面。`app/api/ai/visualization-lab/stream/route.ts` 仍调用共享 handler 的 `{ visualizationLab: true }`；`core/visualization-lab/{cases,evaluate}.ts` 和测试还在，handler 的模式选择、固定数据、MCP / 视觉验证开关以及会话 namespace 都有专属分支。

若不再需要这个独立实验，可移除专用 API、核心评测实现及专属测试，连同上述实验分支一起清理。直接文件共 5 个约 20.8 KiB / 281 行，另有共享 handler / namespace 的分支。须回归默认 Harness 和 DSH 的上下文、授权及隔离语义。不能因此删除正式图表、`core/evaluation`、通用 SSE、ChangeSet 或视觉验证能力。

### 4. 旧浏览器验收脚本

`scripts/verify-semantic-models.mjs:97` 仍寻找“添加上下文”，随后寻找旧“AI 指令”输入框；`scripts/verify-dsh-semantic-browser.mjs:241` 也使用旧入口，并依赖 `.conversation-turn`。这些是静态发现的选择器不匹配，本轮没有执行并报告失败。

建议先将语义选择 / 取消、错误提示、历史恢复等仍有价值的断言迁移到当前 DSH 浏览器脚本，再退役被完整替代的旧脚本。不批量删除 `scripts/verify-*`：其中不少仍承担模型、数据库、取消及持久化回归。开发测试通常不进入网页 JS，删脚本不等于网页提速。

## C. 可以做可选功能，而非判定无用

- 企业微信：`WorkspaceNavigation.tsx` 仍有入口，`StudioWorkspace.tsx` 挂载 `WecomSettings`，设置 API 和 `core/wecom/server` 存在，`copy-wecom-cli.mjs` 在普通构建中复制 CLI。当前 handler 在 DSH 执行时不创建这条 MCP runtime，因此“设置可见”不等于 DSH 已能调用企业微信。若暂不需要，可做可选集成 / 可选打包，默认不载入界面和 CLI；这是产品功能取舍，不能仅删除 `@wecom/cli` 而留下构建及服务器引用。
- 旧 EdgeOne / Matplotlib 云渲染路径：`cloud-functions/api/charts/render.py` 声明 `/api/charts/render`，`requirements.txt` 依赖 Matplotlib；当前本地网页未发现请求该接口，`scripts/test_matplotlib_renderer.py` 仍测试它，`edgeone.json` / `build:edgeone` 仍声明另一部署入口。可作为“仅保留本地模式”时的整组退役候选，但未核实外部 EdgeOne 部署使用情况，不能直接归为垃圾。它与 Notebook Python、浏览器 Recharts 不是同一执行路径。
- `/dsh`、`/dsh/web`：只是指向同一工作台的很薄路由，保留旧书签价值大于删几行源码。可统一导航入口，但不建议为此打断旧链接。

## D. 暂时不删

- 旧 Harness：按用户决定保留。DSH 仍导入其请求 / 任务 / 事件契约与工具错误 / 共享业务能力，不能按目录名整包删除。
- `core/harness/deepseek-harness.ts`：仅 18 行左右的兼容组装层，现有离线 / 真实评测及多项测试仍使用；不是另一整套重复执行引擎。可以将调用迁往明确组装入口后再删，不作为首批减重重点。
- `core/evaluation`：没有网页入口很正常，package 脚本 `test:eval` / `test:eval:live` 仍使用，且部分实时协议被服务端消费；保留。
- Python、DuckDB、Arrow、PostgreSQL 驱动、DSH runtime：真实分析执行依赖。尤其 `playwright-core` 除截图外还被 Python runtime 动态加载，不是可随意移入纯开发依赖的库。
- Puck / Recharts：`PuckEditorClient.tsx` 动态加载看板编辑器，`NotebookChart.tsx` 等使用 Recharts；不能因为包大就删。可另做按需加载和依赖包体分析。
- 项目 / 会话兼容、权限检查、草稿确认、撤销、审计：隐藏了某个界面按钮，不代表底层能力已失去作用。
- EDS 专用分析、示例数据：目前仍有 UI / 执行入口，且契合现有分析案例，不按“demo / fixtures”名称直接清理。
- `.runtime`、证据、用户项目、测试数据库和运行目录：本轮不清理。里面可能包含会话、当前 DSH 安装选择、唯一截图和项目数据；磁盘回收须独立核实目标和可恢复性，不能递归删除整个目录。
- 没有找到直接源码 import 的依赖也不自动删除：还可能属于 peer、框架插件、类型或构建入口。Cloudflare / Vinext 相关配置实际仍在，不能仅据本地运行就移除。

## 建议实施顺序与验收

1. 小范围死代码：A 组，BI 作为明确不再保留原型时的候选。检查类型、相关测试、构建和架构文档。
2. 前端收敛：只留 DSH 聊天展示，按组件清理旧 CSS / 测试。用 3001 隔离项目覆盖空态、普通对话、失败 / 重试 / 取消、历史恢复、Notebook 草稿和看板确认，截图逐张验收。
3. 后端退役：独立撤除旧规划 API 与可视化实验 API，回归 DSH 与保留 Harness；不混入数据格式或权限改变。
4. 包体专项：需要时再决定企业微信 / 云部署的可选化，并测量构建产物和完整运行包大小。不得把源码删除行数当作包体或运行内存收益。

另外，根 `README.md` 的“设置可选 Harness / DSH”仍是旧界面描述，与当前固定 DSH 工作台和只读执行器设置不一致。应该更新说明而不是删除 README。实施删除时同步修改架构、视觉规范、测试入口和任务记录，保留历史事实。

## 本轮状态

分支 `feature/eds-analysis-dashboard`，既有未提交修改完整保留；仅新增本报告及追加任务记录。开工服务状态全部健康，无启停、发布、提交、推送、依赖安装或数据写入。未验证任何删除后的行为，以上是按风险排序的候选清单，不是已经轻量化完成。

## 后续落实 · 2026-09-27

用户同意后，第一批已落地 A 组中的 7 个闲置文件及旧聊天展示 / 专属样式收敛，并纠正 README 的旧切换说明。BI、旧规划 API、可视化实验 API、企业微信和云部署不在本批删除范围。原审查记录保留；实际删除清单、当前测试和截图见[第一批实施报告](../verification/cleanup-first-batch-2026-09-27.md)。

## 第一批之后再次审查 · 2026-09-27

本节对应后续“再看下还有什么可以删除”的请求，仅研究 / 文档修改，未继续删除源码或依赖。重新核查当前工作区，不将上文已完成的 14 个文件重复计入候选。

### 本次证据范围

重新读取运行约定、README、最近任务、架构当前状态与相关源码；从 29 个框架入口分析 841 个本仓 JS / TS 文件的 import、export、字面量动态 import / require，再用符号 / 路径搜索核对 API、测试、脚本、包配置和动态启动。扫描目录限于 `app`、`components`、`core`、`scripts`、`runtime`、`adapters`、`fixtures`、`portable`，排除依赖、构建、缓存和 vendor；未读取项目数据、私密配置或大型数据库。

本次图没有再筛出整文件不被框架入口引用的 `components/` 候选。此结果不等于每个组件内部的所有分支都有用途，也不覆盖外部 HTTP 消费方和变量构造的动态加载。真实缺口如下。

### 建议下一批优先清理

| 候选 | 本次复核证据 | 建议及保留边界 |
| --- | --- | --- |
| **未接线的 BI 同步原型** | `core/bi/` 4 文件共 461 行；`BiSyncEngine` / `BiConnector` 仅内部导出和 `sync-engine.test.ts` 消费，连接器实现只有测试用的 `ScriptedBiConnector`，没有产品页面 / API / Tool 接入 | 作为停用原型整组退役，Git 保留历史。不是删除现有数据库连接、语义模型或数据看板；`core/models/data-binding.ts` 的 `sourceType: "bi"` 及相应 Schema 仍属数据兼容契约，不随原型一起删除 |
| **旧执行器切换的前端分支（本次新增确认）** | `StudioWorkspace.tsx:1328` 是 `AgentEngineSettings` 唯一生产组件挂载点，并固定传入 `conversationOnly`。设置组件 `:46–89` 仍有旧引擎单选 / 应用按钮，`:145–165` 仍定义前端 PATCH / 切换状态，当前模式会直接拒绝调用 | 将组件收敛为只读 DSH 状态 / 工具目录，删除旧单选、应用回调、专属状态和对应样式 / 测试分支；保留刷新、错误、不可用原因、取消请求与焦点恢复。**不删除** `app/api/settings/agent-engine/route.ts` 的后端切换、`selection.ts` 或旧 Harness，它们仍有独立兼容与测试用途 |
| **无人消费的评测聚合导出（本次新增确认）** | `core/evaluation/index.ts` 仅 4 行再导出；静态图和文本检查未找到仓内消费者。实际评测通过具体文件、`test:eval` / `test:eval:live` 运行，服务端也使用 `live/protocol` 等具体路径 | 可以单独删除这个 index，不能删除 `core/evaluation/` 或评测用例。收益很小，不必为了少一个文件扩大改动 |

### 第二组：可以退役，但必须连入口一起处理

1. **旧 `/api/ai/plan` 链**：`route.ts:57` 仍可调用 `planChangeSetWithDeepSeek`，它仍具有真实模型请求能力；当前网站未发现请求该路径。专属路由 / 规划器 / 上下文及测试原为 6 文件，本次额外确认 `core/ai/fixtures/redacted-schema-failure.ts` 只被旧规划器测试引用，合计 **7 文件、1,184 行**。应成组退役；外部使用情况未验证，稳妥方式是先将旧端点改成明确的 410 退役响应且不调用模型，再移除专属实现。不能删除共享 `core/ai/contracts.ts`、`operation-output.ts`、模型适配器、`deepseek-endpoint.ts` 或 `runtime-credentials.ts`：看板工具 / DSH 仍直接消费它们。
2. **可视化实验后端**：页面已移除，但 `app/api/ai/visualization-lab/stream/route.ts:6` 仍以 `{ visualizationLab: true }` 调用共享 handler；直接文件 **5 个、276 行**。`handler.ts` 在请求解析、固定示例数据、视觉检查、执行器选择、MCP 与单 Agent 模式上仍有实验分支，`conversation/namespace.ts` 和 DSH 会话隔离测试也认识实验 namespace。推荐成组清理，而非只删除目录留下分支。若实验 namespace 被移除，旧实验会话不得被映射进普通会话。保留通用图表、正常视觉校验、SSE、Harness 评测与数据计算。

统计按文件当前文本去除尾部空白后的行数计算，包含专属测试；不是预估浏览器代码或运行包减少量。以上两条路由仍是框架入口，不能仅以“前端没 import”为理由认定已经无效。

### 历史脚本：退役展示断言，迁移业务断言

- `scripts/verify-assistant-answer-browser.mjs:123` 检查已删除的 `.assistant-answer`，并包含旧文本解析器专属标签断言；这些旧渲染细节可退役，但脚本同时含不安全文本、会话原文保留、刷新与取消检查，不能把这些通用保护一并遗失。
- `scripts/verify-dsh-settings-browser.mjs:87–88` 实际勾选旧单选框并等待 PATCH；当前 DSH 设置是只读目录。旧 UI 切换断言可退役，后端切换测试保留，当前只读刷新 / 错误 / 不可用状态仍应验证。
- `scripts/verify-semantic-models.mjs:97–104`、`scripts/verify-dsh-semantic-browser.mjs:115–128,241` 仍使用旧“添加上下文”按钮、旧 AI 指令输入和 `.conversation-turn`；应迁移到头部“数据”与官方 iframe，而不是删掉语义选择和真实分析验收。
- `scripts/verify-ai-notebook-auto-run.mjs:182–183` 仍找旧输入按钮；自动运行、撤销、失败不写正式定义等场景继续需要，不属于无用功能。`eds-browser-acceptance.mjs` 与 `studio-backup-browser-acceptance.mjs` 也仍有旧聊天选择器，且由 package 脚本直接调用，应优先迁移而非无提示删除命令。
- 文本命中旧类名不等于脚本过时，例如现用 `verify-dsh-default.mjs:81` 是断言 `.harness-trace` **不存在**，不能误删。旧“添加上下文菜单”的菜单名称也仍存在，不等于旧按钮仍存在。

本次仅静态确认不匹配，没有运行这些脚本并宣称它们全部失败。上一批通过的 DSH 综合浏览器验收不等于已覆盖全部旧脚本的业务场景。

### 不建议纳入自动删除

- 企业微信仍有菜单、设置弹窗、旧 Harness MCP runtime 与构建复制链；云 Matplotlib / EdgeOne 仍有独立部署配置和测试。二者可以在明确不保留该能力时可选化或整组下线，但不是死代码。本轮不核实外部部署、不卸载依赖。
- `core/projects/test-fixture.ts`、`core/semantic/test-fixture.ts` 有大量测试消费者；`core/harness/mcp/fixtures/readonly-server.mjs` 虽没有 import 入边，却由 `mcp-integration.test.ts:149` 通过进程参数启动；`core/evaluation/live/**/*.live.ts` 由专用 Vitest 配置发现。这些均不能按“页面不可达”删除。
- DSH 官方运行时、共享 Harness 工具 / 契约、SQL / Python / DuckDB / Arrow、看板编辑器、存储迁移、历史会话与确认 / 授权继续保留。没有做依赖包体或 CSS 覆盖率实测，不建议继续按包名或体积猜测删除。

### 本次交付与验证边界

建议顺序：**BI 原型 + 设置 UI 旧分支（顺带小导出） → 旧规划 API → 可视化实验后端 → 旧脚本业务场景迁移**。每组实施时独立回归，不将旧 Harness 的保留决定扩大解释为必须保留所有已失去用途的界面和实验。

当前分支 `feature/eds-analysis-dashboard`，服务检查健康；已有未提交 / 未跟踪改动保留。本轮只追加本报告与任务记录并检查文档差异；未执行代码删除、模型 / 实库调用、测试 / 构建或浏览器截图，无启停、发布、依赖安装、提交或推送。静态候选不是删除后的兼容性证明。

## 第二批实施 · 2026-09-27

用户授权后按上一轮建议的优先组执行，范围固定为 BI 原型、旧设置 UI 分支和闲置评测导出。旧规划 API、可视化实验后端、其他历史脚本与外部集成不在本批删除范围。

- 已删除：`core/bi/contracts.ts`、`index.ts`、`sync-engine.ts`、`sync-engine.test.ts`，以及 `core/evaluation/index.ts`，共 5 个已跟踪、任务前未修改的文件，可由 Git 恢复。数据 Schema 中的 `bi` 来源和当前数据库连接 / 语义模型保持；评测继续通过原具体入口运行。
- 已收敛：`AgentEngineSettings.tsx` 从 187 行降至 132 行，删除 `conversationOnly` / selectedEngine / busy / notice / apply / PATCH 和旧单选 UI；保留读取状态、严格 DTO、重复刷新保护、失败后待确认、关闭取消与焦点恢复。`StudioWorkspace.tsx` 移除模式参数；`agent-engine-settings.css` 删除 10 条专属选择器规则，现用对话框 / 工具目录样式不变。
- 测试迁移：旧 UI 切换断言退役，后端切换 / 冲突 / 任务保护测试保留；补充实际刷新失败恢复、只发 GET、并发去重、关闭取消和迟到结果不污染重开状态。`dsh-web/default-entry.test.tsx` 改为检查不可切换的设置组件，不再依赖已删除的模式标记；首次定向回归只因此标记断言失败，修正断言以检查真实只读边界后通过。
- 浏览器脚本：重用 `scripts/verify-dsh-settings-browser.mjs`，将旧真实 PATCH / 恢复原选择流程迁成实际 GET 加明确合成失败 / 不可用 / 挂起回执。仅隔离空浏览器，不打开用户项目；阻断设置写入、模型 / Notebook 执行、其他业务写入和外部访问。未批量删除其他验收脚本。
- 修改前基线 5 文件 72 项通过；修改后定向 4 文件 50 项、类型检查通过。完整测试、构建与本轮截图结果见下方。
- 修改前 5 份文件备份位于 `.runtime/lighten-20260927/second-batch-before/`，全部使用 `.before` 后缀避免被测试发现。已有未提交修改保留；没有修改依赖 / 锁文件、服务端选择 API、用户项目和数据格式。

### 第二批验证结果

- 基线：`pnpm exec vitest run components/studio/AgentEngineSettings.test.tsx core/bi/sync-engine.test.ts app/api/settings/agent-engine/route.test.ts core/agent-engines/server/selection.test.ts core/evaluation/harness-evaluation.test.ts --maxWorkers=2 --reporter=dot`，5 文件 72 项通过。评测中的脚本模型结果不代表真实模型质量。
- 定向回归：`pnpm exec vitest run components/studio/AgentEngineSettings.test.tsx app/api/settings/agent-engine/route.test.ts core/agent-engines/server/selection.test.ts components/studio/dsh-web/default-entry.test.tsx --maxWorkers=2 --reporter=dot`，4 文件 50 项通过；保留后端选择与任务保护测试。
- 全量：`npm test -- --maxWorkers=2 --reporter=dot`，280 文件 3,562 项通过；1 文件 3 项既有 EDS 实物测试因未提供工作簿路径跳过。随后 26 项 Node 工具测试通过。没有新增跳过或关闭检查。
- `npm run typecheck`、`npm run build` 通过；构建仍有已有的 chunk 超过 500 kB 提示。没有测量本批包体、启动时间或内存收益。
- 目标严格检查：`pnpm exec eslint components/studio/AgentEngineSettings.tsx components/studio/AgentEngineSettings.test.tsx components/studio/StudioWorkspace.tsx components/studio/dsh-web/default-entry.test.tsx scripts/verify-dsh-settings-browser.mjs --max-warnings=0` 通过。未运行全仓 lint。
- `npm run docs:agent:sync` / `npm run docs:agent:check` 通过（234 文件）；目标差异检查通过；源码、路由和脚本无被删除 BI / 评测 index 的残余引用。同步维护架构正文、变更记录及视觉规范。

### 第二批 3001 截图验收

`node scripts/verify-dsh-settings-browser.mjs` 最终通过。使用全新空浏览器存储，不打开用户项目；真实 GET 核对当前本机状态和插件目录，错误 / 不可用 / 等待状态明确由拦截回执制造。所有设置写入、模型与 Notebook 执行均阻断。验收前后服务端兼容选择仍为 `harness` / revision 0，当前网页固定 DSH 不受该兼容选择影响；插件目录和持久化说明未变。没有调用付费模型或真实数据库，组件可用不等于分析任务端到端成功。

7 张本轮图片已逐张实际查看；1440 / 1024 px 下文本、工具标签、错误和操作按钮可见，没有观察到横向溢出或遮挡。实际交互验证 Escape 取消、焦点回到工作区菜单，重开重新读取以及 Tab / Shift+Tab 对话框焦点约束。[机器报告](../../.runtime/dsh-settings-readonly-20260927/browser-1790513759948/report.json)无页面 / 路由错误或禁止请求。

| 截图 | 场景与结果 |
| --- | --- |
| [01 只读状态](../../.runtime/dsh-settings-readonly-20260927/browser-1790513759948/01-readonly-1440.png) | 实际 GET；DSH 状态和三组工具目录，无旧引擎单选和应用按钮 |
| [02 刷新失败](../../.runtime/dsh-settings-readonly-20260927/browser-1790513759948/02-failed-refresh-1440.png) | 合成 503；错误可见，旧可用状态标为待确认 |
| [03 恢复](../../.runtime/dsh-settings-readonly-20260927/browser-1790513759948/03-recovered-1024.png) | 再次真实 GET；清除错误，1024 px 完整显示 |
| [04 不可用](../../.runtime/dsh-settings-readonly-20260927/browser-1790513759948/04-unavailable-1024.png) | 合成不可用；说明原因，不提供自动回退或切换 |
| [05 等待可取消](../../.runtime/dsh-settings-readonly-20260927/browser-1790513759948/05-loading-cancellable-1024.png) | 挂起 GET；重复刷新禁用，关闭仍可用 |
| [06 取消返回](../../.runtime/dsh-settings-readonly-20260927/browser-1790513759948/06-cancelled-1024.png) | Escape 关闭等待态；工作台保留、焦点返回菜单 |
| [07 重开与焦点](../../.runtime/dsh-settings-readonly-20260927/browser-1790513759948/07-reopened-1024.png) | 新真实 GET；恢复当前状态，键盘焦点仍在对话框 |

脚本首次运行因旧菜单定位写法超时，修正为当前“设置与备份”分组选择器后整轮重跑通过；失败报告保留，不将首次运行计为通过。没有因此修改产品菜单或放宽边界断言。

### 第二批交付状态与保留项

当前分支 `feature/eds-analysis-dashboard`，既有未提交 / 未跟踪文件保留；本批源码已在 3001 验收，未发布 3000、更新便携包、提交或推送。起止 `site:status` 中稳定站、开发站和截图服务健康，进程与重启数未变；没有启停服务。

旧 Harness、后端引擎选择 API、旧规划 / 可视化实验 API、企业微信和云部署继续保留。其他历史脚本只在上一轮静态审查，本批未迁移或宣称它们已经通过。没有以测试通过替代真实模型、数据库、工作簿或草稿采用 / 看板确认的端到端验收。删除的 5 个文件可从 Git 恢复；本批没有删除用户数据。
