# Notebook 成熟组件与当前实现对比

日期：2026-09-27。依据当前工作区源码及官方资料；仅调研，没有安装或接入候选组件，也没有进行第三方组件的兼容性、性能或视觉实测。下面的适配成本和推荐顺序属于结合本项目代码作出的工程判断。

阅读范围：前半部分以“保持当前文档、执行与业务兼容”为前提；随后根据用户提出的 Hex 目标逐步补充。若接受更换 Notebook 文档和执行体系，应以末节“采用 marimo 再定制为 Hex 风格的路线评估”为准：此时 marimo 值得优先试点，不能沿用局部组件替换的成本结论。

有成熟方案可以复用。当前更合适的方向是保留 Notebook 文档、执行和业务流程，逐步替换代码编辑、结果表格和说明编辑等界面组件。整套 Notebook 迁移应由标准 Jupyter 文件互通、多内核或独立 Python 开发环境等明确需求驱动。

## 当前实现

| 层次 | 源码证据 | 已有能力与边界 |
| --- | --- | --- |
| 单元模型 | [cell-catalog.ts](../../core/notebook/cell-catalog.ts)、[definition.ts](../../core/notebook/definition.ts) | 10 类结构化单元：数据、SQL、Python、数据库 SQL、语义查询、处理配方、表格、图表、说明、参数；当前文档上限 30 个单元 |
| 代码编辑 | [NotebookSource.tsx](../../components/studio/notebook/NotebookSource.tsx) | 输入为 textarea 加行号；只读展示用正则着色，没有接入专业代码编辑器的补全、折叠和语言诊断 |
| 说明编辑 | [NotebookTextEditor.tsx](../../components/studio/notebook/NotebookTextEditor.tsx)、[NotebookTextResult.tsx](../../components/studio/notebook/NotebookTextResult.tsx) | 字段名虽为 markdown，当前按纯文本展示；支持经过执行回执校验的数据占位引用，没有所见即所得富文本 |
| 结果表格 | [NotebookResultTable.tsx](../../components/studio/notebook/NotebookResultTable.tsx) | 已有预览内排序、分页、NULL 展示、范围说明和 CSV 导出；当前没有列筛选、显隐、拖动列宽等通用数据表能力 |
| 执行与结果 | [graph.ts](../../core/notebook/graph.ts)、[execution-contracts.ts](../../core/notebook/execution-contracts.ts)、[result-availability.ts](../../core/notebook/result-availability.ts) | 显式依赖图、独立执行端口、结果完整性与来源信息；这些规则不能通过替换编辑器自动获得 |
| 工作流 | [NotebookPanel.tsx](../../components/studio/notebook/NotebookPanel.tsx)、[ai-run-scheduler.ts](../../components/studio/notebook/ai-run-scheduler.ts) | 参数重算、AI 草稿隔离预览、确认 / 撤销、保存 Dataset、看板衔接已接线；面板仍集中持有较多编辑、运行和预览状态 |

我们的通用编辑能力确实还有差距，已有投入主要体现在项目数据、语义模型、受控执行和 AI 采用流程。没有跨产品实测，不能据此声称整体性能、稳定性或功能完整度优于成熟产品。

## 候选方案

| 方案 | 可以提供什么 | 与当前项目的关系 | 建议 |
| --- | --- | --- | --- |
| CodeMirror 6 | 专业代码编辑组件，支持语法高亮、搜索替换、折叠、撤销及可扩展补全 | 可以集中替换 `NotebookCodeEditor`，继续输出 SQL / Python / JSON 字符串 | 优先试点，切入面较小 |
| TanStack Table | 无预设样式的表格状态与处理逻辑，支持排序、筛选、分页、列宽和显隐等 | 用于结果表格；仍需接入我们自己的样式、完整性说明、NULL 规则和预览导出 | 第二优先，已有排序 / 导出不能丢失 |
| BlockNote | React 块式富文本编辑器，提供拖动、菜单、自定义块和协作接口 | 能改善分析说明的撰写；并不提供我们所需的 SQL / Python 执行与结果回执 | 有富文本需求时局部使用，先解决旧纯文本与动态引用的转换 |
| JupyterLab 生态 / Datalayer Jupyter UI | Jupyter Notebook、独立 Cell、输出展示与内核管理等 React 封装 | 最接近“整套现成 Notebook”；围绕 Jupyter 文档和内核协议，不能直接消费我们的 10 类单元与运行回执 | 有 `.ipynb` 互通或 Jupyter 生态需求时做隔离概念验证 |
| marimo | Python / SQL Notebook、基于代码引用的依赖分析与响应式执行，可部署或嵌入 | 与我们的依赖驱动分析有相似处，但有自己的文档与运行模型；不是直接替换 JSX 的界面包 | 适合参考交互、评估独立分析环境，不作为当前低成本替换项 |

以上能力分别核对了 [CodeMirror 基础编辑器](https://codemirror.net/examples/basic/)与[补全接口](https://codemirror.net/examples/autocompletion/)、[TanStack Table](https://tanstack.com/table/v9)、[BlockNote 自定义块](https://www.blocknotejs.org/docs/features/custom-schemas/custom-blocks)、[Datalayer Jupyter UI](https://github.com/datalayer/jupyter-ui)、[marimo 响应式执行](https://docs.marimo.io/guides/reactivity/)与[SQL](https://docs.marimo.io/guides/working_with_data/sql/)。

选择时有几个具体差异：

- CodeMirror 提供补全扩展接口，但不会自动理解我们项目里的表、字段、参数和 Python 环境；这些信息需要适配器提供。编辑器诊断也不能代替服务端校验。
- TanStack Table 是表格逻辑库，需要组装界面。给当前已返回的预览增加筛选，不等于对数据库完整结果筛选；改变这层语义需要另外设计查询接口。
- BlockNote 支持 React 自定义块，但不应把整个 `NotebookDocument` 和执行结果复制成第二份编辑器文档。其核心与 XL 扩展采用不同许可，若要采用 AI / 导出等 XL 功能应按实际包确认；本轮不涉及购买。[官方说明](https://www.blocknotejs.org/pricing)
- Jupyter 生态的成熟度与 Datalayer 这个封装的项目规模、兼容性应分开评估。其官方组件文档展示服务器连接与浏览器内核两种方式，README 的旧段落与功能列表仍存在描述差异，因此不能将文档示例当成我们 React 19 / Vinext / 离线便携环境已验证兼容。[Notebook 组件文档](https://jupyter-ui.datalayer.tech/docs/components/notebook/)
- marimo 支持浏览器 WebAssembly 运行和网页嵌入，但这仍然是接入另一套 Notebook 系统，不等于复用我们现有执行 API。[WebAssembly 说明](https://docs.marimo.io/guides/wasm/)

## 与解耦工作的结合

建议以现有领域模型作为唯一文档来源，让可替换界面组件只接收值、只读状态和变更回调。第一步可围绕当前 `NotebookCodeEditor` 建立清晰边界，再接入 CodeMirror；随后将 `NotebookPanel` 中的编辑会话、运行控制与草稿预览状态整理为独立控制模块。上述是建议，尚未实施。

未来接入时应实际验证中文输入、撤销与外部更新、切换单元、只读 / 运行锁、取消编辑、SQL / Python / JSON 三种模式及窄屏；表格替换还须保留预览范围和完整性语义。只有在真实负载下测量后，才评价包体、加载和运行性能。本轮没有新的用户可见功能，未做浏览器截图或收费模型 / 数据库验收。

## 对照用户提供的 Hex 截图

2026-09-27 补充。两张图片作为目标界面参考，不作为本项目开发站验收证据。比较对象是界面结构和分析工作方式，不推断 Hex 实际使用的第三方组件。

现成完整方案中，marimo 的 SQL / Python 单元、交互式数据表和可视化分析方式更值得作为 Hex 的近似参照。这是基于功能与交互结构的判断，不是视觉一致性或迁移兼容性的实测排名。其表格支持分页、搜索、排序、筛选，并有 GUI chart builder；后者可生成 Python 代码，与 Hex 的图表单元配置机制并不相同。[marimo 数据表与图表构建器](https://docs.marimo.io/guides/working_with_data/dataframes/)

若目标是在当前项目中接近两张图的具体体验，建议继续使用现有 Notebook 文档 / 执行层，组合成熟的代码和表格组件，并补齐图表配置与变更审阅：

| 截图中的体验 | 建议实现归属 | 当前差距 |
| --- | --- | --- |
| 图 2：SQL 编辑与增删行高亮 | CodeMirror 6 与 merge 扩展，外层接现有草稿审阅 | 当前代码输入是 textarea；已有独立源码差异展示，尚未形成单元内一致的编辑 / diff 体验 |
| 图 2：代码下方的结果表格与工具栏 | TanStack Table 加本项目样式 / 结果规则 | 已有排序、分页和 CSV；列配置、筛选及工具栏布局还需完善 |
| 图 1：字段列表、X / Y 轴、系列、Data / Style 配置和图表预览 | 独立图表配置面板，加领域配置与绘图适配 | 当前仅有分类字段和最多 4 个数值字段；Notebook 图表契约没有按分类字段拆分系列、堆叠、分面等配置，不能只改 CSS 或加一个图表组件 |
| 两图：右侧 AI 与待确认修改 | 保留当前 AI 工作区和草稿执行流程，整理呈现与交互 | 已有运行后预览、整稿确认 / 撤销；Hex 按单元审阅的方式需要补充依赖一致性和部分采用规则 |

CodeMirror 的 [merge 接口](https://codemirror.net/docs/ref/#merge)只解决文本差异展示与编辑，不能代替业务草稿的确认和回执校验。Hex 官方文档明确其 [Notebook agent](https://learn.hex.tech/docs/explore-data/notebook-view/notebook-agent)按单元管理待确认修改；其 [Chart cells](https://learn.hex.tech/docs/explore-data/cells/visualization-cells/chart-cells)还包含系列、轴、样式及交互等能力。当前 [NotebookDraftReview.tsx](../../components/studio/notebook/NotebookDraftReview.tsx)采用整稿回调，[NotebookChart.tsx](../../components/studio/notebook/NotebookChart.tsx)使用 Recharts 绘制现有受限配置；本次没有修改这些实现。

Datalayer Jupyter UI 更适合需要 Jupyter 文档 / 内核的组件化接入，其代码单元与输出结构可以参考图 2；不能据此视为已经具备图 1 的 Hex 图表编辑面板。BlockNote 更适合局部说明编辑，不作为复现两图的主要 Notebook 框架。最终建议是优先对齐单元布局、编辑器 / 结果表、图表配置和 AI 审阅四个界面边界；marimo 作为完整产品参照，尚不据此决定替换执行体系。

## 执行机制的比较范围与说明

2026-09-27 补充。“执行机制不完全相同”的表述需要区分比较对象：marimo 与 Hex 的核心思路相近，都根据代码中的变量引用建立单元依赖图，并支持依赖驱动的下游重算，不能将 Hex 描述为普通的手动顺序执行 Notebook。marimo 可配置为延迟运行、标记过期；Hex 也有 Auto 与 Cell only 等运行方式。[marimo 执行说明](https://docs.marimo.io/guides/reactivity/)、[Hex 执行模型](https://learn.hex.tech/docs/explore-data/projects/project-execution/execution-model)、[Hex SQL 运行方式](https://learn.hex.tech/docs/explore-data/cells/sql-cells/sql-cells-introduction)

二者的具体运行接口和 SQL 组织方式不同。marimo 的 SQL 单元在底层通过 Python `mo.sql` 表达，并可查询 DataFrame 或数据库；Hex 对 SQL 单元提供仓库查询、结果缓存及符合依赖条件的并行调度。这里是在说明它们分别公开的组织方式，不表示 marimo 没有数据库连接或任何并发 / 缓存能力，也不表示其计算正确性低于 Hex。[marimo SQL](https://docs.marimo.io/guides/working_with_data/sql/)、[Hex 执行指南](https://learn.hex.tech/tutorials/develop-notebooks/project-execution-guide)

当前项目与二者相比，已经有依赖图，但依赖来自单元定义中的 `inputCellIds`、`inputCellId` 和说明引用，而不是扫描任意 Python / SQL 代码自动推导。用户或 AI 创建单元时同时生成这些关系；仅在代码文本中增加一个变量名不会自动登记新依赖。运行时按单元类型分派到数据、SQL、Python、配方、语义等端口；Python 每个单元构建自己的执行命名空间，输入输出通过声明的 DataFrame 传递。[graph.ts](../../core/notebook/graph.ts)、[execution.ts](../../core/notebook/server/execution.ts)、[python-program.ts](../../core/notebook/server/python-program.ts)

例如“地区参数 → SQL 汇总 → 图表”：我们开启参数自动运行后也能触发相关步骤重算，但它是参数值变更的专门调度；普通代码保存、结构编辑不会自动套用同一规则。AI 新草稿另有一次性预览运行流程。当前参数重算还会补齐所需上游，在新运行中执行选定子图，不把浏览器缓存结果直接作为计算输入。[parameter-recompute.ts](../../core/notebook/parameter-recompute.ts)

因此，执行差异是整套接入时需要适配和验证的工程范围，不是足以单独否定 marimo 的理由。只替换代码编辑、结果表格和布局，可以继续保留当前执行接口；是否转向自动依赖分析或完整 marimo 应另作取舍。本次只补充解释，没有修改架构实现。

## 实现 Hex 同类 SQL 执行能力的可行性

2026-09-27 补充。可以依据公开行为实现同类能力，当前项目已有部分基础；本段是源码核查后的范围判断与实施建议，不是已完成的迁移、性能承诺或 Hex 内部实现说明。

| 能力 | 当前源码 | 需要补齐的工作 |
| --- | --- | --- |
| SQL 单元 | 已有本地 DuckDB `sql` 和外部连接 `warehouseSql` 两种单元，可返回表格并供后续展示 / 计算使用 | 完善编辑体验、参数与依赖处理、查询输出模式；保持现有只读约束 |
| 仓库查询 | 已有 PostgreSQL 与 Databricks 驱动、Schema 检查、项目 / AI 访问范围与超时取消 | 按实际需求新增 Snowflake 等驱动；当前不宣称本次实库验证或已覆盖 Hex 的连接器集合 |
| 查询缓存 | `result-cache.ts` 保留客户端结果与失效证据；重新执行走实际查询；`result-capture.ts` 仅捕获本次完整结果用于保存 | 新增服务端可复用查询结果、有效期、强制刷新和缓存命中状态；不能将浏览器预览直接升级为计算输入 |
| 并行调度 | 已有 DAG 与拓扑顺序；`execution.ts` 在循环中逐个等待单元；底层 SQL 服务已有并发上限 | 增加就绪队列，在依赖成功后限量调度独立只读查询；正确处理排队、取消、下游阻断与稳定回执顺序 |
| 链式仓库 SQL | 当前 warehouseSql 未定义上游查询依赖 / Query 对象；主要返回有界表格结果 | 引入查询引用并编译成同连接、兼容方言的 CTE，让下游在仓库计算完整结果；区别完整数据、预览与延迟查询 |

当前证据：[query-engine.ts](../../core/notebook/server/query-engine.ts)、[query-service.ts](../../core/connections/server/query-service.ts)、[连接契约](../../core/connections/contracts.ts)、[客户端结果缓存](../../core/notebook/result-cache.ts)、[结果捕获](../../core/notebook/server/result-capture.ts)、[Notebook 执行](../../core/notebook/server/execution.ts)。底层允许多个请求同时运行，不等于已经具备单份 Notebook 的并行调度。

Hex 的公开行为包括近期仓库 SQL 结果复用、有效期与强制刷新，以及满足依赖条件后的 SQL 并行执行；它的 chained SQL 将上游 SQL 作为 CTE 编入下游，Query 模式允许预览只取部分行、下游仍计算完整查询。这些机制都有明确可实现的组成部分。[查询缓存](https://learn.hex.tech/docs/explore-data/cells/sql-cells/query-caching)、[执行模型](https://learn.hex.tech/docs/explore-data/projects/project-execution/execution-model)、[SQL 输出与链式查询](https://learn.hex.tech/docs/explore-data/cells/sql-cells/sql-cells-introduction)

建议按以下边界逐步实施，均为待实现内容：

1. 先整理现有执行器，将运行计划、单元执行、结果回执组装分开；维持串行行为，建立能够比较原行为的回归。
2. 接入有界并行调度：先只调度独立 SQL 分支，共用连接服务资源限制；Python 会话暂按自身约束串行，不能把整个循环直接替换成无限制 Promise.all。
3. 增加独立缓存端口与策略：按项目 / 权限范围、连接配置身份、SQL / 参数和输入内容版本区分结果；保存完整性信息，每次读取继续验证访问资格。外部数据库的内容变化无法仅靠 SQL 指纹推断，需要有效期、可用的数据版本或显式刷新；动态查询也需明确缓存策略。第一批宜限定范围，不直接开启跨项目共享或缓存任意 Python 副作用。
4. 再实现链式 SQL / Query 模式和依赖分析，使筛选聚合能够留在仓库。该阶段会影响单元契约、结果类型与图表数据访问，不能只改显示层。

验收目标应具体到：独立查询确实重叠执行；未就绪下游不运行；重复有效查询命中缓存且不再请求数据库；刷新、SQL / 参数 / 连接身份变化与过期按策略重新查询；失败 / 取消不产生成功缓存；只取预览仍能对完整结果正确聚合。随后在 3001 使用隔离项目验收命中 / 刷新、并行、失败与取消状态并保留实际查看的截图。本轮没有运行这些未来验收，也未估算未测量的加速倍数或交付工期。

## 采用 marimo 再定制为 Hex 风格的路线评估

2026-09-27 补充。若目标转为尽快获得成熟的 SQL / Python 分析工作台，并且接受 marimo 的文档和执行模型，优先试点 marimo 比继续补齐全部 Notebook 基础设施更有吸引力。这是基于可复用范围的工程判断，尚未通过迁移原型测量工期。前文倾向局部组件替换，前提是保留当前接口与业务行为；两个目标的成本不能混为一谈。

marimo 已提供代码编辑、静态依赖分析与响应式执行、SQL / Python、交互表格和图表构建器。采用完整系统能复用这些能力，也意味着接受其变量规则和以 Python 文件表达 Notebook 的方式。[执行与依赖](https://docs.marimo.io/guides/reactivity/)、[SQL](https://docs.marimo.io/guides/working_with_data/sql/)、[数据表与图表构建器](https://docs.marimo.io/guides/working_with_data/dataframes/)

| 采用方式 | 速度判断 | 主要剩余工作 |
| --- | --- | --- |
| 采用完整 marimo，先保留大部分原有交互 | 最可能缩短获得成熟 Notebook 的时间 | 项目入口、保存、数据连接与部署适配 |
| 采用 marimo，再调整色彩、间距和局部布局 | 可以兼顾复用与 Hex 风格，值得试点 | 主题覆盖范围、宿主布局与升级兼容验证 |
| 深改 marimo，实现截图中的图表配置和逐单元 AI 审阅 | 不一定比定制现有系统更省事 | 功能与协议开发、编辑器修改、持续合并上游变化 |
| 保留现有全部内部契约，只抽取 marimo 编辑器或执行器 | 不能按现成组件接入估算 | 双方文档、事件、会话与运行状态的适配，容易重复维护两套模型 |

主题定制与工作流定制要分开估算。官方支持自定义 CSS，但只将少数字体变量列为稳定公共接口，其他类名 / 变量不保证跨版本稳定；自定义 UI 插件文档介绍的是通过 anywidget 接入响应式引擎，不能据此推断存在完整编辑器布局插件接口。核查时主分支前端包仅声明 `./unstable_internal/*` 子路径导出，也不能将它视为已验证、可直接放进本项目的稳定 React Notebook 组件。[主题文档](https://docs.marimo.io/guides/configuration/theming/)、[自定义 UI 插件](https://docs.marimo.io/guides/integrating_with_marimo/custom_ui_plugins/)、[前端包源码](https://github.com/marimo-team/marimo/blob/main/frontend/package.json)

结合本项目，迁移成本主要落在四处：

1. **文档与保存**：当前是 10 类结构化单元、显式输入引用、revision 与项目备份；marimo 以 Python 文档表达单元。需要确定新 Notebook 的唯一权威格式、保存 / 重开和旧文档迁移边界，而不是长期让两套文档互相覆盖。[当前单元定义](../../core/notebook/definition.ts)、[项目存储](../../core/repository/studio-repository.ts)
2. **Agent 与运行结果**：当前 DSH 工具负责搜索、编辑、运行及提交经过验证的草稿，另有整体确认 / 撤销与执行回执。marimo 的 AI 工具可以作为接入起点，但不直接满足本项目协议；其工具页仍标为实验性，并且总说明与编辑小节对 MCP 暴露范围的描述不一致，必须按选定版本实际验证读、改、执行和审阅通路。[当前工具桥](../../core/harness/server/notebook-tool-bridge.ts)、[marimo AI 工具](https://docs.marimo.io/guides/editor_features/tools/)
3. **业务结果衔接**：语义查询、项目数据访问、保存 Dataset 和生成看板属于当前应用能力，需要明确保留的适配层。marimo 的图表 / 应用发布不能自动替代本项目的看板变更与确认流程。[Notebook 看板转换](../../core/notebook/dashboard.ts)
4. **运行与分发**：当前 Python 通过服务器管理的独立无头浏览器运行 Pyodide，并配套本地资源和便携包；采用原生 Python marimo 服务会改变进程、依赖与会话管理，采用 WASM 也需要验证包支持、数据库接入和宿主通信。不是仅更换前端依赖。[当前 Python 运行时](../../core/notebook/server/python-runtime.ts)、[marimo WASM](https://docs.marimo.io/guides/wasm/)

建议先验证“现有项目外壳 + 完整 marimo Notebook + 业务适配层”：让 marimo 负责新 Notebook 的文档、依赖图和执行状态，现有应用负责项目、数据入口、Agent 接入与结果交付。避免第一步就拆解 marimo 内部执行器或同步维护两套调度图。若完整系统的交互基本满足目标，再做 Hex 风格调整；若关键交互必须长期深改编辑器，重新比较维护成本。

建议试点用合成数据完成：导入数据 → 参数与 SQL → 结果表 / 图表 → Agent 修改预览与确认 / 撤销 → 保存重开 → 导出一个 Dataset 或看板，并验证运行失败与取消。另选一条只读仓库查询核查真实连接与大结果边界。记录需要修改的上游模块、可通过外围适配完成的内容、启动 / 分发成本与现有功能缺口；再决定全面迁移。Hex 同类查询缓存、链式 SQL 与并行行为仍须逐项对照，不能由“采用 marimo”直接推断全部达到。

本次仅研究与文档修改：未安装 marimo、创建迁移原型或修改任何运行代码，未运行上述试点、性能对比或浏览器验收，也未操作网站服务或发布。

## 面向交互体验的下一步建议

2026-09-27 补充。用户进一步指出当前界面显得生硬，希望明确下一步。建议把下一批工作的主目标收敛为“以 marimo 为基础，完成按 Hex 常见分析流程验收的可操作样板”，再依据接入结果决定迁移；不同时投入两套完整 Notebook 重做。该建议尚未开始实施。

当前差距有具体源码依据：[NotebookCellEditor.tsx](../../components/studio/notebook/NotebookCellEditor.tsx)将名称、输入依赖、代码与保存集中在表单，图表分类字段和数值字段要求手填，多个数值字段靠逗号分隔；代码输入仍使用前述基础编辑器。这些操作会增加记忆字段名、切换编辑状态的负担。此处属于源码层面的交互判断，本轮没有打开当前页面作视觉实测，不能用此前截图冒充新验收。

样板应优先验证以下操作：

- 选择或搜索字段创建图表，修改配置后看到对应预览；不要求用户记忆列名和配置语法。
- 在单元中编辑 SQL，运行后就地查看结果，能明确识别运行中、失败、过期与取消状态。
- 在当前单元上下文中让 Agent 提出修改，清楚看到影响范围，完成预览、确认或撤销；这是待适配流程，不能将 marimo 自带 AI 功能等同于现有 DSH 已兼容。
- 保存并重新打开同一份分析，结果能够交付到现有 Dataset / 看板入口。

marimo 已有可搜索、筛选的交互数据表及 GUI 图表构建器，适合作为上述样板的基础；其图表构建器会生成 Python 代码，仍需验证是否适合目标用户的操作习惯，而非只比较外观。[官方数据表与图表说明](https://docs.marimo.io/guides/working_with_data/dataframes/)

推荐主线保持为“marimo 负责 Notebook，现有应用保留项目、数据和 Agent / 看板业务”。用同一组合成数据检验完整操作、保存与失败恢复，记录上游修改范围和外围适配量。若关键体验能够主要通过现成能力与有限适配完成，再推进替换；若必须持续深改编辑器，则回到保留执行层、复用成熟组件重做交互的备选方案。界面沿用既有暖白和黑白灰方向，把重点放在信息层次与操作连贯性。未经可运行样板验证，不承诺开发周期或体验已经达到 Hex。

## 用户授权后的首批实施结果

2026-09-27 补充。用户批准优先复用成熟组件后，已在当前网站接入 CodeMirror 6、TanStack Table 8，复用 Radix/cmdk 和 Recharts 完成可搜索图表字段与即时配置预览，收起运行设置并改善代码 / 结果布局。3001 隔离项目完成真实 SQL、图表保存重开和 Dataset 导出；合成 Agent SSE 驱动真实预览并验证确认 / 撤销，12 张最终截图已逐张实际查看。具体文件、测试和能力边界见[实施与验收报告](../verification/notebook-workbench-2026-09-27.md)。这改变了此前“均未实施”的状态，但不表示已经复现 Hex 全部工作流。

独立 marimo 0.25.0 样板已安装到 uv 隔离环境，实际计算合成数据并打开编辑器；尚未接通当前项目 / Agent / 保存交付。此前建议的完整 marimo 迁移样板仍未完成，不能据基础试跑得出 marimo 不适合或全面替换更慢的结论。本批将网站的交付范围收敛到成熟组件改造，以保留当前业务接口完成实际体验改善；没有深改或嵌入 marimo，也未开启双运行时同步。后续是否全面采用 marimo，仍需完成前述业务贯通与维护成本验证。
