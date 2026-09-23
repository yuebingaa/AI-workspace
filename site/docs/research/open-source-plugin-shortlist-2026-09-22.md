# AgentCanvas 开源插件与组件候选清单

调研日期：2026-09-22。状态：**仅研究 / 文档，未安装、接入或发布候选组件**。

这里的“插件”包含可嵌入网站的 React / JavaScript 组件、独立后台服务和 MCP 工具。它们不是同一种安装方式。以下适配判断来自本项目当前源码、官方文档、许可证和公开包元数据；依赖声明匹配不等于已通过本站构建或运行验收。

**建议优先选择：Graphic Walker（拖拽分析）、AG Grid Community（结果表格）、react-markdown + remark-gfm（AI 回复排版）。** 若主要由 AI 操作、很少手改代码，CodeMirror 可以排在这三项之后。若主要目标是排查 Agent 失败，Langfuse 的优先级可以提高，但会增加后台部署。

## 1. 当前项目适合接在哪里

| 已核对的现状 | 对选型的影响 | 源码依据 |
| --- | --- | --- |
| React 19.2.6、TypeScript，Node 要求 >=22.13.0，使用 vinext / Vite；已有 Puck、Recharts | 优先嵌入组件；已有编辑器和图表基础，整体替换会扩大改造范围 | [package.json](../../package.json) |
| Notebook 代码编辑使用 textarea 加行号，展示高亮主要为简单 SQL 词法 | 成熟代码编辑器可以直接改善 Python / SQL 编辑 | [NotebookSource.tsx](../../components/studio/notebook/NotebookSource.tsx) |
| 结果表格使用 HTML table，已有当前预览排序、分页及 CSV 下载 | 新表格组件应保留完整性提示、类型和预览范围；虚拟滚动不能取回尚未返回的数据 | [NotebookResultTable.tsx](../../components/studio/notebook/NotebookResultTable.tsx) |
| 聊天回答直接放入段落；说明单元明确展示纯文本 | Markdown 渲染有明确使用场景；说明模板与运行结果仍需区分 | [AiBuilderAssistant.tsx](../../components/studio/AiBuilderAssistant.tsx)、[NotebookTextResult.tsx](../../components/studio/notebook/NotebookTextResult.tsx) |
| 已有 Data / SQL / Python / 表图、显式 DAG、结果证据及草稿采用 | 可增加展示和工具适配，沿用现有执行、授权与采用流程 | [graph.ts](../../core/notebook/graph.ts)、[架构](../architecture/agent-architecture.md) |
| 语义模型绑定单一 Dataset，提供维度和六类固定聚合；当前查询契约没有跨表 Join 或计算指标表达式 | Cube 属于后续语义能力扩展，需要服务与数据映射；不是直接导入现有 JSON 就能替换 | [semantic/contracts.ts](../../core/semantic/contracts.ts) |
| Python 为固定资源的 Pyodide 沙箱，禁止运行时联网装包 | Python 库先评估 WASM 依赖和资源锁；不能照普通服务器教程直接 pip 安装 | [Python Runtime](../python-runtime.md) |
| 已有只读 PostgreSQL / Databricks 驱动与 EDS 专用 XLSX 导出 | 不重复推荐“再装 SQL / pandas”；导出增强要先确认现有实现的不足 | [连接驱动](../../core/connections/server/query.ts)、[EDS 导出](../../core/eds/server/workbook.ts) |
| 原 Harness 有受控 MCP 配置；DSH 网站 profile 禁用任意外部 MCP；设置页插件目录是固定目录 | 外部 MCP 与网站组件分开评估；当前没有通用的一键插件安装机制 | [MCP 契约](../../core/harness/mcp/contracts.ts)、[架构中的 DSH 边界](../architecture/agent-architecture.md) |

本次研究以当前源码为准，没有复验 3000 / 3001 的运行或发布状态。工作区有其他会话的未提交修改，本轮仅新增研究文档和本机研究记录。

## 2. 八个重点候选

难度是对本站接入工作的相对估计：低为局部显示适配；中涉及状态、字段或持久化适配；高涉及新的服务、数据契约或后台执行流程。不是工期承诺。

| 候选与官方来源 | 用户能得到什么 | 与本站的接法 | 难度 / 建议 | 开源范围 |
| --- | --- | --- | --- | --- |
| [Graphic Walker](https://github.com/Kanaries/graphic-walker) | 拖拽维度、指标、颜色、筛选来探索数据，减少反复让 AI 改图 | 增加数据探索面板，读取授权 Dataset 或完整查询结果；逐步映射语义口径和保存图表 | 中高；最贴近当前想要的交互式分析方向 | Apache-2.0；Logo 另有 LICENSE2 |
| [AG Grid Community](https://www.ag-grid.com/react-data-grid/community-vs-enterprise/) | 更完整的结果表格，支持筛选、排序、分页和行列虚拟滚动 | 优先适配 NotebookResultTable 的只读结果预览 | 中；优先 | Community 为 MIT；Enterprise 单独商业许可 |
| [react-markdown](https://github.com/remarkjs/react-markdown) + [remark-gfm](https://github.com/remarkjs/remark-gfm) | AI 回答中的标题、表格、列表、代码块按格式显示 | 先接聊天回答，再独立评估说明单元 | 低；优先 | 两者均 MIT |
| [CodeMirror 6](https://github.com/codemirror/lang-sql) | 更好的 SQL / Python 代码编辑；SQL 可接字段和表名补全 | 封装现有 NotebookCodeEditor，保留 value/onChange 与保存、运行行为 | 中；经常手改代码时优先 | MIT；官方已迁移源码托管 |
| [React Flow](https://github.com/xyflow/xyflow) | 看清“导入 → 清洗 → SQL → 图表”的依赖关系，点击节点定位单元 | 直接投影已有 Cell ID 和依赖关系，第一阶段只读 | 中；Notebook 较复杂时有价值 | 核心 MIT；Pro 示例与支持单独提供 |
| [Langfuse](https://langfuse.com/docs) | 集中查看模型与工具的耗时、错误、会话和可获得的用量数据 | 在 Harness / DSH 事件适配与可信模型边界增加 OpenTelemetry 观测 | 中高；重视排障时考虑 | 核心 MIT；EE 目录另有许可 |
| [Cube Core](https://github.com/cube-js/cube) | 数据库上的跨表维度、指标、关系和统一查询接口 | 独立语义服务；增加连接、模型映射和授权适配 | 高；接多张业务数据库表时再优先 | 后端 Apache-2.0，客户端 MIT；商业 Cube 产品另计 |
| [BullMQ](https://github.com/taskforcesh/bullmq) | 定时刷新、后台报表任务、任务重试与排队 | 常驻 Worker 调用受控分析入口，保存任务和产物 | 高；准备自动更新 BI 时考虑 | 核心 MIT；Pro 功能另计 |

### 2.1 Graphic Walker：交互式探索

官方提供 React 组件、中文界面，以及自定义 `computation` 查询接口，允许接自己的计算服务。[官方说明](https://github.com/Kanaries/graphic-walker)

对我们的 EDS 场景，可让用户拖动线体、设备、报警类型与报警时长形成视图。首个试验宜限定为一个已授权 Dataset 的独立探索面板。对完整源表才能做全量聚合；只收到部分结果时必须标明范围。对已经聚合的语义结果，也不能任意重复平均或重新计数。

保存图表涉及本项目的版本化定义与渲染适配。Graphic Walker 的图表配置不能直接当成现有 Recharts / AppSpec 配置。语义指标锁定、完整数据查询、中文样式和图表保存都属于适配工作。可以先复用现有 AI，让该组件负责拖拽和展示。

本次 npm 元数据显示 `0.5.2` 要求 React / React DOM >=19，并列出 styled-components peer；与本站 React 主版本相容，但尚未安装验证。项目的品牌资源另有 [LICENSE2](https://github.com/Kanaries/graphic-walker/blob/main/LICENSE2)，不能将代码许可自动套用到 Logo。

### 2.2 AG Grid Community：结果表格

社区版提供基本排序、筛选、分页和虚拟滚动。内置透视、分组、Excel 导出及高级剪贴板等属于 Enterprise 范围，本次建议以社区版功能设计。[官方功能对照](https://www.ag-grid.com/react-data-grid/community-vs-enterprise/)

先替换结果预览的展示层，保留本项目 NULL、字符串大整数、结果完整性和当前预览 CSV 的语义。单元编辑、全量服务端排序和远端分页不能随表格更换自动开放。虚拟滚动改善已加载数据的显示效率，不改变当前查询上限。

### 2.3 Markdown 回复：小范围提升可读性

react-markdown 将 Markdown 解析为 React 元素，remark-gfm 增加表格、任务列表等扩展。[react-markdown](https://github.com/remarkjs/react-markdown)、[remark-gfm](https://github.com/remarkjs/remark-gfm)

本站回答目前在 `AiBuilderAssistant.tsx` 直接渲染 `turn.response`，因此适配位置清楚。第一阶段仅处理回答排版和代码块显示，使用现有浅色风格；原始 HTML、脚本和任意组件不作为答案执行。说明单元需另行处理“未运行模板”和“本次结果”的显示差别。该组件改善阅读体验，不改变模型推理与结果验收。

### 2.4 CodeMirror：SQL / Python 编辑

SQL 扩展支持关键词及基于 Schema 的补全，Python 扩展提供对应语言支持。[SQL 扩展](https://github.com/codemirror/lang-sql)、[Python 扩展](https://github.com/codemirror/lang-python)

可复用当前上游表字段、连接目录的已授权元数据提供 SQL 补全。语言高亮和补全不等于数据库校验或 Python 运行时类型推断，执行仍交给原链路。适配需要保留中文输入、键盘操作、只读差异展示、长度限制与草稿保存。

维护信号需要特别说明：GitHub 仓库已归档，并明确标注迁移至维护者新站；不能据此直接判断项目停更。本次新站和文档站抓取返回 403，功能与许可核对使用迁移前官方仓库及公开 npm 元数据，未独立验证新站最近提交。[迁移说明](https://github.com/codemirror/dev)

### 2.5 React Flow：依赖关系可视化

该库提供 React 节点与连线界面，核心 MIT。[官方仓库](https://github.com/xyflow/xyflow)

本站 `graph.ts` 已有直接依赖、拓扑运行与下游影响分析，可直接投影为只读图，用颜色显示成功、失败和失效。第一阶段点击节点定位已有单元，不增加另一套调度器。未来若允许拖线修改依赖，仍须经过当前 Schema、无环检查、版本与草稿采用流程。

### 2.6 Langfuse：Agent 运行观测

它支持 JS / Python SDK 和 OpenTelemetry，可展示模型、工具、会话及耗时；适合查看失败发生在哪一步。[官方文档](https://langfuse.com/docs)

本站已经有事件和验证记录，应在可信事件边界建立对应关系，而不是让模型自己填写成功状态。首阶段仅发送必要的运行标识、耗时和安全错误码；敏感正文与原始数据是否记录应单独配置。缺失的 Token / 费用不能由观测工具补造成真实账单，模型回答也不会因接入观测平台自动更准确。

自托管需要 Web / Worker、PostgreSQL、ClickHouse、Redis/Valkey 和对象存储，明显比一个前端组件重；本机方案还需安排服务管理和端口。[部署组成](https://langfuse.com/self-hosting)。核心与企业目录的许可不同。[许可证](https://github.com/langfuse/langfuse/blob/main/LICENSE)

### 2.7 Cube Core：数据库语义层

Cube Core 支持定义维度、指标、关联和访问规则，并通过 API 供下游使用。它是独立服务，商业 Cube 产品的完整 BI 界面不包含在这个开源接入建议里。[官方仓库](https://github.com/cube-js/cube)

适合未来连接多张订单、设备、工站等业务表后统一统计口径。对当前 Excel 单表流程，先用已有语义模型更直接。接入需处理本地 Dataset 如何进入受支持的数据源、模型 ID 与版本、关联重复计数、凭据、权限和缓存刷新。不能把现有单表模型 JSON 直接复制为 Cube 模型。

### 2.8 BullMQ：定时与后台任务

支持后台队列与按间隔或 Cron 规则产生任务。[官方仓库](https://github.com/taskforcesh/bullmq)、[Job Schedulers](https://docs.bullmq.io/guide/job-schedulers/)

例如“每天早上重新计算 EDS 日报”，由 Worker 执行已保存的分析定义。仍需持久化任务、运行版本、权限、输出、失败与取消；不能只在浏览器放一个定时器。调度本身不等于数据源实时同步，实时刷新还需要增量来源或事件触发。

部署需队列存储和常驻 Worker。可按 Redis/Valkey 路线评估；本次还看到新版仓库提供 PostgreSQL 相关适配，但没有运行验收。已有的只读业务数据库账户不能当任务队列的写入账户。

## 3. 三个备选，暂不列为优先接入

| 备选 | 可解决的问题 | 暂缓理由 | 官方来源 |
| --- | --- | --- | --- |
| ExcelJS（MIT） | 更一般的 XLSX 样式、工作表和单元格读写 | 已有 EDS XLSX 导出和 write-excel-file；本次 npm latest 为 2023-10 发布的 4.4.0，仓库 pushed_at 为 2025-01。先明确现有功能缺口；它不负责计算公式结果，也不能承诺任意复杂模板无损往返 | [仓库](https://github.com/exceljs/exceljs)、[公式限制](https://github.com/exceljs/exceljs#formula-value) |
| Pandera（MIT） | 检查字段类型、空值、唯一性、数值范围及自定义数据规则 | 适合 EDS 导入质量检查，但当前锁定的 Pyodide 没有该包；必须验证整个依赖链的 WASM 兼容、资源锁和 pandas 版本，或另设后端服务。少量规则可先复用现有校验，不为此直接改运行环境 | [官方仓库](https://github.com/unionai-oss/pandera) |
| AntV MCP Server Chart（MIT） | Agent 调用工具生成更多图表类型 | 当前 DSH 不开放外部 MCP；返回图表产物还需接项目保存与来源记录。官方默认使用外部图表服务，私有部署需另配渲染服务；仅本机运行 MCP 进程不代表数据留在本机 | [官方说明与部署](https://github.com/antvis/mcp-server-chart) |

如果选择 AntV 路线，还需锁定和审查实际版本；本次读取的官方组织页披露过 2026-05 的包供应链事件。这里保留官方事实，不据此断言当前版本仍受影响，也未做本次依赖审计。[官方组织公告](https://github.com/antvis)

## 4. 如何按当前目标选择

| 当前最想改善什么 | 先看哪个 | 首个可验收结果 |
| --- | --- | --- |
| 更接近 Hex 的数据探索体验 | Graphic Walker | 用一份隔离合成表拖拽生成图表，核对其数值与原 SQL 聚合一致 |
| 看明细表方便，筛选和滚动顺畅 | AG Grid Community | 同一结果预览的排序、筛选、NULL / 精度与完整性提示保持正确 |
| AI 回答更易读 | react-markdown + remark-gfm | 回答中的表格、列表、代码块清楚显示；失败提示和旧对话仍正常 |
| 经常人工修改 SQL / Python | CodeMirror | 中文输入、字段补全、保存后实际执行及失败回执均正常 |
| Notebook 多步骤看不清 | React Flow | 图中每条边对应真实显式依赖，节点可定位原单元 |
| 经常排查 Agent 调用失败 | Langfuse | 一次隔离任务的模型 / 工具 / 验证事件可关联，耗时与原事件一致 |
| 跨多个数据库业务表建立指标 | Cube Core | 一个受控关联指标与独立 SQL 结果一致，原权限保持 |
| 每天 / 每小时自动更新分析 | BullMQ | 重复调度不重复交付，失败可见，停止浏览器后任务仍由后台管理 |

这些是候选接入后的验收目标，不是本次已经完成的测试。

## 5. 版本与维护信息快照

以下是本次公开 npm Registry 的 latest 标记及 peer 声明，仅作初筛；没有写入项目依赖锁。上游默认分支与已发布包可能不同，最终接入应以选定发布包核对。

| 包 | 本次查询版本 / 发布时间（UTC） | 与本站相关的声明 |
| --- | --- | --- |
| `@kanaries/graphic-walker` | 0.5.2 / 2026-07-12 | React、React DOM >=19；styled-components ^6.1.19 |
| `ag-grid-react` | 36.2.0 / 2026-09-16 | peer 范围包含 React 19；社区包与企业包分开 |
| `react-markdown` | 10.1.0 / 2025-03-07 | React 与 @types/react >=18 |
| `remark-gfm` | 4.0.1 / 2025-02-10 | MIT；作为 Markdown 插件使用 |
| `@xyflow/react` | 12.11.6 / 2026-09-01 | React / React DOM >=17 |
| `codemirror` | 6.0.2 / 2025-06-19 | 核心 MIT；SQL / Python 支持分包 |
| `@codemirror/lang-sql` | 6.10.0 / 2025-09-16 | MIT |
| `@codemirror/lang-python` | 6.2.1 / 2025-05-14 | MIT |
| `exceljs` | 4.4.0 / 2023-10-19 | MIT；发布时间较早 |
| `bullmq` | 6.3.8 / 2026-09-18 | MIT；存储适配和 Worker 仍需单独配置 |

来源为各包公开 Registry 元数据，例如 [Graphic Walker](https://registry.npmjs.org/@kanaries%2Fgraphic-walker)、[AG Grid React](https://registry.npmjs.org/ag-grid-react)、[Markdown](https://registry.npmjs.org/react-markdown)、[CodeMirror](https://registry.npmjs.org/codemirror)、[ExcelJS](https://registry.npmjs.org/exceljs)、[BullMQ](https://registry.npmjs.org/bullmq)。本机完整摘录见 `site/.runtime/open-source-plugin-research-2026-09-22/public-metadata.json`。

本次 GitHub API 返回的仓库状态：除明确迁移的 CodeMirror GitHub 仓库外，核对的其余候选未归档。推送时间只作为维护信号，不证明可用性或安全性；许可证 `NOASSERTION` 的混合仓库已进一步核对官方许可说明，未当作“全部 MIT”。

## 6. 本次核对范围

- 已执行：阅读项目运行约定、近期任务、架构和相关实现；核对组件接入位置、原 Harness / DSH 边界、Python 包限制；检索官方项目、文档和许可证；只读查询公开 GitHub / npm 元数据。
- 未执行：安装依赖、连接外部插件、运行付费模型、启动候选服务、修改功能代码、构建、测试、浏览器性能或截图验收。研究阶段没有实现变更，不以旧测试或官方演示作为本站可用证明。
- 本次交付：此清单、公开元数据摘录和根任务日志。当前架构实现没有调整，无需重写架构正文或同步源码指纹；后续实际接入再按项目约定维护。
