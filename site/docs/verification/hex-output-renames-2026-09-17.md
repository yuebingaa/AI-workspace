# Hex 第十一批：输出变量改名影响检查

日期：2026-09-17。状态：本批限定范围源码、回归、真实本地数据库兼容及 3001 截图验收完成；未发布 3000。

## 本批范围与基线

- M5：人工保存与 AI 草稿共同使用纯改名影响分析；按稳定 Cell ID 保留结构化引用，列出直接 SQL / Python 消费者及 Python 自身输出赋值检查项。自由代码不自动改写。
- 人工保存先校验整个候选文档，再确认改名；取消保留编辑内容，确认不自动执行。沿用现有结果失效、任务内版本、真实试运行和人工采用机制。
- 不新增持久字段、工具、接口或数据库 / 模型能力；不做自动重算、SQL / Python 语义改写、M6 能力禁用或完整结果仓库。
- 代码证据：`components/studio/notebook/NotebookPanel.tsx` 原保存直接替换单元；`core/notebook/graph.ts` 的引用按 ID；`core/notebook/server/execution.ts` 按当前 `outputName` 注入 SQL / Python 输入。原 `editNotebookCells` 缺少同源检查回执。
- 修改前 `npm test -- --reporter=dot --maxWorkers=2`：1,729 项应用测试通过、3 项原有跳过，另 14 项 Node 测试通过。日志位于 `.runtime/hex-output-renames-2026-09-17/tests-baseline.log`。
- 当前分支 `feature/eds-analysis-dashboard`，保留所有原有未提交 / 未跟踪内容。只在已有 3001 开发站验证，不提交、推送、发布或启停服务。

## 工作记录

- 已完成只读审计并冻结以上范围。M6 禁用涉及 UI、执行入口、工具目录和恢复的统一状态，留后续独立批次。
- 纯影响分析、人工保存确认 / 草稿审阅、两个工具回执已落地；领域 17 项、UI 22 项、Harness 7 项，共新增 46 项测试。相关 5 文件 66 项、UI 含原有相关测试 5 文件 82 项通过；目标测试发现的夹具字段 / unknown 读取类型问题已修正，没有删除或弱化失败断言。
- 数据库原链路 8/8 通过，确认只读角色、回环地址、所属进程及默认查询限制；运行前后实验库进程未变。全量最终检查与截图结论见下方收尾记录。

## 实际文件与模块归属

```text
core/notebook/
  output-renames.ts / .test.ts                新：纯改名影响分析与 17 项测试
core/harness/
  notebook-cell-tools.ts                      改：任务内编辑后返回同源检查项
  tool-registry.ts                            改：两个既有编辑工具补充代码核对说明
  notebook-output-renames.test.ts             新：7 项工具 / Context / 真实 SQL 验证
components/studio/notebook/
  output-rename-review.ts / .test.ts           新：候选保存和陈旧确认保护、12 项测试
  NotebookOutputRenameReview.tsx / .test.tsx   新：共用影响说明 / 确认卡、10 项测试
  NotebookPanel.tsx                           改：组合候选确认，仍拥有编辑 / 结果状态
  NotebookDraftReview.tsx                     改：采用前展示同源改名影响
core/architecture/module-boundaries.test.ts   改：纯分析纳入依赖保护
app/notebook-cells.css                        改：8 条限定 Notebook 的灰度审阅样式
scripts/verify-notebook-output-renames.mjs     新：隔离项目交互 / 实际执行 / 截图验收
scripts/fixtures/output-renames.mjs            新：固定模型选择、真实工具 / 执行的回放产物
```

同步维护架构入口、里程碑、视觉规范、本报告与根任务日志。没有移动 / 删除源码、修改锁文件或增加依赖；后续提交时须同时包含新增文件，不能只提交已跟踪文件。Git 相对 HEAD 的差异还包含此前批次，不等于本批改动量。

## 状态与接口边界

`analyzeNotebookOutputRenames` 只依赖 Notebook 类型和显式依赖图，不依赖 React、模型 SDK、SQL 驱动、Harness 或服务器。返回旧 / 新名称、保留引用、待核对代码和最终受影响 ID，不携带源码 / 数据行 / 参数值，也不生成第二份运行状态。后续改影响规则主要在此模块和测试完成。

浏览器候选保留完整文档基线，确认挡住同修订内容替换或单元移除；返回编辑不丢输入，关闭过期编辑不覆盖外部变更。原有新建流程先插入默认单元再编辑，因此首次修改其默认输出名也需要确认，没有新增自动保存或执行例外。结果新鲜度仍由原定义 / 祖先指纹判断，独立链不失效。

Agent 仍选择模型契约和既有工具；Tool 调用同源分析，Harness 继续持有任务内版本和运行证据。`editNotebookCells` / `createPythonCell` 的名称、参数与权限不变；仅改名时回执追加影响元数据。普通 / 压缩 Context 均保留检查项。旧成功回执因编辑失效；修复 SQL 后须重新成功运行、提交并由用户采用，不把代码检查当作运行证明。

SQL / Python 实现、Dataset 来源 / 持久化、Dashboard 快照 / ChangeSet 未改变。以后替换查询 / Python 执行仍走现有执行端口；替换模型仍走 `HarnessModel` 及模型适配入口，本批不宣称隔离了所有历史耦合。更换审阅 UI 只需保留候选确认与纯影响契约，无需复制业务判定。

## 验证与边界

所有命令在 `site/` 执行。没有真实模型调用；数据库只使用既有本机只读测试环境，没有使用用户业务数据。

| 实际检查 | 结果 / 证据 |
| --- | --- |
| 修改前 `npm test -- --reporter=dot --maxWorkers=2` | 1,729 应用 / 14 Node 通过，3 原有跳过；`tests-baseline.log` |
| 领域、Harness 和架构相关 `npx vitest run … --reporter=dot --maxWorkers=2` | 5 文件 66 项通过；`related-tests.log`，含真实 DuckDB 旧名失败 / 修复、旧回执拒绝 / 取消、Context 与最终名称交换 |
| UI 相关测试 | 分工检查 5 文件 82 项通过，收尾复查 3 文件 49 项通过；本批新增 22 项，收尾日志 `ui-related-tests.log` |
| 最终 `npm test -- --reporter=dot --maxWorkers=2` | 175 文件、1,775 应用测试通过，3 原有跳过；另 14 Node 通过，无新增失败；`tests-final.log` |
| `npm run typecheck` | 通过；`typecheck-final.log` |
| `npx eslint <本批12个TS/TSX文件> --max-warnings 0` | 通过；`lint-final.log`，不是全仓 lint |
| `npm run build` | 成功退出；`build-final.log`，保留既有大于 500 kB 的 chunk 提示，没有关闭检查 |
| `npm run docs:agent:sync` / `check` / `test` | 指纹 144 源码文件一致，检查器 1 项测试通过；`docs-*.log` |
| `node --check scripts/verify-notebook-output-renames.mjs` 与 `scripts/fixtures/output-renames.mjs` | 两脚本语法通过 |
| `node scripts/verify-notebook-output-renames.mjs` | 最终 7 组 / 15 图 / 11 次真实 HTTP 运行通过；9 成功、2 预期失败 |
| 原 `verify-adventureworks.mjs --runtime-dir … --evidence-dir …` | 8/8 通过；只读预检、后检均通过，无库服务操作 |
| 所涉 `git diff --check`、新增文件逐行空白检查 | 通过；保留现有行尾约定，未全仓格式化 |
| `npm run site:status` 前后比较 | 三个服务均健康；supervisor、PID / worker、revision、restarts、startedAt 均未变化 |

本批证据根目录：`.runtime/hex-output-renames-2026-09-17/`。原 AdventureWorks 验收：10 表 / 107 字段、31,465 订单、38 月、10 地区及 9 条查询回执一致；固定模型替身经 4 个真实工具后停在待确认。该脚本直接调用真实服务端模块，不冒充浏览器数据库 / SSE 或真实 LLM。报告 `adventureworks-chain/report.json`，预检 / 后检 `database-precheck.log`、`database-postcheck.log`。

### 本批新截图

最终浏览器报告：[7 组验收与 15 图索引](../../.runtime/hex-output-renames-2026-09-17/browser-1789606924544/report.json)。全部图片逐张实际查看；主代理另复核人工确认、AI 审阅的 1440 / 1024 展示。使用新隔离合成项目，不依赖旧截图；页面异常 / 禁止请求为 0，连接列表 GET 是 3 次明确空目录替身，不冒充真实浏览器数据库查询。

| 场景 | 代表截图 |
| --- | --- |
| 改上游名前说明直接代码与受影响链 | [1440 确认卡](../../.runtime/hex-output-renames-2026-09-17/browser-1789606924544/02-upstream-impact-review-1440.png) |
| 返回保留未保存输入、取消不保存不执行 | [1024 返回编辑](../../.runtime/hex-output-renames-2026-09-17/browser-1789606924544/03-return-keeps-unsaved-name-1024.png) |
| 旧 SQL 真实失败、下游阻断与人工修复 | [下游阻断](../../.runtime/hex-output-renames-2026-09-17/browser-1789606924544/06-chart-blocked-1024.png) |
| Python 自身输出赋值须核对 | [确认卡](../../.runtime/hex-output-renames-2026-09-17/browser-1789606924544/09-python-self-output-review-1440.png)、[真实缺失输出报错](../../.runtime/hex-output-renames-2026-09-17/browser-1789606924544/10-python-missing-renamed-output-1440.png) |
| AI 待采用草稿使用同源改名说明 | [1440](../../.runtime/hex-output-renames-2026-09-17/browser-1789606924544/14-ai-draft-rename-review-1440.png)、[1024](../../.runtime/hex-output-renames-2026-09-17/browser-1789606924544/15-ai-draft-rename-review-1024.png) |

浏览器 AI 部分是明确的 SSE 回放：固定模型选择驱动 4 个真实 Harness 工具及 1 次完整 SQL / Python 试运行，核对结果 200 / 300、回执一致和待确认，再将真实任务回放到界面。“暂不采用”没有改变正式文档；不是收费模型验收，也不声称验证了真实服务端 SSE 网络。其他截图覆盖重复名拒绝、未关联链保留、结构化图表引用与保存重开。

两次早期浏览器失败都属于脚本操作顺序：未取得已运行字段就创建图表；以及重跑公共上游后仍试图截图已失效 Python 结果。调整创建 / 取景顺序后第三轮手工全过，第四轮含 AI 回放全过；失败项目和证据保留，未修改产品或断言来掩盖问题。浏览器的取消覆盖确认 / 编辑取消，不冒称新增验证了运行中止。

## 工作区与剩余风险

分支仍为 `feature/eds-analysis-dashboard`。没有提交、推送、切换或合并分支，没有启停 / 重启 / 发布网站，也未生成分发压缩包。3001 随源码生效并通过验收，3000 仍运行原独立版本。已有大量未提交 / 未跟踪改动全部保留；任务期间另一个研究会话追加的日志条目亦保留，原日志 300,255 字节前缀 SHA-256 与开工时一致。

边界：只看声明的 ID 依赖，隐藏自由代码引用不会被可靠识别；不使用正则自动改名。SQL / Python 仍可能在运行时失败。远端数据库不支持本地变量名绑定，因此不会把数据库表名误判成 Notebook 输出名。没有自动重算、生产 / 外部库验证或真实模型质量评估，完整 M5 / M6 未完成。
