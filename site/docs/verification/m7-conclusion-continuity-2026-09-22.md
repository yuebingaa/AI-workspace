# DSH 结论请求修复与 M7 连续分析续验

日期：2026-09-22。范围冻结为结论请求识别、无编辑运行引导、安全提交原因，以及 M7 第二包尚未完成的两轮浏览器链路；不扩展新 Cell、权限、模型服务或数据库能力。分支 `feature/eds-analysis-dashboard`，起点 `addff463`，任务开始 Git 干净；不提交、推送、发布或重启服务。

## 问题与实现

历史截图对应指令是“帮我看一下，能不能给我一个分析的结论”，不是会话标题“分析input文件”。已有四个单元运行成功，但该句被宽泛“帮我…分析”规则识别为修改；通用运行回执又无条件引导提交。任务未调用编辑，随后两次提交失败，不能交付。历史未保留提交参数，不能断言两次分别触发哪个guard。

- `core/agent-engines/server/readonly-answer.ts`：完整子句识别结论请求，已选来源精确匹配；未知附加目标仍原路径。结论需本轮有效输出，禁止运行时仅定义解释。
- `core/harness/notebook-cell-tools.ts`：未编辑成功运行不再要求提交；实际编辑成功及失败的后续引导保持。DSH只读适配仍明确回答。
- `core/harness/notebook-submission-error.ts`：四个固定提交原因，保留原校验类别及顺序；无编辑仍拒绝提交。
- `server/tool-error-message.ts`、`tool-broker.ts`与`runtime/dsh/tool-diagnostics.*`、`controlled-plugin.mjs`：真实类型识别、授权复查、严格有限DTO、安全固定提示；提交诊断不进入可恢复检索证据。
- 公共JSON/SSE、执行器、工具及SDK回归覆盖真实计算、只读目录、未完成新目标拒交付、参数与错误脱敏、取消/撤权。没有绕过确认或虚构编辑。
- `scripts/verify-dsh-readonly-browser.mjs --conclusion`新增独立原句验收；M7另用`scripts/verify-agent-continuity-browser.mjs`，不更改生产入口或旧验收预算。

## 验证结果

基线类型、192源码架构检查通过。结论识别新增测试先16项失败后修复；工具/诊断亦先RED后GREEN。定向结果167项意图/执行器、193项工具/桥、20项SDK/严格DTO通过。公共HTTP新增测试首次有2项失败，是测试把DSH只读适配的`next:answer`误认为通用回执；纠正分层断言后26项通过，未因此放松生产契约。修复后类型检查通过。

最终复核另发现本轮兼容回归：“总结当前Notebook的结构”“解释当前SQL里的结论字段来源”被严格结论识别误挡。实际与HEAD模块对照复现，新增测试先4失败，再将整句解析限定为definition/result并修正；附加来源/预测/导出仍拒绝，混合结论仍要求输出，原句结论路径不变。没有为此再次收费。第一次全量在新增夹具的RED中间态启动，结果2965通过/1失败/原3跳过；失败为新增提交模式尚被旧夹具当成unsupported，保留原日志。冻结后的全量已重新执行通过。

| 最终实际命令 | 结果 |
| --- | --- |
| `npm test -- --maxWorkers=2` | 257文件通过/1文件条件跳过；2,975应用测试通过、原3项跳过；随后26项Node工具测试通过。[完整日志](../../.runtime/dsh-conclusion-full-test-final.log) |
| `node --test runtime/dsh/driver.test.mjs runtime/dsh/tool-diagnostics.test.mjs` | 20通过；官方SDK子进程/本地模型替身/严格DTO，无真实模型费用 |
| `npx vitest run scripts/dsh-tool-diagnostic-fixture.test.ts --maxWorkers=2` | 3通过，原参数和unsupported两场景兼容 |
| `npm run typecheck` | 最终冻结代码、构建后通过 |
| `npx eslint --max-warnings 0 <21个本批TS/MJS文件>` | 21文件全部通过；未全仓格式化或关闭检查 |
| `npm run build` | 通过，生成独立产物；保留既有大于500kB分块提示，不发布 |
| `npm run docs:agent:sync`、`npm run docs:agent:check`、`npm run docs:agent:test` | 193源码指纹一致，检查器1项通过；正文/变更记录已同步 |
| `git diff --check`、分支/HEAD/暂存检查 | 无空白错误；HEAD仍`addff463`，未暂存、提交、推送或切分支 |
| `npm run site:status`、只读引擎状态检查 | 前后三服务PID/worker/健康/revision/启动时间/重启数和stable release逐值一致；DSH revision7、activeTasks0 |

原3项跳过属于`core/eds/server/real-workbook.acceptance.test.ts`未提供专用真实工作簿环境路径，不把它们写成通过；没有新增跳过。第一次失败与HTTP断言修正日志均保留。两轮M7、提交失败与原句真实任务各自保持证据层次，不能相加解释为一次全部真实模型链路。

## 3001 实际验收

| 场景 | 实际链路与结果 | 截图/报告 |
| --- | --- | --- |
| 原句结论请求 | 一次真实网站任务，官方DSH/已配置付费模型/公开HTTP与SSE；3次模型、2次工具，检索和新运行成功，答案East150/South80/合计230，verification passed、completed。无失败、编辑、提交、草稿或采用。正式Notebook/AppSpec、1表1原件不变；页面/路由错误0 | [真实过程1440](../../.runtime/dsh-conclusion-browser-2026-09-22/browser-1790077913014/03-real-trace-1440.png)、[答案1024](../../.runtime/dsh-conclusion-browser-2026-09-22/browser-1790077913014/04-answer-1024.png)、[完整报告](../../.runtime/dsh-conclusion-browser-2026-09-22/browser-1790077913014/report.json) |
| 提交无修改错误 | 真实DSH引擎/业务桥guard，固定driver，正式SSE缓冲回放。1模拟模型步骤、1失败工具、无计算/编辑/草稿，有限`notebook_submit_no_changes`可读；正式定义前后不变。**不是公开handler/官方SDK/真实模型失败验收** | [失败提示1024](../../.runtime/dsh-submit-diagnostic-browser-2026-09-22/browser-1790078232607/02-safe-diagnostic-1024.png)、[报告](../../.runtime/dsh-submit-diagnostic-browser-2026-09-22/browser-1790078232607/report.json) |
| M7 两轮CSV | 新独立项目真实UI上传CSV/原件，固定模型8个动作、2次真实工具试运行、2次3001人工运行；首稿采用150/80、保存重开同会话、追问新证据300/160、第二稿暂不采用。最终1表1原件1页/正式4单元；首task completed、第二awaitingConfirmation；看板空白 | [首稿差异](../../.runtime/m7-agent-continuity-2026-09-22/browser-1790077816060/04-first-draft-1440.png)、[实际表图](../../.runtime/m7-agent-continuity-2026-09-22/browser-1790077816060/06-real-results-1440.png)、[重开同会话](../../.runtime/m7-agent-continuity-2026-09-22/browser-1790077816060/07-reopened-conversation-1024.png)、[暂不采用](../../.runtime/m7-agent-continuity-2026-09-22/browser-1790077816060/09-dismiss-retains-results-1024.png)、[报告](../../.runtime/m7-agent-continuity-2026-09-22/browser-1790077816060/report.json) |

原句验收使用独立合成CSV的Data/SQL/Table三单元，而非用户含敏感数据的Data+三个Python文档；验证请求和交付链路，不冒称复跑了用户数据。只发送1个任务，不自动重试；3次模型调用的Token/实际金额没有完整账单，不能报为零费用。浏览器仅拦截未限定项目的最近目录/连接目录保护隐私及远端字体；分析响应没有替换。

原句4张图由主代理实际查看；诊断2图由验收代理查看，主代理复看1024；M7准备2张+正式7张均由验收代理查看，主代理复看4个关键状态。没有用旧截图或DOM断言替代看图。证据位于本地忽略的`.runtime/`，未自动加入Git。

M7准备与正式验收为同一新项目的两个浏览器进程；正式包含刷新和新标签页打开，同会话历史来自单进程验收仓库，两个试运行runId不同。不是进程重启长期记忆、公开handler授权、真实DSH多轮生成或实时SSE时序证明。旧固定项目revision160/41表17原件及58个资源摘要和原failed任务逐值保持；新项目采用后最终revision8。暂不采用不代表永久删除草稿。

## 本轮命令与边界

所有npm命令在`site/`，没有执行安装、数据库迁移、发布或服务生命周期命令。

- `node scripts/verify-dsh-readonly-browser.mjs --conclusion`：新隔离准备，0模型。
- `node scripts/verify-dsh-readonly-browser.mjs --conclusion --allow-paid-model .runtime/dsh-conclusion-browser-2026-09-22/browser-1790077913014`：一次真实任务通过。
- `node scripts/verify-dsh-tool-diagnostic-browser.mjs --submit-no-changes`：离线失败场景通过。
- `node scripts/verify-agent-continuity-browser.mjs`及`--run .runtime/m7-agent-continuity-2026-09-22/browser-1790077816060`：准备3组、正式4组通过，0模型网络请求。
- `npx vitest run app/api/ai/harness/dsh-engine.route.test.ts --maxWorkers=2`：26通过；其他定向与最终汇总见上方验证结果。

架构与里程碑正文、视觉当前状态同步维护，没有迁移存储/API，模型适配仍归DSH驱动、业务计算归Notebook、纠正提示归有限诊断适配。M7第二包限定CSV浏览器链完成，下一包转合成Excel，不继续扩展本包。

## 工作区与模块边界

本轮26个Git可见变更（22修改、4新增）均未提交；另有本地忽略的任务日志/截图/隔离项目。未移动或删除用户文件，原任务日志字节前缀核对不变。新增模块仅`core/harness/notebook-submission-error.ts`，新增验收脚本/测试及本报告；没有依赖升级、锁文件再生或大规模目录搬移。

请求意图归Agent引擎，版本/运行/提交规则归Harness Notebook工具，计算/DAG/表图仍归原Notebook业务，模型只经DSH驱动和受控工具桥访问；有限诊断的跨进程序列化归DSH适配。公开入口、工具名/参数、持久化和人工采用不变。审阅本批依赖未发现新增循环或浏览器导入服务端实现；未宣称全面审计全仓。替换模型/执行器依然经既有driver/executor入口，本轮不要求连带改SQL/UI。

## 保留边界

M7合成Excel、EDS/语义/只读数据库纵向回归及最终总交付仍是后续范围。此前实库结果不作为本轮检查。语法路由是保守识别，不是完整自然语言分类；结果引用验证不代表机器逐句证明模型解释。SDK版本/既有依赖风险未处理；未发布3000，当前DSH选择revision7保持。旧失败记录不删除、不改写。
