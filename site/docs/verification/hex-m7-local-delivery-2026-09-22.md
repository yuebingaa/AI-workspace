# M7 本地分析工作空间收尾验收

日期：2026-09-22。用户要求继续完成里程碑，并明确授权后续真实收费模型测试。本批冻结为：合成Excel手工及真实DSH连续分析、单表语义查询浏览器回归、EDS/只读数据库/ChangeSet等既有模块整体回归，以及开发站交付文档。不以此扩大DSH支持的Cell、原件权限或云部署范围；不发布3000、不提交推送。

结论：**M7本地版限定范围已完成并交付3001验收证据**。本批新增两份受限浏览器验收脚本，补齐真实模型连续链与语义手工链；未修改生产业务代码，也不将上轮已完成修复再次计为本轮新增功能。旧失败与能力边界详见下文，完整Hex功能仍不在完成声明内。

## 基线与测试策略

- 开始分支`feature/eds-analysis-dashboard`、HEAD `addff463`；26项Git可见未提交变更全部是上轮基线，保留。
- 完整读取运行约定、近期任务、M7路线和Agent相关架构。基线193源码指纹及全量类型通过。
- 网站模型端到端采用已配置真实收费模型；确定性单测/权限拒绝/取消和SDK协议仍用离线替身，避免不可复现或无意义收费。测试授权不等于发布、数据库写权限或开放任意外部服务。
- 收费浏览器每阶段有持久一次性开始标记；失败保留证据，不循环重试。模型内部受现有任务工具/时间边界约束，本批不修改产品配额。
- 所有页面使用3001、独立合成项目/隔离浏览器；真实PG仅使用归属与最小权限核验通过的既有AdventureWorks实例。不读取用户原始业务文件进行模型测试。

## 已执行回归

1. EDS合成工作簿/API/下载、单表语义/模型引用/采用、只读连接与ChangeSet/工作界面：定向29文件270项通过；真实EDS原件3项因缺专用环境路径按原规则跳过，不计通过。随后26项Node工具通过。[日志](../../.runtime/m7-vertical-2026-09-22/offline-regression.log)。
2. `npx vitest run core/architecture/module-boundaries.test.ts --maxWorkers=2`：33项通过。检查真实源码导入、循环及浏览器/服务端边界，不扫描第三方依赖。[日志](../../.runtime/m7-final-boundaries.log)。
3. 先使用`openOwnedAdventureworksReader`复核实例PID/监听/集群/reader权限：12秒超时、只读、无TEMP/CREATE/写入/超级用户/绕过RLS权限。随后运行现有`verify-adventureworks.mjs`，独立证据目录内10组真实数据库检查通过，0模型网络。[报告](../../.runtime/m7-adventureworks-20260922-run-1/report.json)。
4. `node scripts/verify-dsh-capabilities.mjs`：官方SDK子进程+真实业务桥+合成XLSX+Pyodide/openpyxl+DuckDB表图通过；数据库I/O为明确替身。模型动作固定，不是收费模型质量或网站HTTP验收。[报告](../../.runtime/dsh-capabilities-1790080834908/report.json)。

真实数据库链覆盖10张授权表/107字段、31,465订单、38月、10地区，与独立原生查询对照；精确numeric保持字符串，图表按明确规则转数值。PG→DuckDB→表图/受控文本、参数重算与独立分支缓存、Dataset快照来源/重开、Dashboard预览/确认应用/撤销、截断拒绝/权限/取消重试以及原Harness真实工具待采用全部通过。未注册新网站连接或修改开发站凭据/数据库数据；该证据是进程内真实API实现，不冒称浏览器HTTP链。

## 浏览器验收

### Excel 与真实 DSH

新脚本`scripts/verify-m7-excel-live-browser.mjs`分无模型准备、首个收费任务、第二个收费任务。合成工作簿`Sales`三行East100/East50/South80；UI选择工作表，真实上传派生Dataset和完整XLSX，复核磁盘原件字节、表行和摘要。四个人工Data/SQL/Table/Chart单元真实输出150/80。

第一收费阶段通过：1个公开HTTP/SSE任务、6次模型调用、6工具（3检索、编辑、运行、提交），无工具失败；仅新增SQL/Table/Chart三个单元，试运行后待确认。UI显式采用，revision8→9；人工独立运行既有150/80和新300/160，运行身份不同于模型试运行。新标签页重开同会话/七单元/一表一原件，不自动再调用AI或运行；正式看板仍空白。

第二收费阶段同样一次通过：新浏览器打开同一项目和会话，发送用户原句“帮我看一下，能不能给我一个分析的结论”；5次模型/5工具（两次检索→本轮运行→两次结果检索），completed / verification passed。输出正确区分原150/80与翻倍300/160，说明总460和份额不变；没有编辑、提交失败、新草稿或采用，正式七单元revision9、空白看板不变。历史聊天不作为运行证据，本轮真实run与后续输出检索均可见；公开trace不含私有runId，不伪造此字段。

两轮合计**2个公开AI请求、11次真实模型调用、11次工具调用**，无付费重试。历史JSON的`modelRequests:1`实际是脚本公开HTTP计数，不是模型调用数；实际模型数取各task的`counters.modelCallCount`（6+5），脚本已改为`publicAiRequests`和独立模型计数，保留历史报告并附解释。费用/完整Token没有获得可核账值，不能记录为0。没有替换模型、分析响应、SSE或数据/保存响应；仅过滤不属于当前项目的目录GET和外部字体，用于隔离隐私与页面稳定。

证据目录：[`m7-excel-live-2026-09-22/browser-1790080971228`](../../.runtime/m7-excel-live-2026-09-22/browser-1790080971228/)。准备三图、第一阶段五图均由验收代理实际查看；主代理复看[原150/80](../../.runtime/m7-excel-live-2026-09-22/browser-1790080971228/prepare-02-real-chart-1440.png)、[采用前差异](../../.runtime/m7-excel-live-2026-09-22/browser-1790080971228/first-03-unadopted-draft-1440.png)、[新300/160](../../.runtime/m7-excel-live-2026-09-22/browser-1790080971228/first-04-real-doubled-chart-1440.png)、[重开的会话](../../.runtime/m7-excel-live-2026-09-22/browser-1790080971228/first-05-reopened-conversation-1024.png)。

第二阶段三图均由验收代理查看，主代理复看[真实展开过程](../../.runtime/m7-excel-live-2026-09-22/browser-1790080971228/second-02-real-trace-1440.png)与[1024结论开头](../../.runtime/m7-excel-live-2026-09-22/browser-1790080971228/second-03-readonly-answer-1024.png)。长答案保持原纯文本Markdown并正常纵向滚动，1024截图只显示答案上部，不冒称所有数值在同一张截图可见；完整答案和数值在`second-report.json`中核对。没有改变富文本/语言策略或手机支持。

失败保留：首次准备停于测试工作表选择器，独立目录`browser-1790080910856`无上传/AI；修测试后新项目完成准备。第二次准备的末尾全登记检查与并行语义项目新增冲突，原`prepare-report.json`仍为false；仅追加`prepare-recheck-report.json`只读核对既有数据/回执，不重做项目、计算或付费。准备期原完整登记快照未落盘，因此不追认当时全登记保全通过。收费阶段串行运行，first/second均登记113→113、其他项逐值保持。后续运行要求与其他项目验收串行，严格保护不放宽。

### 手工语义模型

新脚本`scripts/verify-m7-semantic-browser.mjs`全部通过现有UI创建项目、导入CSV/原件、创建与预览单表语义模型、配置Data/semanticQuery/Table/Chart并运行，保存后新标签页重开同模型/定义再运行；三次真实运行（2/4/4单元）均150/80，0模型任务。实际报告中route/page/consoleErrors均为空。首轮停止于测试来源select定位，修选择器后同一项目续验，失败证据不删除；没有产品代码修复。

四张成功图和首轮失败图由验收代理查看；主代理复看[语义编辑器](../../.runtime/m7-semantic-browser-2026-09-22/browser-1790080983896/1790081048958-02-semantic-editor-1440.png)、[重开后1024表图](../../.runtime/m7-semantic-browser-2026-09-22/browser-1790080983896/1790081048958-04-reopened-results-1024.png)。模型预览图仅可见配置，预览行在滚动区域下方，不冒称首图显示结果。[完整报告](../../.runtime/m7-semantic-browser-2026-09-22/browser-1790080983896/report.json)跨两次attempt：项目创建/导入在第一次，后续步骤在恢复运行，不是一次完整从零执行。此链不经过DSH。

验收后独立审查修正了脚本的步骤归属记录（executed / reusedExisting）并增加控制台错误断言；只读复核见[attempt说明](../../.runtime/m7-vertical-2026-09-22/SEMANTIC-ATTEMPT-REVIEW.md)。未重写历史报告，也未为了报告字段补跑计算或收费；这些报告层修正只复验语法/严格lint。

## 当前模块与替换入口

本批新增的是可重复验收和使用说明，没有搬迁生产模块或增加新业务抽象。原API、工具名、权限、持久化和用户确认机制不变；本轮真实链检查这些已有接口协作。

| 模块 | 现有职责 / 替换落点 | 必须保留的差异 |
| --- | --- | --- |
| Agent / Harness | `core/harness/`规划、工具、上下文与验证；`core/agent-engines/contracts.ts`的`AgentExecutionEngine`及`server/executor.ts`选择整执行器 | 替换循环不等于替换授权、工具或正式文档；未知能力明确拒绝 |
| Model / DSH | 原模型`core/ai/server/harness-composition.ts`；DSH的`server/dsh-driver.ts` / `runtime/dsh/driver.mjs`隔离SDK、模型wire与子进程 | 不同服务的工具、图片、流式协议须独立适配和复验；不宣称零成本切换 |
| Tools | `core/harness/server/notebook-tool-bridge.ts`复用Notebook业务；`tool-broker.ts`仅做受控传输 | 私有真实运行与提交回执是交付依据，不信任SDK最终文本 |
| Notebook | `definition.ts` / `graph.ts`拥有Cell和依赖；`execution-contracts.ts`的`NotebookQueryExecutor`、Python会话等窄端口，由`server/runtime.ts`组装 | 没有完整动态Cell插件；注册目录不等于任意类型可安装执行 |
| Dataset / SQL | `core/datasets/repository.ts`仓库端口；`core/connections/server/query-contracts.ts`的`ConnectionDriver`、`query-service.ts`隔离数据库；本地DuckDB在Notebook适配 | 授权/来源/精度/取消/截断不能抹平；数据库最小权限仍由数据库执行 |
| Semantic | `core/semantic/`拥有单表定义、指标及编译，人工Notebook复用 | 不支持跨表Join；DSH尚未挂载对应能力 |
| Dashboard / Project | Notebook结果到快照由`core/notebook/dashboard.ts`和相关模块处理；`core/changesets/`确认/应用/撤销，`core/projects/`保存版本状态 | 不是实时发布App；结果预览、持久Dataset、正式定义和聊天不是同一状态 |

替换上述实现应先保持契约测试，再用对应真实链复验；浏览器不能导入服务端SDK。现有深层导入和局部兼容导出保留，不为交付制造全仓路径迁移；未新增第二套模型、SQL或图表业务实现。

## 明确保留的能力边界

- XLSX UI允许选择工作表，但一次文件导入只把选中工作表转换为Dataset；完整XLSX另作为项目原件保存。Dataset可能记录派生CSV名称，不能据此说原始Excel未保存，也不能称一次导入所有工作表。
- 重开项目后，人工Notebook可按明确`fileNames`读取唯一项目原件；DSH仍只使用当前请求实际附带的原件。保存文件不代表AI自动读取该目录。本批Excel跨重开主链使用持久Dataset+Data/SQL/Table/Chart，不把它包装成原件自动重附。
- 语义查询、参数、文本属于已有Notebook/原Harness能力；当前DSH并未开放`semanticQuery/text/parameter`，不静默回退旧执行器。语义查询手工回归不证明DSH已支持它。
- 模型自然语言答案依赖本轮运行证据，但并非逐句数学证明。不可获得的扫描字节数、Token或费用不能伪造，完整费用以服务商账单为准。
- 看板此阶段交付显式快照和绑定，不是实时数据库App；无任意Python包、持久Kernel、跨表语义Join、OAuth多人权限、生产写入或完整Hex私有架构复制。

## 工作区与启用状态

只使用既有依赖、端口和服务管理器；当前DSH revision7/activeTasks0保持，稳定3000仍旧独立发布。三服务PID、worker、revision、启动时间、重启数、健康与stable release前后逐值一致；已核归属的AdventureWorks实例PID/只读权限未变，没有启停、重建或修改数据库。

本批文件：新增`scripts/verify-m7-excel-live-browser.mjs`、`scripts/verify-m7-semantic-browser.mjs`和本文；更新根`README.md`使用说明、`agent-architecture.md`正文/变更记录、`hex-alignment-roadmap.md`状态与`visual-design.md`实际截图入口。无源码搬迁/删除、依赖/锁文件/配置变更。原26项未提交修改保留，最后30项Git可见（23修改/7未跟踪，其中4个文件是本轮首次改变Git状态），分支/HEAD不变；没有暂存、提交、推送。根TASK-LOG、合成项目和运行截图按现有规则仅本地保存，不强制加入Git。

## 最终命令与结果

命令均在`site/`执行，首次运行前检查目的和副作用；没有运行默认付费评测或未经核对的数据库恢复脚本。

| 实际命令 | 本轮结果 / 证据 |
| --- | --- |
| `npm test -- --maxWorkers=2` | 257文件2975应用通过；原EDS1文件3项跳过；26 Node工具通过。[全量日志](../../.runtime/m7-final-full-test.log) |
| `npm run typecheck` | 基线、收尾、构建后均通过；[构建后日志](../../.runtime/m7-final-typecheck-after-build.log) |
| `npx vitest run core/architecture/module-boundaries.test.ts --maxWorkers=2` | 33项通过，也包含在上述全量内，不重复计总数 |
| `node --test runtime/dsh/driver.test.mjs runtime/dsh/tool-diagnostics.test.mjs` | 20项通过，使用SDK固定模型与本机测试broker，不收费；[日志](../../.runtime/m7-final-sdk-tests.log) |
| `node scripts/verify-dsh-capabilities.mjs` | 合成XLSX/Python/DuckDB真实业务链通过，DBI/O替身；见上文报告 |
| `node scripts/test-database/verify-adventureworks.mjs --runtime-dir <已核归属的既有本机测试实例> --evidence-dir <本次独立证据目录>` | 10组真实只读数据库检查通过；占位符仅为报告脱敏，执行时为已核实的绝对路径 |
| `node scripts/verify-m7-excel-live-browser.mjs` | 准备实际计算通过，末尾并行登记断言未通过；原false与只读复查分开保留 |
| `node scripts/verify-m7-excel-live-browser.mjs --allow-paid-first .runtime/m7-excel-live-2026-09-22/browser-1790080971228` | 一次真实公开任务成功；后续重复相同阶段会被持久标记拒绝 |
| `node scripts/verify-m7-excel-live-browser.mjs --allow-paid-second .runtime/m7-excel-live-2026-09-22/browser-1790080971228` | 一次真实公开任务成功，无重试 |
| `node scripts/verify-m7-semantic-browser.mjs`，随后`--resume .runtime/m7-semantic-browser-2026-09-22/browser-1790080983896` | 首次选择器失败，修测试后同项目续验成功；逐attempt实际步骤见说明 |
| `node --check`两份新脚本；`npx eslint scripts/verify-m7-excel-live-browser.mjs scripts/verify-m7-semantic-browser.mjs --max-warnings=0` | 语法与严格lint通过；未执行全仓lint、未全仓格式化。[lint日志](../../.runtime/m7-final-lint.log) |
| `npm run docs:agent:sync`、`npm run docs:agent:check`、`npm run docs:agent:test` | 正文更新后193源码指纹一致；检查器1项通过 |
| `npm run build` | 成功，保留已有大于500kB chunk提示；PowerShell将该stderr警告标为NativeCommandError，实际构建退出码0。[日志](../../.runtime/m7-final-build.log) |
| `git diff --check`、`npm run site:status` | 通过；服务未变，未提交/发布。Git仅提示现有LF/CRLF转换设置 |

没有发现本批新增产品回归。验收脚本初次选择器和并行登记失败已如实归属；元数据报告修正没有另跑浏览器来伪造历史成功。额外只读服务日志比较首次遇PowerShell UTF-16编码解析失败，按BOM正确读取后逐值核对通过，未因此操作服务。

## 交付边界与后续使用

本轮可在3001演示本地文件→Notebook计算→表图→AI草稿确认→保存重开→继续追问；旧参数/快照取消/撤销由前批UI证据及本轮自动化/实库回归覆盖。本批不重新拍摄所有旧EDS/ChangeSet交互，EDS真实原件仍未验证；真实模型未使用用户私密工作簿。DSH原件Python为本轮固定模型复验、真实模型+实库为此前专项证据，本批两轮付费仅为本地Dataset SQL链，不能把分层证据合成同一端到端测试。

DSH的alpha SDK/旧安装依赖风险仍保留，本轮不升级或重新审计供应链；换SDK/模型/数据库实现须在对应适配入口重新验收。原图表大分块、纯文本Markdown与偶有英文前言保留，没有以本次功能验收代替全面性能或语言质量评测。跨表语义、其他DSH Cell、自动原件重附、完整持久Kernel/多人权限/动态发布均属独立后续产品范围，不再作为无限追加本轮里程碑的理由。
