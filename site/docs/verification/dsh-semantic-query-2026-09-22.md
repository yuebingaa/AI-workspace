# DSH 接入已有单表语义查询

日期：2026-09-22。延续用户“继续”，在M7本地版交付之后选定独立小批：让DSH消费用户本次选择的既有单表语义模型，复用现有semanticQuery/表图/草稿确认机制。不是重开M7扩大总验收，也不同时接入参数、文本、跨表关系或自动原件重附。

## 冻结范围与边界

- 开场分支`feature/eds-analysis-dashboard`、HEAD`addff463`，30项既有Git可见修改保留；基线193指纹与全量类型通过。已读运行约定、近期任务、Agent架构和实际handler→engine→bridge→Notebook链。
- 网站notebook profile仅在单一模型来源匹配当前数据源、来源在授权scope且模型字段/聚合合法时开放semanticQuery；旧CSV试点保持原四类。未选择模型时不在编辑目录承诺此能力，已有语义单元返回明确的有限初始化原因。
- 模型定义仍是浏览器提供、服务端规范校验后的用户业务快照，不是服务端独立权威项目版本锁。数据来源权限及forAi脱敏仍由原仓库/执行器控制；模型说明不是权限或指令。
- 初始化复用`validateSemanticModel`与既有`createHarnessNotebookArtifact`检查模型ID/版本、直接Data上游与成员，仅投影语义单元及其直接上游，避免不相关SQL/图表错误阻止AI进入修复；编辑、运行、提交继续整稿校验。DSH初始上下文传递带不可信标记的模型定义，不附原始数据行。
- 不新增querySemanticModel工具或任意SDK插件，不允许模型创建/修改/删除语义模型，不新增文件/数据库访问。保留原API、Schema、工具名、预算、取消/撤权、人工采用与持久化。
- 既有模型采用预检只判断ID存在，版本/字段由实际运行检查（现有测试明确保留此策略）；本批不改。模型改版后旧草稿仍可能被采用，但运行会拒绝版本不符，需要重新生成/选择；不把这称为已实现跨任务语义修订锁。

## 实际修改及模块边界

| 文件 | 职责与本批变化 |
| --- | --- |
| `core/harness/server/notebook-tool-bridge.ts` | 按本次选择开放canonical semanticQuery；模型/来源/已有单元预检；工具说明提供成员key和固定聚合规则。仍只是业务工具适配，不复制语义计算 |
| `core/harness/server/bridge-preflight.ts` | 新有限原因`semantic_model_unavailable`，不附原始异常、模型内容或私密配置 |
| `core/agent-engines/server/dsh-engine.ts` | 受控上下文白名单传入原selector生成的semanticModel；DSH仍负责决策和工具调度，不直接读数据文件 |
| `core/agent-engines/server/selection.ts` | 设置中的已有Notebook插件说明同步单表语义能力；未新增插件/开关/工具 |
| `components/studio/AgentEngineSettings.tsx`及同名测试 | 同步原静态范围文案，去除“所有语义模型不支持”的过时提示，明确单表支持与其他未开放Cell；无布局/设置逻辑变化 |
| `core/harness/server/notebook-semantic-bridge.test.ts` | 新20案，覆盖模型/权限/来源/目录、非法编辑、快照隔离及允许修复其他坏单元 |
| `core/agent-engines/server/dsh-semantic.test.ts` | 新11案，固定driver+真实语义执行、只读结论、敏感策略、取消/撤权、正式定义不变 |
| `app/api/ai/harness/dsh-engine.route.test.ts` | 保留原26案并增加12案；真实JSON/SSE handler与合成持久CSV，合法执行及非法请求在driver前拒绝 |
| `scripts/verify-dsh-semantic-browser.mjs` | 新隔离浏览器验收；复用已有手工准备器，每个AI阶段需显式参数并在转发前落盘一次标记，失败不自动付费重试 |

既有`handler.ts`、Notebook执行器、`compileSemanticQuery/executeDataRecipe`、Schema、模型管理UI与采用流程未修改。数据权限和forAi策略由原业务执行器控制，正式状态仍由用户确认后保存；更换Agent不会要求再写一套指标引擎。没有文件删除、搬移、依赖升级或新数据库适配。

## 3001实际链路与截图

本批创建一个新合成CSV项目：East100/50、South80，单表模型`area→region`、`revenue=sum(amount)`；不同于上批M7项目。模型/原件/表字节与正式定义逐阶段核对。验收不替换模型、SSE、工具结果或保存响应；仅阻断无项目范围目录和外部字体，避免打开用户目录。

- 无AI准备：UI导入/模型创建/四单元配置，三次真实运行及新标签重开均150/80。四张图由验收代理逐一查看，主代理复看[语义编辑器](../../.runtime/m7-semantic-browser-2026-09-22/browser-1790083947278/1790083947278-02-semantic-editor-1440.png)、[重开实际表图](../../.runtime/m7-semantic-browser-2026-09-22/browser-1790083947278/1790083947278-04-reopened-results-1024.png)。[准备报告](../../.runtime/dsh-semantic-browser-2026-09-22/browser-1790083946856/prepare-report.json)。
- 未选模型：通过UI取消本次模型选择，真实公开请求blocked，有限原因`semantic_model_unavailable`，模型0/工具0，正式四单元不变；然后通过UI恢复原选择。三张图已查看，主代理复看[1024原因](../../.runtime/dsh-semantic-browser-2026-09-22/browser-1790083946856/missing-model-03-blocked-1024.png)。[失败状态验收报告](../../.runtime/dsh-semantic-browser-2026-09-22/browser-1790083946856/missing-model-report.json)中的passed表示预期拒绝已验证，不是分析成功。
- 收费第一轮：一次公开请求，6次模型/6次成功工具（3次cellSearch→edit→run→submit）；模型保留原四单元、新增semantic总收入与表格，试运行成功后待确认。UI审阅[两项差异](../../.runtime/dsh-semantic-browser-2026-09-22/browser-1790083946856/first-03-draft-review-1440.png)，显式采用revision8→9/六单元；独立人工run得[230](../../.runtime/dsh-semantic-browser-2026-09-22/browser-1790083946856/first-04-total230-1440.png)，原150/80保持。新标签[重开同会话](../../.runtime/dsh-semantic-browser-2026-09-22/browser-1790083946856/first-05-reopened-1024.png)，无额外AI/自动运行；五图已逐一查看，主代理复看上述三图。[首轮报告](../../.runtime/dsh-semantic-browser-2026-09-22/browser-1790083946856/first-report.json)。
- 收费第二轮：同一会话用“帮我看一下，能不能给我一个分析的结论”追问，一次公开请求/4次模型/3次成功工具（2次检索+本轮重新运行），completed/只读验证通过，无编辑或提交。回答总额230、East150/South80及小样本限制，正式六单元revision9/模型/看板不变。实际查看[展开过程](../../.runtime/dsh-semantic-browser-2026-09-22/browser-1790083946856/second-02-trace-1440.png)、[1024答案开头](../../.runtime/dsh-semantic-browser-2026-09-22/browser-1790083946856/second-03-answer-1024.png)；1024图不包含后段数值，不冒称单图全文可见。四张第二轮图由验收代理查看，主代理复看上述两张。[第二轮报告](../../.runtime/dsh-semantic-browser-2026-09-22/browser-1790083946856/second-report.json)。
- 设置截图发现原静态段仍写“不支持语义模型”而插件卡已更新；保留旧图和问题说明，最小修正文案并增强原组件测试（10项通过）。运行已有`node scripts/verify-dsh-live-settings.mjs`纯GET补验，零AI/设置修改/项目写入，[报告](../../.runtime/dsh-live-settings-2026-09-22/browser-1790084491545/report.json)通过，两张新图实际查看；主代理复看[一致的范围段与插件卡](../../.runtime/dsh-live-settings-2026-09-22/browser-1790084491545/01-dsh-available-top-1440.png)。没有重新调用收费模型。共18张本批新截图实际查看，首个不一致的设置图没有删除或冒称已经通过。

合计3次公开任务请求：一次预检拒绝、两次收费成功；实际模型10次/工具9次。完整Token/账单金额未获核对，不写零费用，无收费重试。准备登记113→114、各任务114→114且其他条目逐值保持，当前DSH revision7/活动0不变。历史聊天中“请采用/尚未修改”的原答复在采用后仍作为历史保留，不冒称该文案动态刷新；本批不改聊天渲染。

## 检查与失败记录

- 新bridge语义范围先RED；接线后原95项通过。首轮GREEN中一个旧测试把variant误写成semantic而非semanticQuery，纠正准确有限原因后通过，没有削弱拒绝。
- 独立审查发现全Notebook初始化校验会阻止修复无关错误SQL/图表，新增回归实际RED（[日志](../../.runtime/dsh-semantic-repair-red.log)）后改成直接语义子图；修复前运行仍拒绝且runner不执行，修复后编辑正常，原正式请求不变。[最终桥接96项](../../.runtime/dsh-semantic-bridge-final.log)通过。
- `npx vitest run core/agent-engines/server/dsh-semantic.test.ts app/api/ai/harness/dsh-engine.route.test.ts --maxWorkers=1 --reporter=verbose`：[2文件49项](../../.runtime/dsh-semantic-engine-http.log)通过。engine11案第一次执行已GREEN，不伪称先RED。HTTP错源/字段/聚合400、pending403在driver前拒绝；无旧Harness或外部模型网络调用。
- `npm test -- --maxWorkers=2`第一次及静态文案/断言补齐后最终复跑均退出0：259文件/3019应用+26工具通过，原3项真实EDS因缺专用文件跳过，不计通过；[最终日志](../../.runtime/dsh-semantic-full-tests-final.log)。边界测试已含在全量中，不重复累计。
- `npm run typecheck`及构建后类型检查、12个本批TS/TSX/MJS文件严格ESLint、脚本`node --check`、`npm run docs:agent:sync`和`npm run docs:agent:check`（193源码）、`git diff --check`通过。`npm run build`退出0，保留既有500kB分块提示，[构建日志](../../.runtime/dsh-semantic-build.log)。未跑全仓lint/格式化或本批范围以外真实数据库/EDS测试，不把上一批结果再次记成本批验证。
- 服务状态只读比较中一次Node内联命令受PowerShell引号影响未能解析，改用PowerShell原生JSON解析核对；没有操作服务、改变验证断言或写入服务配置。

## 保留边界

- 一次仅选择一个既有模型，不支持多模型Notebook、跨表关系、DSH创建/删除模型、text/parameter Cell或任意DSH插件。
- forAi在语义聚合前执行敏感策略。masked别名聚合已测；exclude-sensitive-samples导致敏感维度变null时，既有DataRecipe严格分组可能拒绝，测试确认不泄漏；不将其悄悄改为聚合后隐藏，非敏感整体230可用。
- 模型修订权威锁及旧草稿采用策略仍如上；服务重启记忆、新电脑、3000发布、生产数据库、真实EDS原件及任意复杂模型质量未在本批验证。
- SDK版本和既有依赖风险未改；本批真实收费场景是明确指定语义指标的单表合成数据，不等于任意模糊需求都能稳定生成。

## 交付状态

选定的单表语义接入范围已完成，在当前3001可用；当前DSH revision7/活动0保持，源码默认仍为原Harness。稳定/开发/截图服务的PID、worker、health、revision、restarts、startedAt及稳定release前后相同，未启停或发布3000。

当前分支`feature/eds-analysis-dashboard`、HEAD`addff463`保持；42项Git可见未提交内容（31修改/11未跟踪）含开场保留的30项，本批不替用户提交/推送。四个新跟踪候选文件为两组语义测试、浏览器脚本和本报告；其他旧未跟踪文件原样保留。任务日志与本机合成数据/证据继续本地忽略，不强制加入Git。最终无已知未处理的本批新增回归；前述能力、版本锁、显示文案与测试范围限制保留，不宣称全Hex架构已完成。
