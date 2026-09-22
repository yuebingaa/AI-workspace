# M5 收尾 1/3：受控文本引用（累计第十三批）

日期：2026-09-17。状态：本批源码、离线回归、真实本地数据库和 3001 截图验收完成；未发布稳定站。累计第十三批，M5 收尾三个验收包已完成第一个，剩余两个。

## 收尾边界

按原 M5 六项及验收核对实际入口后，剩余固定为三个验收包：①受控文本引用（本批）；②参数自动重算；③统一上下文选择并汇总 M5 交互验收。每包按一批实施，若出现必须拆分的安全问题须明确记录，不能用新增需求无限延长。此前四批展示 / 参数 / 改名 / 预览导出保留。

审计时的代码证据：`definition.ts` 的 text 只有 markdown，`NotebookPanel.tsx` 原样显示；参数保存仅更新定义而不调度；`ComposerContextMenu.tsx` 尚无参数 / Cell 选择。已有 Cell 外壳与图表投影 / 渲染边界不再机械重建。完整结果下载、任意插件、跨表语义、M6 功能关闭恢复不是 M5 追加门槛；M2–M4 保留项及 M6 / M7 仍需各自验收。

## 本批冻结契约

- 保留旧 text / markdown，新增可选 `references: [{ key, cellId, field }]`，最多十项。稳定 ID 绑定已有输出字段，`{{key}}` 只读插值；不执行模板、SQL、Python、HTML 或表达式。
- 只引用本次运行成功、完整且恰好一行的参数 / 汇总表；多行、空表、缺字段、截断、无效模板明确失败，不偷偷选第一行或代填默认值。
- 替换一次、不递归解释数据中的占位符。NULL 明示，数值与精确文本不转换；输出最多 8000 字符，超过拒绝而非截断。无引用的旧静态大括号文字保持原义。
- 依赖、失效、取消、改名与来源沿用现有图；成功运行回执增加可选 `text`，只在有引用 text 成功时返回，不伪造表格 / resultRef。结果仅当前运行，不写入定义或冒充永久句柄。
- 人工和 Agent 复用严格定义、执行与验收；AI 草稿仍须试运行及用户采用。新编辑器与显示组件独立于服务端计算；只在 3001 合成项目验收并截图。

## 工作记录

- 已读取协作 / 运行 / 架构与视觉约定、最近日志、真实定义 / 图 / 执行 / 编辑 / 工具 / 计划入口；不是全仓逐行审计。
- 首轮专项测试有一项测试写错任务产物路径（`task.artifacts.notebook`），改为真实 `task.notebookArtifact` 并保留采用 / 验证断言后通过；不是删除测试或放松业务要求。
- 首轮浏览器脚本将 Locator 当函数调用，修正脚本后用另一新合成项目完整重跑；失败证据保留，不计为产品通过。
- 首轮全量测试为 1976 通过 / 1 失败，新增契约触发原显式 10000 字符预算回归。已仅精简 compacted Notebook 单元工具上下文中重复的操作说明和模型可见路由摘要（保留 mode / source）；实际选择器 / Planner 的完整路由、工具集合与 Schema、权限、工作记忆和证据不变。原 10000 / 无上限两种流程完整提交通过，没有提高限额或改旧断言。新增压缩契约 5 项，相关四文件 61 项通过。
- 独立复核复现文本预览二次压缩后正文 600 字符变 221，但原标记仍称未截断。修复为按原有界观察重建完整标记、原字符数与省略数量，不能恢复被删正文，不足预算明确省略；没有新增额度或读取能力。强制低预算及实际工具链验证见最终检查。

## 实际模块与接口

```text
core/notebook/
  text-references.ts        纯引用契约、模板校验、单行字段替换
  definition.ts / graph.ts  原 text 扩展、稳定 ID 依赖与失效
  contracts.ts             NotebookCellRun 可选 text
  run-receipt.ts            本次定义对应的成功文本回执校验
  server/execution.ts      从本次 outputs 取完整表并调用纯替换函数
core/harness/
  analysis-plan-contracts.ts / analysis-planner.ts  计划引用与实际草稿一致
  notebook.ts / notebook-cell-tools.ts / tool-registry.ts
                           整稿及增量沿用授权、真实试跑与待采用
  notebook-text-results.ts  两条工具链共用受控文本观察预览
components/studio/notebook/
  NotebookTextEditor.tsx    人工绑定键、单元、字段与插入占位符
  NotebookTextResult.tsx    本次成功文本、未运行 / 过期 / 失败展示
```

- `text-references.ts` 对外提供 `notebookTextReferencesSchema`、`validateNotebookTextTemplate`、`renderNotebookText` 和两个限额常量；只依赖公共表契约与 Zod，不依赖 React、Harness、数据库、模型或路由。纯替换函数只校验收到的表，当前运行身份 / 权限由执行器负责，不把它冒充授权边界。
- `definition.ts` 复用契约；`graph.ts` 统一去重引用上游 ID，Harness 也复用 `cellDependencies`，不再复制一份单元依赖分支。`cell-catalog.ts` 只对带引用 text 要求真实试跑，保留旧静态文本兼容。
- `run-receipt.ts` 在运行前固定所需文本 Cell；成功但没有文本、错误单元附文本、普通表伪装文本均拒绝。这是运行器边界一致性检查，不是证明第三方运行器或模型结论绝对可信。
- Agent 计划声明的引用 / 依赖必须与草稿一致；已知上游字段先校验，SQL / Python 动态字段由实际运行核实。普通 API 与两条 Agent 工具链共用执行器。工具只返回有界文本预览及省略信息，原始文本回执最多 8000 字符；不新建文本 Dataset / 表格 / 结果句柄。
- UI 只负责定义编辑和 React 纯文字展示，保存不自动计算。引用字段暂由用户填写实际字段名，参数默认 `value`；引用键修改不猜测替换正文，移除引用会移除对应占位符，编辑器明确说明。取消保留原定义；已有新增后取消仍保留默认单元的行为不变。
- SQL / Dataset / 模型服务端适配、SSE 事件名、Tool 名称、确认 / 授权和项目版本不变；只新增可选字段。项目保存引用定义，不保存当前页面计算文本。旧静态项目在新版本可读；不承诺旧二进制能读取新引用配置。

主要新增：纯引用模块及两类领域 / 执行测试、两个独立 UI 组件及测试、共享工具文本预览模块、Harness 文本链与回执测试、浏览器脚本。主要局部修改：上述消费者、`client-state.ts` 采用错误说明、`NotebookCellEditor.tsx` / `NotebookPanel.tsx` 组合入口、`app/notebook-cells.css` 十条局部样式、架构边界测试、现有 AdventureWorks 验收脚本和三份维护文档。没有移除业务文件、搬迁无关目录或新增依赖。

## 真实数据库与浏览器证据

实库证据：[report.json](../../.runtime/hex-text-references-2026-09-17/adventureworks-chain/report.json)。已有本地 AdventureWorks 只读验证脚本保留原八项，新增 PostgreSQL 单行订单数 / 精确金额 / 日期 → 实际 Notebook API 函数 → 受控文本，**9 / 9 通过、10 条查询回执**。独立 PG 查询逐值核对，本次结果一行 / 完整 / 同 runId；文本没有 table / resultRef。原数据库 → 本地 SQL → 表图 → Dataset / 看板预览 → 保存重开链也重新执行。未新开 HTTP 服务，不把这一项称为浏览器直连数据库。

实库前后核验 owner、进程和仅回环监听相同，凭据仍为既有只读账号，无临时对象 / 写权限，保留语句超时；没有恢复、写库、改连接配置或启停数据库。数据库工具两文件 **11 项通过**。报告不写入凭据或本机私密路径。

浏览器证据：[report.json](../../.runtime/hex-text-references-2026-09-17/browser-1789610933006/report.json)。3001 新隔离合成项目 **7 组 / 13 张截图 / 11 次真实 Notebook HTTP（7 成功、4 预期失败）**；全部截图由验收代理实际查看，主代理另看 02 / 03 / 06 / 13。连接目录 GET 为明确空替身三次，其余参数、SQL、保存和重开真实；没有上传真实用户文件、调用真实模型或查询远程仓库。

| 截图 | 实际验收 |
| --- | --- |
| [01 编辑器](../../.runtime/hex-text-references-2026-09-17/browser-1789610933006/01-text-reference-editor-1024.png)、[02 多引用](../../.runtime/hex-text-references-2026-09-17/browser-1789610933006/02-multiple-reference-inputs-1024.png) | 1024 px 键 / 稳定单元 / 字段编辑、真实插入占位符 |
| [03 成功输出](../../.runtime/hex-text-references-2026-09-17/browser-1789610933006/03-real-text-output-1440.png) | 1440 px 真实 SQL 200；NULL、精确整数文本、前导零 / 中文换行保持，HTML 外观和数据内占位符不执行 |
| [04 拒绝无效模板](../../.runtime/hex-text-references-2026-09-17/browser-1789610933006/04-invalid-placeholder-rejected-1024.png)、[05 取消编辑](../../.runtime/hex-text-references-2026-09-17/browser-1789610933006/05-cancelled-template-edit-1024.png) | 保存前拒绝未声明键；取消不保存 / 自动运行 |
| [06 缺字段](../../.runtime/hex-text-references-2026-09-17/browser-1789610933006/06-missing-field-failure-1024.png)、[07 多行](../../.runtime/hex-text-references-2026-09-17/browser-1789610933006/07-multi-row-rejected-1024.png)、[08 空表](../../.runtime/hex-text-references-2026-09-17/browser-1789610933006/08-empty-source-rejected-1024.png)、[09 真截断](../../.runtime/hex-text-references-2026-09-17/browser-1789610933006/09-truncated-source-rejected-1440.png) | 真实失败，不取第一行、不用旧成功文本；2000 行 SQL 被真实截断为 1000 |
| [10 失效](../../.runtime/hex-text-references-2026-09-17/browser-1789610933006/10-upstream-change-stale-1440.png)、[11 改名](../../.runtime/hex-text-references-2026-09-17/browser-1789610933006/11-stable-reference-rename-review-1440.png) | 参数修改仅影响对应分支，改输出名称保留 ID 引用、仍需显式确认 / 重跑 |
| [12 重开待运行](../../.runtime/hex-text-references-2026-09-17/browser-1789610933006/12-reopened-uncomputed-text-1024.png)、[13 重跑成功](../../.runtime/hex-text-references-2026-09-17/browser-1789610933006/13-reopened-real-text-1024.png) | 只保存定义，重开不冒用旧值；真实重跑得到 400，静态大括号兼容 |

页面异常与违规请求均为零，无横向布局溢出。无效模板错误暂显示原始 Zod 结构，中文原因可读；后续可改善文案，不扩大本批产品范围。

## 最终检查与工作区

以下命令均在 `site/` 执行；原始证据位于 `.runtime/hex-text-references-2026-09-17/`。表中数据库路径参数为脱敏说明，不含凭据。

| 实际检查 | 结果 / 证据 |
| --- | --- |
| 修改前 `npm test -- --reporter=dot --maxWorkers=2` | 1861 应用 / 14 Node 通过，3 项既有跳过；`tests-baseline.log` |
| 修改后同一全量命令 | **1996 应用 / 14 Node 通过**，187 个应用测试文件通过，原有一个文件 / 三项跳过；`tests-closeout.log`，退出 0 |
| 本批专项测试 | 新增 **135 项**：纯引用与执行 71、UI 24、Harness / 回执 / 架构及两项回归领域 40；分别检查后纳入最终全量，未删除 / 弱化旧测试、未新增跳过 |
| `npm run typecheck` | 退出 0；`typecheck-final.log` |
| `npx --no-install eslint` 本批 28 个 TS / TSX 文件 `--max-warnings 0` | 退出 0；`lint-final.log`；未执行全仓格式化 |
| `npm run build` | 退出 0；`build-final.log`。有分包大小 / 插件耗时提示，未为消除提示升级依赖或修改阈值 |
| `npm run docs:agent:sync`、`npm run docs:agent:check` | 146 个源码文件指纹一致；`docs-sync-final.log` / `docs-check-final.log` |
| `npm run docs:agent:test` | 1 项通过；`docs-test.log` |
| `node scripts/verify-notebook-text-references.mjs` | 最终 7 组 / 13 图 / 11 次 HTTP 通过；`browser-run-2.log` |
| `node scripts/test-database/verify-adventureworks.mjs --runtime-dir <已核验本地运行目录> --evidence-dir <本批新证据目录>` | 9 / 9，通过既有只读 v3 环境，0 真实模型调用；`adventureworks-chain/report.json` |
| 两个上述 `.mjs` 的 `node --check`；数据库工具测试 | 两脚本语法通过；数据库工具两文件 11 项通过 |
| 本批范围 `git diff --check`、新增 / 修改文件尾空白和 UTF-8 检查、四份维护文档本地链接检查 | 均通过；Git 仅提示按既有策略转 CRLF，没有批量改行尾。链接指向实际文件 / 本次图片，不使用历史图片冒充新验收 |
| `npm run site:status` 前后比较 | 三服务健康；supervisor / PID / worker / revision / 启动时间 / 重启次数逐值相同。开发站原有两次历史重启未增长 |

分支仍为 `feature/eds-analysis-dashboard`，HEAD `df5bbae`。保留原有大量未提交 / 未跟踪内容；本批没有提交、推送、合并、换分支、自动 stash 或删除用户文件。新增模块仍是未跟踪文件，后续提交必须连同消费者一起纳入，不能只提交既有文件的修改。证据、合成项目和构建产物沿用已有忽略规则保留；没有把它们发布到稳定站。

根任务日志追加前 318446 字节 SHA-256 已记录，追加后验证此前内容完全保留。没有修改持久业务数据、密钥或依赖锁文件。最后源码检查无未处理新增回归；“通过”仅覆盖实际执行的场景，不包括下列未验证项。

## 保留项与后续位置

M5 还剩两个验收包：参数自动重算、统一上下文选择与 M5 汇总验收。本批没有自动重算、表达式语言、富文本 / HTML 渲染、跨请求文本分页、永久结果仓库、全量下载或新看板发布方式。CellSearch 的 output 仍返回原表格结果语义，文本没有表时不伪造表；不将本批工具观察预览描述成完整的文本检索 API。

未来修改文本引用规则主要在 `text-references.ts` 及对应编辑器；修改外部计算仍在既有 SQL / Python 执行端口和连接驱动，修改模型仍在 `core/ai/server/` 组装 / 适配；不用把文本模板和模型 SDK 混合。整稿 / 增量计划映射仍有既存种类分支，未实现动态插件注册。未调用真实收费模型、未验证任意模型自主产出质量、未新增真实 Python 环境验收、未验手机或外部表格软件；固定模型测试只证明实际工具执行链和采用保护。
