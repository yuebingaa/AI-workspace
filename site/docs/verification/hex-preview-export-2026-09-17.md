# Hex 第十二批：Notebook 当前预览 CSV 导出

日期：2026-09-17。第十二批限定范围已实现，已在 3001 验收；未发布稳定站 3000。不是整个 M5 或全部里程碑完成。

## 范围与证据

- 仅导出已经返回的全部预览行，按当前预览排序，不是当前 20 行分页，也不宣传为完整查询结果。1324 行完整结果 / 1000 行预览时只导出 1000 行。
- 纯 CSV 序列化归 `core/exports`，复用 Notebook 排序规则；原浏览器下载效果从 Excel 按钮提取，共用一个实现并保留旧导出入口。
- 不新建 API、重新查询、持久化、模型调用或结果句柄。完整结果下载和 M6 能力开关留后续；现有请求内完整表捕获不是跨请求下载地址。
- 审计入口：`NotebookResultTable.tsx`、`table-preview.ts`、`result-availability.ts`、`app/api/notebook/run/route.ts`、`ExcelDownloadButton.tsx`。保留全部既有未提交内容。

## CSV 策略

输出 UTF-8 BOM，字段双引号包围、引号翻倍、记录使用 CRLF；列用字段名和原定义顺序。格式依据 [RFC 4180](https://www.rfc-editor.org/rfc/rfc4180)。NULL / 缺失和空文本均导出空字段，日期 / 精确数字字符串不做 Number / Date 转换，不截断值。

公式风险文本和列头加单引号并报告处理数量；包括可疑首字符及其全角形式、前导空白 / 控制字符。此保护会改变部分文本，不能同时声称原值无损。CSV 不保存字段类型，表格软件自动推断可能改变前导零、大数和日期；另存再开不能保证防护仍有效。不存在对所有应用通用的安全清洗策略，参见 [OWASP CSV Injection](https://community.owasp.org/attacks/CSV_Injection)。本批不运行 Excel 或外部表格软件，文件字节验证与应用打开行为分开。

## 实际目录与变更

```text
site/
├─ core/exports/
│  ├─ table-csv.ts / table-csv.test.ts               # 新增：纯序列化、文件名
│  └─ browser-download.ts / browser-download.test.ts # 新增：共享 DOM 下载效果
├─ core/notebook/
│  ├─ table-preview.ts / table-preview.test.ts       # 修改：整份预览排序与分页复用
│  └─ server/preview-export.test.ts                  # 新增：真实本地执行与导出边界
├─ core/architecture/module-boundaries.test.ts       # 修改：新增两项导出模块边界
├─ components/studio/
│  ├─ ExcelDownloadButton.tsx                       # 修改：提取效果，保留兼容导出
│  └─ notebook/
│     ├─ NotebookResultTable.tsx / .test.tsx         # 修改组件、新增测试：按钮与反馈
│     └─ NotebookResult.test.tsx                    # 修改：预览导出范围断言
├─ app/notebook-cells.css                           # 修改：六条局部灰度样式
└─ scripts/verify-notebook-preview-export.mjs        # 新增：真实下载与截图验收
```

同步维护本报告、Agent 架构正文 / 指纹、里程碑、视觉规范和根任务日志。没有删除文件、迁移数据、更换依赖或更改锁文件；Git 中上一批尚未提交的文件不因本次继续修改而视为本批首次新增。

## 公开接口与职责边界

- `createTableCsv(DataTable)` 返回 `{ content, rowCount, columnCount, protectedCellCount, byteCount }`；只依赖 Dataset 的公共表契约。校验字段与标量，不把对象、非有限数字或非法类型静默转成文本；只取声明字段的自有属性，正确保留合法 `__proto__` / `constructor` / `toString` 字段。重复字段名拒绝。输出文件含 BOM / 转义的总字节超过 4 MiB 时明确失败，不静默截断；这不是进程峰值内存上限。
- `csvPreviewFilename(title)` 保留中文，替换路径 / Windows 特殊字符、去除控制字符，固定 `notebook-…-preview.csv` 前后缀并限制标题长度；不允许任意目标路径。
- `notebookOrderedPreview(table, sort)` 返回当前整份预览排序；原 `notebookTablePreview` 继续分页，返回结构不变。NULL 最后、相同值稳定、日期与精确数字字符串按原始文本排序，输入不变。
- `triggerBrowserDownload(blob, fileName)` 只负责浏览器效果及锚点 / Blob URL 清理。旧 `ExcelDownloadButton` 重导出同一函数供现有消费者兼容，无第二套实现。今后迁移旧入口调用方后才能删除该重导出。
- `NotebookResultTable` 只拥有页码 / 排序 / 导出反馈；范围不一致或预览行数矛盾时禁用。成功空结果可导出表头，截断 / 未知结果可导出已返回预览但不能冒充完整结果。原 `runId:cellId` 重挂载、失效 / 失败隐藏继续保护旧结果。
- Dataset 仍拥有表形状 / 数据与来源，SQL 和 Notebook 执行器仍负责查询 / 计算；没有把完整数据读取、数据库 SDK 或文件原件解析搬进组件。Agent、Harness、Tool、Model 以及 Dashboard 的确认 / 应用 / 撤销路径未改变，本批不是新增 Agent 导出工具。

将来改变 CSV 格式主要改 `core/exports/table-csv.ts`；改变下载方式改共享浏览器效果；改变结果界面改表格组件 / CSS。模型、数据库、Agent 的现有服务端适配入口没有变动，本批没有声称新建或完全解耦这些模块。完整结果下载需要另行设计有权限和生命周期的服务端访问入口，不能把 `resultRef` 当永久下载链接。

## 验证结果

所有路径以下述证据目录为基准：`.runtime/hex-preview-export-2026-09-17/`。

| 实际检查 | 结果 / 证据 |
| --- | --- |
| 修改前 `npm test -- --reporter=dot --maxWorkers=2` | 175 文件、1775 应用测试通过；原有 1 文件 / 3 项跳过，另 14 Node 通过；`tests-baseline.log` |
| 修改后全量同命令 | 179 文件、1861 应用测试通过，新增 86 项；原有 3 项跳过、另 14 Node 通过；`tests-final.log`，收尾复跑见 `tests-closeout.log` |
| `npm run typecheck` | 最终通过；`typecheck-final.log` |
| `npm run build` | exit 0；`build.log`。保留原有部分 chunk 超过 500 kB 提醒 |
| 12 个本批 TS / TSX 文件 `npx --no-install eslint … --max-warnings=0` | 通过；`lint.log`，不是全仓 lint |
| `node --check scripts/verify-notebook-preview-export.mjs` | 通过 |
| `npm run docs:agent:sync` / `check` / `test` | 144 个源码指纹一致，检查器 1 项通过；正文及变更记录同步维护 |
| 两项新增架构边界及原循环 / 前后端边界测试 | 随全量通过；CSV 不引入 React / Notebook / Harness / 服务端依赖，下载效果与组件只保留一份实现 |
| 本批路径 `git diff --check`、新增 / 未跟踪文件格式、报告相对链接 | 通过；另直接检查 11 文件 UTF-8 / 行尾和 9 个报告相对链接，不用 Git 忽略未跟踪文件的结果冒充已检查 |

新增 86 项为 CSV 59、整份预览排序 3、下载效果 6、表格展示 12、本地执行 / 导出 4、架构边界 2。原 Excel 下载测试保留；另由独立代理只读检查组件重挂载 / 范围 / 错误清理和兼容入口，相关三文件 24 项通过，未发现新增阻断。

过程中的失败没有隐去：初版新集成测试的三个 SQL 样例缺少已有契约要求的输入 Cell，测试夹具改为真实参数输入后 40 项相关测试通过（`integration-tests.log` / `integration-tests-final.log`）；首轮类型检查发现新增测试使用 `1n` 与项目目标不兼容，改为 `BigInt(1)` 后通过，仍验证同一种非法输入。未放宽契约、跳过测试或更改编译目标。真实 CSV 生成还补充了 Zod 克隆可能省略 `__proto__` 时的自有字段校验，避免合法值丢失或非法值逃逸。

## 数据库与实际浏览器证据

原实库链本轮重新执行 `node scripts/test-database/verify-adventureworks.mjs --runtime-dir <已核验的本机测试库目录> --evidence-dir <本批新证据目录>`（参数按要求解析为绝对路径；此处不写本机敏感路径，未修改站点连接）：[8 项实库报告](../../.runtime/hex-preview-export-2026-09-17/adventureworks-chain/report.json)、`adventureworks-chain.log`、`database-precheck.log` / `database-postcheck.log`。既有本机隔离 PostgreSQL 只读账号、回环连接和 12 秒超时确认后运行：10 表 / 107 字段目录、31465 订单 / 38 月 / 10 地区独立核对；PG → DuckDB → 表格 / 图表 → Dataset 来源 / 重开 → Dashboard 预览 / 应用 / 撤销，以及截断拒绝、权限和取消重试均通过。固定模型选择驱动四个真实工具，最终仍待确认；9 条查询回执，真实模型调用 0。这是进程内真实应用模块链，不冒充浏览器直连 PostgreSQL；库进程前后相同，无启停、恢复或写库。

3001 新隔离合成项目执行 `node scripts/verify-notebook-preview-export.mjs`，首轮全部通过：[逐项报告](../../.runtime/hex-preview-export-2026-09-17/browser-1789608877538/report.json)。8 组、11 张新截图、9 次真实 HTTP 运行（8 次成功、1 次预期 SQL 失败）、9 个实际 CSV 下载。所有 CSV 都进行逐字节比较，并用 `csv-parse` 独立解析；不是仅检查按钮存在。

- [跨页导出 1024](../../.runtime/hex-preview-export-2026-09-17/browser-1789608877538/02-last-page-still-all-45-1024.png)：当前页只显示 5 行，文件仍为按当前排序的 45 行；精确数字文本、前导零、中文引号 / 换行、日期、NULL、负数及公式风险 8 处前缀均核对。
- [失败反馈](../../.runtime/hex-preview-export-2026-09-17/browser-1789608877538/03-download-failure-retry-1024.png) / [原结果重试成功](../../.runtime/hex-preview-export-2026-09-17/browser-1789608877538/04-download-retry-success-1024.png)：明确注入一次浏览器 `URL.createObjectURL` 失败，恢复后可下载；没有查询、运行或保存请求。
- [图表独立](../../.runtime/hex-preview-export-2026-09-17/browser-1789608877538/05-chart-export-independent-1440.png)：仅下载排序后的表格预览，SVG 原顺序、源 Dataset、原件和下游计算不变。
- [1324 完整 / 1000 预览](../../.runtime/hex-preview-export-2026-09-17/browser-1789608877538/06-complete-vs-preview-export-1440.png) / [真实截断](../../.runtime/hex-preview-export-2026-09-17/browser-1789608877538/07-incomplete-preview-export-1024.png)：两种情况都仅导出已返回 1000 行，完整性标识不同，不读取隐藏结果。
- [空查询表头](../../.runtime/hex-preview-export-2026-09-17/browser-1789608877538/08-empty-success-header-only-1024.png)、编辑取消、失效 / 真实 SQL 失败时不导出旧值、保存重开后须先运行，再恢复导出。

全部 11 图由验收代理实际查看，主代理另看 02 / 03 / 06 / 08，1024 / 1440 桌面无新增布局溢出。目录 GET 明确使用空连接列表替身，其余导入、HTTP、DuckDB、转换、图表、项目保存和 CSV 下载真实执行；页面异常 / 禁止请求 / 真实模型 / 远程仓库调用均为 0。编辑取消不等于原生保存窗口取消；没有运行 Excel / LibreOffice，也未做手机、任意超大表或真实 LLM 质量验收。

## 启用、工作区与保留事项

- 仅当前源码 / 开发站 3001 验收，3000 未发布。没有新功能开关，也没有服务启停 / 重启。`npm run site:status` 前后 supervisor 与三服务 PID / worker / revision / 启动时间 / 重启数一致且健康（`status-before.log` / `status-after.log`），开发站历史两次重启未增长。合成项目、下载和证据保留在现有忽略目录，不包含用户原始数据。
- 当前分支 `feature/eds-analysis-dashboard`，HEAD `df5bbae`；保留用户、前十一批及并行文档任务修改。未提交、推送、切换 / 合并分支、清理历史或删除用户文件。新增模块仍未跟踪，未来提交需连同消费者和测试一起收录。
- 根任务日志已追加本批条目，开工前 307494 字节及包含并行法律研究追加后的 311080 字节历史前缀分别核验 SHA-256 不变。
- 本批只降低导出相关替换成本。完整结果 / 流式下载、服务端分页排序、类型化无损导出、功能关闭恢复和完整 Cell 动态注册仍留后续，未无限扩展本轮。
- CSV 公式文本前缀会改变文本；NULL 与空串无法区分；表格软件重新推断类型或另存再开需人工核对。UI 的成功仅表示发起下载，不保证最终落盘。保留 Excel 按钮兼容重导出；现有完整查询、数据权限和结果有效性仍由原模块负责。
