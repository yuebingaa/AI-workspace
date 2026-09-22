# Hex 第十批：本地参数单元

日期：2026-09-17。状态：本批源码、离线 / 实库回归、3001截图验收完成，未发布 3000。

## 固定范围与工作记录

- 在现有 Notebook 增加一个 `parameter` kind，内部文本、数字、日期、单选四类；空白 Notebook 可创建。
- 纯参数配置 / 表转换与编辑器分离；依赖现有执行器、显式依赖图、SQL / Python 端口，不建设第二套运行系统。
- 参数输出一行 `value` 列，以结构化表输入参与本地 SQL / Python；不把值拼入代码，不绑定远端仓库。
- 修改后沿用下游失效、手动运行、草稿试运行与确认采用；保留 Dataset 来源及本地项目重开。
- 同步 Agent 计划、整稿 / 增量工具、模型目录、空源任务判断。参数不授予任何 Dataset / 连接权限。
- 不做自动重算、远端参数绑定、文本模板、App 输入控件、动态插件或新模型服务。

审计发现：核心 Schema / 能力目录、执行分支、浏览器创建 / 编辑、Harness 计划与无源阻塞、Dataset 来源九类枚举均需同步；仅增加按钮会在工具或来源保存时失败。依赖 / 搜索 / 指纹算法已按 `outputName` 与显式依赖工作，不重写。

基线：`npm test -- --reporter=dot --maxWorkers=2`，165 文件 / 1623 应用测试通过，3 项原有跳过；14 项 Node 测试通过。启动前读取协作与运行说明，三个管理服务健康。工作区已有大量未提交修改，按现状保留；不提交、推送、发布或重启。

## 数据与兼容边界

文本保留空串、空白、引号与换行，最多 2000 字符。数字为有限 JavaScript 浮点数，范围不超过正负安全整数上限；不承诺任意精度十进制。日期为合法 `YYYY-MM-DD`：现有 SQL worker 使用字符串，可显式 CAST；Python 沿用日期列转换。单选 1–50 个唯一非空选项，当前值须在选项内，服务端继续做跨字段校验。

参数值属于普通项目定义，会持久化、出现在修改审阅 / 来源记录，并可能进入 Agent 上下文；不是秘密输入或凭据存储，不应填写密码 / API Key。旧九类文档保持可读；含新类型的项目不保证由旧程序打开。既有版本号和 API 路径不变，没有生产迁移。

## 实际目录与模块边界

```text
core/notebook/
  parameter.ts                          新：配置 / 标量表转换
  parameter.test.ts                     新：40项契约、图 / 搜索 / 失效
  parameter-provenance.test.ts          新：3项来源闭包与保存
  definition.ts, cell-catalog.ts        改：第十种类型与试运行要求
  client-state.ts                       改：参数采用前需成功证据的提示
  server/execution.ts                   改：参数接入同一执行循环
  server/parameter-execution.test.ts    新：9项运行 / SQL / 取消 / 授权
core/harness/
  analysis-plan-contracts.ts            改：同源配置的参数计划步骤
  analysis-planner.ts, notebook.ts      改：参数输出及计划编译校验
  notebook-cell-tools.ts                改：参数意图、现有工具路径
  context-selector.ts                   改：允许无外部数据的参数链
  tool-registry.ts                      改：按需目录与参数绑定说明
  notebook-parameters.test.ts           新：7项端到端工具契约
  tool-schema.test.ts                   改：参数开 / 关均精确等于规范Schema
core/datasets/provenance.ts             改：参数来源类型
components/studio/notebook/
  NotebookParameterEditor.tsx           新：参数表单与值摘要、纯输入解析
  NotebookParameterEditor.test.tsx      新：29项字段、错误、无损编辑
  cell-creation.ts, cell-presentation.ts 改：默认值 / 名称 / 入口
  NotebookChrome.tsx                    改：参数图标
  NotebookCellEditor.tsx                改：分流专属编辑器
  NotebookPanel.tsx                     改：组合编辑器及已保存值摘要
components/studio/datasets/
  DatasetProvenance.tsx                 改：参数标签、根输入“参数值”
  DatasetProvenance.test.tsx            新：12项参数 / 旧类型展示
core/architecture/module-boundaries.test.ts 改：参数依赖约束
app/notebook-cells.css                  改：5条单选选项布局规则
scripts/verify-notebook-parameters.mjs   新：隔离项目真实HTTP与截图
```

另扩展目录、创建、展示的原测试；没有源码移动 / 删除、依赖升级或锁文件重生成。新模块与消费者需一同提交，不能只提交已跟踪修改而漏掉新增文件。

Agent 仍通过 `HarnessModel` 做意图 / 规划和工具选择；没有具体模型 SDK 新增依赖。Harness 继续拥有执行 / 版本 / 取消 / 证据，工具只适配参数与草稿。参数配置由 Notebook 所有，不是全局 UI 状态或数据库配置；SQL / Python 消费现有 DataTable 端口，Dataset 保存现有来源闭包。Dashboard 继续是需确认的快照，不被参数编辑自动改变。

## 验证与证据

所有 npm / npx 命令在 `site/` 执行。服务用 `npm run site:status` 只读检查，没有发布或进程操作。

| 检查 | 本批实际结果 / 证据 |
| --- | --- |
| 修改前完整基线 | 1623 应用 / 14 Node 通过，3 项原有跳过；`tests-baseline.log` |
| 参数领域相关 | 13文件180项，9文件严格ESLint通过；`domain-tests.log` / `domain-lint.log` |
| Notebook / 来源 / 架构相关 | 10文件164项，12文件严格ESLint通过；`ui-tests.log` / `ui-lint.log` |
| 完整回归 | 171文件 /1729应用通过，3项原有跳过；14 Node通过，`tests-closeout.log` |
| 类型、变更文件检查与构建 | 类型、30文件严格ESLint、最终build、所涉diff检查通过；不称全仓 lint |
| 浏览器脚本 | `node --check scripts/verify-notebook-parameters.mjs` 通过；完整执行5组 /15图 /12次真实HTTP通过 |
| 原AdventureWorks链路 | 既有只读实验库8/8通过，进程内真实API模块，不冒充浏览器数据库查询 |

本批日志目录为 [`.runtime/hex-parameters-2026-09-17`](../../.runtime/hex-parameters-2026-09-17/)。执行的主命令为 `npm test -- --reporter=dot --maxWorkers=2`、`npm run typecheck`、`npx eslint <本批实际变更TS/TSX文件> --max-warnings 0`、`npm run build`、`npm run docs:agent:sync`、`npm run docs:agent:check`、`npm run docs:agent:test`。完整测试使用现有离线替身，不调用收费模型。

### 新截图

最终[浏览器报告](../../.runtime/hex-parameters-2026-09-17/browser-1789605210433/report.json)来自全新隔离项目；目录 GET 明确为空目录替身，Notebook 执行、CSV 导入和项目保存均真实 HTTP。两名代理均已逐张实际查看全部15图，不以DOM断言替代。

| 场景 | 代表截图与实际检查 |
| --- | --- |
| 空 Notebook 四类参数 | [文本编辑](../../.runtime/hex-parameters-2026-09-17/browser-1789605210433/01-text-parameter-editor-1440.png)、[1024输出](../../.runtime/hex-parameters-2026-09-17/browser-1789605210433/03-parameter-output-1024.png)；无文件时也可运行参数及SQL |
| 字面值 / 错误 / 取消 | [参数-only SQL](../../.runtime/hex-parameters-2026-09-17/browser-1789605210433/03b-parameter-only-sql-1024.png)、[重复选项拒绝](../../.runtime/hex-parameters-2026-09-17/browser-1789605210433/05-invalid-select-1024.png)；空数字不变0，取消不覆盖原定义 |
| 真实本地分析 | [SQL](../../.runtime/hex-parameters-2026-09-17/browser-1789605210433/07-real-sql-parameters-1440.png)、[Python](../../.runtime/hex-parameters-2026-09-17/browser-1789605210433/08-real-python-parameters-1440.png)；五个显式表输入，合成金额350，含引号 / 分号 / 换行文本原样返回 |
| 修改后失效与重跑 | [下游失效](../../.runtime/hex-parameters-2026-09-17/browser-1789605210433/10-parameter-stale-1024.png)、[重算200](../../.runtime/hex-parameters-2026-09-17/browser-1789605210433/11-manual-recomputed-chart-1024.png)；无自动请求，无关分支保持，运行后遵循既有结果身份失效规则 |
| 保存 / 来源 / 重开 | [参数来源](../../.runtime/hex-parameters-2026-09-17/browser-1789605210433/12-saved-dataset-lineage-1440.png)、[重开后Python](../../.runtime/hex-parameters-2026-09-17/browser-1789605210433/14-reopened-python-1024.png)；保存重新计算、保留四参数定义与原始文件，正式看板仍空白 |

浏览器页面异常 / 禁止请求 / 真实模型 / 仓库查询均为0。参数执行取消由领域 / Harness 测试覆盖；本批浏览器只验证编辑取消，不伪称执行取消新截图。

### 数据库到输出端兼容

[实库报告](../../.runtime/hex-parameters-2026-09-17/adventureworks-chain/report.json)：核对现有实验库归属、回环监听、只读reader与超时后，以原脚本执行8项。10表 /107字段，31465订单 /38月 /10地区独立结果一致，9条查询回执。覆盖 PostgreSQL → DuckDB → 表图 → Dataset与来源 → 项目重开 → 看板预览 / 应用 / 撤销；截断拒绝、越权拒绝和取消重试仍有效。固定模型选择驱动4个真实工具后处于待确认；没有真实模型调用。

这是原链兼容，不宣称 `warehouseSql` 支持新参数。本批无恢复 / 启停 / 写库 / 连接配置修改，实验库运行身份与健康状态前后不变。

## 过程问题与处理

- 增加参数指导文案后一项既有显式10000字符预算回归失败：把指导与参数Schema一起按需提供，未提高额度、删除约束或改断言。
- 参数来源标签遗漏导致类型错误和截图缺字：补齐穷尽映射及12项展示回归，并重新完整截图；不是忽略类型错误。
- 两项原模型Schema精确等价测试仍假设九类：扩为参数开启 / 关闭均精确比较完整同源Schema，没有弱化为部分字段匹配。
- 新Harness测试初稿误用 `selection.tools`、错认首步直接编辑及错误文案，按真实“先检索→编辑”的入口修正，保留完整工具链测试。
- 浏览器脚本初稿未统一合成Python比较时区，另误将SQL额外列当成图表投影列；只修正合成脚本、保持SQL / Python全值及图表选定字段的严格校验。失败项目与证据保留，标签修复后全新项目完整重跑。
- 实库预检首次PowerShell引号错误未连接数据库，改为stdin传脚本后通过，原失败日志保留。

## 保留范围、后续替换与风险

- 模型替换仍改 `core/ai/server/harness-composition.ts` 及对应 `HarnessModel` 适配；本批只隔离参数契约，没有新模型接入。
- 数据库 / SQL 引擎替换继续使用 `core/notebook/execution-contracts.ts` 和 `core/connections/` 端口及服务端组装；新引擎必须明确日期、精度、取消与结果完整性差异，不保证零修改。
- Agent 策略仍归 Harness 规划与上下文选择；参数工具复用原API / SSE。新增参数变体主要改 `parameter.ts` 和专属编辑器 / 测试；新增顶层Cell仍须同步定义、目录、执行、Harness、来源展示，不声称已动态注册。
- 图表继续经已有 Notebook 展示适配和Dashboard快照确认；未实现参数输入驱动线上App、自动重算、模板变量、远端绑定、结果变量自动改名或新导出能力。
- 不支持秘密参数；日期 / 浮点有既有运行适配差异，比较外部带时区日期须显式统一时区。未验证真实LLM生成质量、多人隔离负载、大数据性能或其他数据库平台。
- 独立只读审查未发现参数绕过授权 / 试运行 / 取消的新回归。已有非阻断问题保留：存在未授权连接时，模型目录可能仍提供 warehouseSql 类型，但执行授权检查继续拒绝访问；不是本批引入，不扩展修复范围。
- 只在3001验收，3000未发布。当前 `feature/eds-analysis-dashboard` / `df5bbae`，保留原未提交内容；无提交 / 推送 / 分支切换、依赖升级或文件清理。本批证据与合成项目保留在既有忽略目录，TASK-LOG沿用原忽略规则。

## 最终核验

完整测试通过：较1623基线增加106项，171文件 /1729应用测试、14 Node通过，保留3项原有跳过；新增测试未跳过。架构检查器自测1项通过，143文件源码指纹已同步；源码未引入可见循环或浏览器到服务端实现依赖。最终类型、30文件严格ESLint、构建与所涉diff检查均exit0，构建保留既有大chunk提示。分别见 [全量](../../.runtime/hex-parameters-2026-09-17/tests-closeout.log)、[类型](../../.runtime/hex-parameters-2026-09-17/typecheck-closeout.log)、[lint](../../.runtime/hex-parameters-2026-09-17/lint-closeout.log)、[构建](../../.runtime/hex-parameters-2026-09-17/build-final.log)。

交付前 `site:status` 与本批开始逐字段比较，stable / dev / capture均健康，PID、worker、revision、startedAt、restarts完全相同，开发站历史两次重启未增加。分支 / HEAD保持；TASK-LOG开始前293549字节的SHA-256核验不变。只修改本批选定源码与文档，未清理用户文件、合成项目或失败证据；完整M5及其他剩余里程碑仍未宣称完成。
