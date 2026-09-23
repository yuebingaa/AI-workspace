# DSH 当前参数定义问答（2026-09-22）

开工及浏览器验收2026-09-22；最终复核2026-09-23。限定范围已完成，源码/3001生效，3000未发布。

## 本次范围

承接四类参数接入，修复“当前参数值是多少？”被`asksResult`当作业务结果请求，进而要求运行且被正确的参数-only保护拒绝的问题。仅新增有限定义问答路径；M7已交付范围不重开，不增加参数种类、执行权限、接口或模型/数据库实现。

## 实现与归属

- `core/agent-engines/server/parameter-inspection.ts`：整句有限中英文识别、正式参数精确定位、同版本源码覆盖。全体/所选/唯一命名分别处理；混合计算、修改、导出和未知主体不降级到本例外。
- `readonly-answer.ts`：参数问答`allowRun=false / requireOutput=false`，要求所有目标源码；旧业务结果仍排除parameter-only样本。
- `dsh-engine.ts`：原预检后固定正式revision与原搜索索引；私有记录真实检索参数offset，不把整源预塞给模型。目录仅cellSearch；原授权、取消、正式文档和草稿保护不变。
- 页长度兼容原工具2,000字符上限与result budget缩页；精确匹配原源、版本、游标，无缺口覆盖，不接受摘要、历史输出或残缺页。长参数不要求单页JSON完整，不复制参数解析/执行器。
- 新pure/真实engine测试和公共HTTP JSON/SSE回归；新`scripts/verify-dsh-parameter-question-browser.mjs`使用隔离合成项目分阶段验收。

## 工作记录与检查

- 开场分支`feature/eds-analysis-dashboard`，59项既有Git改动保留。193文件架构指纹、全量类型和三站健康基线通过；无Git写操作。
- 初始routing RED 8失败/19通过；接线并修正“参数值”被“数值”跨字匹配及“有哪些选项”顺序后，pure定义与原只读153项通过；预算缩页及动作标题歧义补齐后155项通过。未加引号且含动作/连接词的标题保守拒识，明确成对引号、精确匹配才作为元数据。
- 独立审查发现原cellSearch合法缩页，已改为真实source.length而非固定2,000；引擎另增加2000引号转义的真实分页回归。
- 同期其他会话拆分`core/harness/tool-registry.ts`；新`tools/parameter-projection.ts`曾出现import type被运行使用的TS1361，致工具目录初始化失败。本次未覆盖该并行区域，外部修复后复跑全部相关检查。中间失败日志保留，不把并行拆分记成本批实现；其15个新增生产模块加本批1个使源码指纹由193到209。
- 初次构建在prebuild因并行源码变化/指纹过期而拒绝，未进入打包。架构正文已更新后重新同步并完整构建通过；没有绕过指纹检查。

| 实际命令（site目录） | 本批结果/日志 |
| --- | --- |
| `npx vitest run core/agent-engines/server/parameter-inspection.test.ts core/agent-engines/server/readonly-answer.test.ts --maxWorkers=1` | 2文件155项通过；`.runtime/dsh-parameter-question-pure.log` |
| `npx vitest run core/agent-engines/server/dsh-parameter-inspection.test.ts app/api/ai/harness/dsh-engine.route.test.ts core/agent-engines/server/dsh-parameter.test.ts --maxWorkers=1` | 新问答17/公共HTTP46/原参数15，共78项通过；`.runtime/dsh-parameter-inspection-engine-http-verified.log` |
| `npm test -- --maxWorkers=2` | 最终退出0；264通过文件、3145应用测试通过，缺既有真实EDS原件的3项跳过，26项Node工具通过；`.runtime/dsh-parameter-question-full-tests-final.log`。包含模块边界/循环依赖检查，无本次新增失败 |
| `npm run typecheck` | 开场、并行修复后及构建后通过；`.runtime/dsh-parameter-question-typecheck-final.log` |
| `npx eslint`（本批3生产/3测试/1浏览器脚本）`--max-warnings=0` | 7文件通过；`.runtime/dsh-parameter-question-lint-final.log` |
| `node --check scripts/verify-dsh-parameter-question-browser.mjs` | 通过 |
| `npm run build` | 最终退出0；`.runtime/dsh-parameter-question-build-final.log`，保留既有500kB分块提示 |
| `npm run docs:agent:sync` / `npm run docs:agent:check` | 正文/变更记录更新后执行，209源码指纹一致 |
| `git diff --check` / `npm run site:status` | 通过；三站health、PID/worker、revision、启动时间、重启次数、supervisor及稳定release与开场逐项一致 |

没有全仓格式化/依赖升级/全仓lint，也未重跑独立SDK安装、收费实库或用户原件链。公开HTTP测试使用固定driver和真实工具，不冒称收费模型；浏览器两轮另列。

## 浏览器证据

新项目位于`.runtime/dsh-parameter-question-browser-2026-09-22/browser-1790089418344`，只有合成CSV Data和select。所有Notebook运行入口均被验收脚本阻止；公共HTTP/SSE/DSH模型与检索工具为真实调用，无回放/固定模型替换。准备0模型/0工具，完成East保存、未保存South取消、重开East；正式revision4保持。

first真实任务只问“当前参数值是多少？”，completed/verification passed；1公开任务、2模型调用、1次cellSearch，回答East，正式两单元不变、无草稿。随后人工改South保存revision5，新标签页同会话重开保持，旧East历史回答不自动改写。

second同会话再次原句提问，completed/verification passed；1公开任务、2模型调用、1次cellSearch，回答当前South而非旧East；无运行/编辑/提交，正式定义不变。第二次保存重开保留两轮回答，不额外调用模型。合计2公开收费任务/4模型/2工具，无收费重试；完整Token/金额未核账，不记录零费用。

三阶段报告全通过，页面异常/路由异常/禁止操作0。登记准备125→126，仅新增自有项目；两轮126→126，其他项目登记、源文件和表字节逐值保持。DSH选择/revision7/活动0保持。验证的是新标签页重开，不是服务重启长期记忆。浏览器公开trace不记录args，不能靠截图看出view=source；同源同版完整读取由引擎验证及离线测试证明。

12张本次截图全部由主代理实际查看，场景/尺寸/可见边界在[逐图复核](../../.runtime/dsh-parameter-question-browser-2026-09-22/browser-1790089418344/visual-review.md)。关键图：[取消保留East](../../.runtime/dsh-parameter-question-browser-2026-09-22/browser-1790089418344/prepare-03-cancel-east-1440.png)、[首轮East](../../.runtime/dsh-parameter-question-browser-2026-09-22/browser-1790089418344/first-01-answer-1440.png)、[人工South与旧回答](../../.runtime/dsh-parameter-question-browser-2026-09-22/browser-1790089418344/first-04-reopened-south-1024.png)、[最新South](../../.runtime/dsh-parameter-question-browser-2026-09-22/browser-1790089418344/second-03-south-answer-1024.png)、[只读真实过程](../../.runtime/dsh-parameter-question-browser-2026-09-22/browser-1790089418344/second-02-trace-1440.png)。没有制作不存在的失败UI，缺页/错误证据/取消/撤权失败由自动测试验证。

沿用纯文本渲染，Markdown星号/反引号会显示；准备编辑图的保存/取消按钮在视口外，展开trace图不宣称全文同时可见。三阶段机器报告保留生成时review状态，后续实际视觉复核以追加记录为准。

## 工作区与启用

分支保持`feature/eds-analysis-dashboard`，开场59项既有改动与期间并行工具/UI/研究工作保留。本批无暂存、提交、推送、删除、分支切换或服务启停；无新的运行开关、持久格式或兼容入口。服务状态完整对照见`.runtime/dsh-parameter-question-service-before.log` / `service-final.log`同前缀文件，三站仍健康。代码仅3001热更新，稳定release不变，3000未发布。以后修改本定义问答只需对应识别/验证模块及DSH组装；原模型驱动、业务执行和旧Harness不受本次替换。

## 保留边界

- 识别为有限整句，不承诺任意自然语言、多意图和无歧义自动猜测；不匹配时沿原行为，不静默授权。
- 原来源和整文档预检仍有效，纯参数无来源Notebook、关闭Python、缺选定模型不因此自动通过。
- 24工具/180秒保持。多参数与长值分页仍可能耗尽预算；没有“30参数一次必定完成”的承诺。
- 证据校验不证明每句模型解释正确；参数是非秘密分析输入，不放密码/API Key。当前值不是业务运行结果。
- 本次无外部数据库、用户原件、服务重启或3000发布验证；不处理历史SDK依赖风险，不安装/升级SDK。未重验全部历史页面或完整模型质量。
- 截图、项目与日志保留在本机忽略目录；他人检出仓库需自行运行验收脚本，不能把旧图当新验收。
