# Hex 第四批：Notebook Cell 模块边界

日期：2026-09-16。状态：本批选定范围的源码、离线检查和 3001 浏览器验收完成；3000 未发布。

## 本批完成边界

仅推进 M2 的 Cell 目录与职责分离切片；不是完整 M2，也不提前加入 M3 结果仓库、参数单元或任意动态插件。

- 核心静态目录统一当前九种 kind 和既有四种必须试运行的要求；UI / Harness 通过同一契约访问，不迁移授权和策略裁剪。
- 浏览器展示目录统一标签、工具栏与源码名称；默认创建纯工厂与 React 组合分开，保持默认值、先决条件和报错。
- 执行器仅提取 table/chart 字段验证与结果投影，并显式处理 text / 穷尽检查；权限、Python 会话 / 计时、取消、日志、血缘与预算仍由现有执行器负责。
- 以九类兼容回归与 3001 隔离合成项目截图验收；真实 SQL/Python / 表图 / 数据处理，数据库目录替身仅证明选择与编辑，不冒充实库查询。

保留已确认的交互：新增时默认单元已插入，“取消编辑”不撤回已新增单元；删除前的“保留”不更改定义，确认删除沿用现有依赖提示。UI 不引入新的插件注册、运行框架或默认数据库授权。

## 基线与进度

- 分支 `feature/eds-analysis-dashboard`，前三批未提交内容按当前工作区保留。
- 开始 site:status：stable / dev / capture 健康；dev 重启数 2 为既有历史，不进行服务操作。
- 本批实际重跑修改前全量：144 文件 / 1,243 项通过，1 文件 / 3 项原有跳过，另 14 项 Node 通过。日志 `.runtime/hex-cell-modules-2026-09-16/tests-baseline.log`。

| 切片 | 状态 |
| --- | --- |
| 核心种类 / 试运行目录与架构保护 | 已完成 |
| 浏览器展示目录与默认创建 | 已完成 |
| 表图投影与执行分派保护 | 已完成 |
| 真实浏览器、保存重开与截图 | 8 组 / 11 图通过，九类兼容覆盖完成 |
| 最终检查与任务记录 | 完成；稳定站未发布 |

## 实际目录和公开接口

```text
core/notebook/
  definition.ts                    # 原有严格 Cell / 文档定义，仍是唯一 Schema
  cell-catalog.ts                  # 新增：封闭种类目录、原有试运行要求
  client-state.ts                  # 原有文档更新 / 采用入口，复用目录谓词
  presentation-table.ts            # 新增：表图字段校验与投影，无副作用
  server/execution.ts              # 原有执行编排、端口与生命周期
components/studio/notebook/
  cell-presentation.ts             # 新增：浏览器标签、工具栏顺序、源码语言
  cell-creation.ts                 # 新增：手工默认创建纯函数
  NotebookChrome.tsx               # 保留 SVG 与工具栏呈现
  NotebookPanel.tsx                # 保留 React 状态、随机 ID、文档更新
  cell-source.ts                  # 复用展示目录，保持源码内容
core/harness/
  notebook-cell-search.ts          # 共用合法 kind，不扩张可用工具
  tool-registry.ts                 # 共用原四类试运行要求
scripts/
  verify-cell-modules.mjs          # 隔离浏览器回归与截图
  fixtures/cell-modules.mjs        # 固定合成输入和独立预期
```

- `NOTEBOOK_CELL_KINDS` / `notebookCellCatalog`：保留原 CellSearch 九类及顺序，映射用 `satisfies` 对照 `NotebookCell["kind"]`。`requiresSuccessfulNotebookTrial` 只表达原来的 SQL / Python / 数据库 SQL / DataRecipe 草稿采用条件，不是权限、数据库只读规则或运行能力开关。
- `notebookCellPresentation` / `notebookToolbarOrder`：浏览器静态展示契约；UI 工具栏顺序与 CellSearch 的语义枚举顺序仍各自保持，不强行合并成一个顺序。
- `createNotebookCell(kind, context)`：显式输入 ID、后缀、当前单元、数据源 / 模型 / 连接及字段读取函数；不读取 React 状态、不发请求、不运行代码、不持久化。默认值、前置条件与报错先后沿用原实现。Panel 仍独占 30 单元限制、最新字段判定、UUID、`updateNotebook` / `onChange` 与编辑状态。
- `projectPresentationTable(cell, upstream)`：只校验并投影表格 / 图表数据；保留字段元数据按输入顺序、行对象按选择顺序、高精度字符串 / null / 布尔值、完整行集及 truncated 标记。图表拒绝非数字指标，饼 / 环形拒绝负数；不替上游猜测类型，不追加全量内存加载。
- `execution.ts` 保留原外部端口与编排；text 显式无计算，末尾 `never` 穷尽检查防止将新增合法类型默认为成功。非法输入仍先由严格 Schema 拒绝，不访问查询 / Python 等端口。授权、取消、超时、预算、Python 会话、计时、日志和血缘没有迁入纯函数。

## 模块边界和以后修改的位置

Agent / Harness 的模型决策、执行循环、工具门控与确认规则保持原边界；Tool 仍调用既有 Notebook 业务入口。Model、Dataset 导入、SQL 驱动、语义模型存储和 Dashboard 渲染实现未在本批重新封装或搬迁。

今后修改 Cell 默认创建只改 `cell-creation.ts` 与对应测试；标签 / 工具栏调整改 `cell-presentation.ts`；表图字段规则改 `presentation-table.ts`。替换模型仍走既有模型适配入口，替换数据库走既有 connection driver / query port，替换图表渲染走既有组件，本批没有宣称这些替换零成本。

新增真正的 Cell 类型仍须更新严格定义、静态目录、展示 / 创建、编辑器及执行分支，并明确 Agent 能力 / 授权和证据策略；类型穷尽检查及测试会提示遗漏。本批不提供动态加载插件或运行时卸载。

## 实际验证

以下均为本批重新执行，不沿用前三批结果：

| 命令 / 检查 | 结果 |
| --- | --- |
| 修改前 `npm test -- --reporter=dot --maxWorkers=2` | 144 文件 / 1,243 项通过；1 文件 / 3 项既有跳过；另 14 项 Node 通过 |
| 修改后同一全量命令 | 148 文件 / 1,313 项通过；原 3 项仍跳过；另 14 项 Node 通过，新增 70 项回归 |
| `npm run typecheck -- --incremental false` | 通过 |
| `node node_modules/eslint/bin/eslint.js <本批 20 个 TS/TSX/MJS 文件> --max-warnings=0` | 通过；不是全仓 lint |
| `npm run build` | 通过，确认退出码 0；保留既有客户端 chunk 大于 500 kB 提示 |
| `npm run docs:agent:sync` / `npm run docs:agent:check` | 正文修改后同步；134 个源码文件指纹一致 |
| `npm run docs:agent:test` | 检查器测试通过 |
| `node --check scripts/verify-cell-modules.mjs` 与 fixture 语法检查 | 通过 |
| `git -c core.safecrlf=false diff --check` | 通过；新增文件另做文本检查 |

专项先确认旧行为再提取；新模块缺失时的预期失败与根代理一处不符合真实文档 Schema 的测试夹具错误均已修正，不将其记为产品故障。新增测试覆盖九类创建 / 采用矩阵、图表类型与精度、字段顺序、完整行集、未知类型不触发外部能力及纯模块依赖边界。类型 / 全量测试没有放宽断言、增加跳过或关闭检查。跨代理只读差异复核未发现权限、状态所有权或默认值回归。

本批检查日志位于 `site/.runtime/hex-cell-modules-2026-09-16/`：`tests-baseline.log`、`tests-final.log`、`typecheck.log`、`build-confirmed.log`。截图验收单独记录下文。

## 真实页面验收与截图

实际运行 `node scripts/verify-cell-modules.mjs`，仅使用既有 3001、隔离 Edge 会话及新建合成项目。最终 [逐场景报告与九类覆盖矩阵](../../.runtime/cell-modules-2026-09-16/browser-1789560162758/report.json) 为 8 组通过、11 次真实 Notebook HTTP 执行、11 张截图；页面异常、禁止请求、真实模型调用、远端数据库查询均为 0。

| 场景 | 实际断言 / 图片 |
| --- | --- |
| 无可用连接、取消新增 | 连接目录空时不插入数据库单元；新增说明后取消仍保留默认定义，`01` / `02` 图 |
| 真实 CSV → Data → SQL → Python → DataRecipe → 表格 / 图表 | SQL 为 East=150、South=80；Python 加权后 300 / 160，与固定独立预期一致；[1440 图表](../../.runtime/cell-modules-2026-09-16/browser-1789560162758/03-real-chart-1440.png)、[1024 图表](../../.runtime/cell-modules-2026-09-16/browser-1789560162758/04-real-chart-1024.png) |
| 真正 Python 失败、下游阻断和修复 | ValueError 后依赖表 / 图不复用旧结果，修复后恢复数值；[失败](../../.runtime/cell-modules-2026-09-16/browser-1789560162758/05-real-failure-1440.png)、[1024 阻断](../../.runtime/cell-modules-2026-09-16/browser-1789560162758/06-blocked-1024.png) |
| 本地语义模型 | 合成模型 v1 与 Data 单元绑定，真实本地聚合为 150 / 80；[语义结果](../../.runtime/cell-modules-2026-09-16/browser-1789560162758/07-local-semantic-result.png) |
| 数据库 SQL 目录替身 | 仅替换 GET 目录 6 次，验证可选 → 不可用仍保留定义；禁止包含 warehouseSql 的运行，不连接数据库，`08` 图 |
| 九类改名保存 / 编辑取消 / 删除保留 / 刷新 | 每一 kind 都有独立断言；Data 删除提示真实 6 个后继，保留不写入；`09` 图和[重开](../../.runtime/cell-modules-2026-09-16/browser-1789560162758/10-reopened-nine-kinds.png) |
| 最终删除测试单元 | 按反依赖顺序逐个删除九个测试单元，原件 / Dataset / 语义模型仍保留、看板仍为空白；刷新确认空文档，`11` 图 |

全部最终截图已由验收代理逐张实际查看；主代理另复核最终 `04` / `06` / `07` / `10` 图，未见本批新增排版问题。非本次目标的其他 Cell 可能按既有运行策略显示已失效或待运行，未把它们误记为本次运行成功。

保留过程证据：`browser-1789559775644` 因测试选择器误解嵌套 label 失败；`browser-1789559912304` 因 1024 布局隐藏保存标识而错误等待失败。修正脚本定位 / `textContent`，没有改产品代码。`browser-1789560056442` 已完整通过，但合成指标名称仍沿用默认“region计数”，随后明确改成“金额合计”并全量重跑生成最终图；同时调整阻断截图在对应运行后的拍摄顺序，避免后续运行改变状态后图注与画面不一致。不删除失败现场，不称全程无失败。

## 工作区和启用状态

仍在 `feature/eds-analysis-dashboard`、HEAD `df5bbae`；原有与本批源码修改均未提交，没有推送、分支操作或发布。未更改用户原件、私密连接配置、数据库及模型服务。当前 3001 源码已验收；3000 仍为原稳定构建。

本批前后 `npm run site:status` 均显示 stable / dev / capture 健康，进程、修订和重启数一致；dev 的历史重启数 2 本批没有增加。没有停止、重启或新启网站服务。测试过程仅删除隔离合成项目中明确创建的九个 Cell，原始合成 CSV、Dataset、语义模型和所有截图保留；未删除任何用户文件。

## 保留、未验证与剩余风险

- 保留现有项目格式、API / SSE、工具参数、权限和确认 / 撤销机制；没有迁移用户数据或删除原有文件，没有创建第二套业务实现。
- 静态目录不是完整 M2 执行 / 编辑注册系统；未建立通用结果仓库、参数单元、响应式 DAG 或能力卸载。执行器继续保有九类明确分支，避免为较短的分派新造框架。
- 没有真实模型调用，不把固定 SQL / Python 成功视为模型生成质量验证；数据库目录替身不代表本批重验 AdventureWorks / Databricks 实库。
- 仅当前合成小数据与最小 1024 px 桌面验证；大数据性能、长期负载、多用户隔离和所有异常时序未覆盖。
- 工作区原有未提交修改继续保留；本批不提交、推送或切换分支，不运行发布 / 服务启停命令。TASK-LOG 与运行证据沿用本地忽略规则。
