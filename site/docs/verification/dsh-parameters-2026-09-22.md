# DSH 接入已有 Notebook 参数单元

日期：2026-09-22。用户继续上一批说明单元后的独立扩展；范围固定为网站 DSH 消费/编辑原 text、number、date、select 参数，不重开 M7、不新增参数类型或执行器。开场49项既有未提交内容保留，分支 `feature/eds-analysis-dashboard`、HEAD `addff463` 不变。已读运行约定、近期记录、架构和参数 Schema/图/执行/回执；193源码指纹、类型检查基线及三站健康检查通过。

## 实际模块边界

- `core/harness/server/notebook-tool-bridge.ts`：网站 profile 加入 canonical parameter，编辑工具继续从原 Schema 裁剪，无新 Tool。旧 CSV 四类不扩，DSH 仍须选定数据、本次原件或允许 AI 的连接；参数不能充当来源授权。
- `core/notebook/parameter.ts`、`definition.ts`、`graph.ts`、执行器/回执保持原实现。参数产出固定 `value` 列一行表，本地 SQL/Python 经 Cell ID 声明输入、按 outputName 取表，不将值拼进 SQL、代码、标识符或模板。`warehouseSql` 无该输入绑定，`semanticQuery` 仍须直接模型 Data；不宣称远端 SQL 或语义查询已参数化。
- 四类严格值校验复用：单选值必须在唯一选项内，数字为安全范围内有限值（不保证精确十进制），日期为有效 YYYY-MM-DD。参数是普通保存定义，不是密码输入，不自动 Dataset 脱敏；定义检索可能交给模型，不能填凭据。文字不是指令或授权。
- `core/agent-engines/server/readonly-answer.ts` 的 `parameterCellIds` 来自 `dsh-engine.ts` 在任务开始捕获的正式文档，不相信工具/模型自报。参数 run 样本与 output 页不单独满足业务数值证据；所有返回样本仍须校验，至少一个非参数有效结果才通过结果问题。定义类只读说明仍允许。该校验不证明任意 SQL 或每句自然语言正确，不声称能识别所有伪造常量结论。
- `selection.ts` / `AgentEngineSettings.tsx` 同步能力文案，不改布局/CSS。正式定义仍须用户采用；修改值须重新试跑，旧回执不能提交。已有人工自动重算开关/采用不触发规则保持。

## 工作与验证记录

- 桥新增12项；开放前5失败（能力拒绝）/其余正反测试维持，开放后桥/原语义/设置3文件113项通过。实际 SQL 参数过滤 East150→South80，旧回执拒提交、重跑后可提交；四类型真实SQL传值、危险外观文本作为字面值，非法日期/选项/数值/额外代码字段、无来源及旧CSV拒绝覆盖。
- 新引擎参数测试15项首次10失败/5通过；开放后另实际复跑2失败/13通过，发现仅参数 run/output 被误认业务结果。保留 [负例日志](../../.runtime/dsh-parameter-evidence-red.log)，补上述可信ID过滤后，引擎/只读/诊断3文件131项通过；[修正日志](../../.runtime/dsh-parameter-evidence-green.log)。没有删除失败测试或放宽验证。
- 最终引擎15项、纯只读113项和公共HTTP44项，共3文件172项通过；HTTP新增四参数真实SQL JSON/SSE与只读追问，纯验证新增5项，原测试保留。中间并行运行捕获修复前证据失败及两个旧HTTP诊断码断言，改为真实关闭Python后的code，不弱化blocked/零模型工具/不泄密断言；[最终日志](../../.runtime/dsh-parameter-engine-http-final.log)。
- 网站当前合法 Cell 类型已全覆盖或条件开放，旧“unsupported parameter”哨兵不再成立。桥/公共HTTP/诊断 fixture 改用合法 Python + 明确关闭能力，预检仍要求模型0/工具0并给真实 `python_unavailable`，不是伪造未知 Cell 绕过入口Schema。旧CSV parameter拒绝仍保留；旧诊断浏览器仅更新未来说明，不把历史截图重标为新验收。
- 浏览器只用新隔离合成项目，付费阶段各自一次标记，不自动收费重试，不访问用户原件或数据库。新脚本为`scripts/verify-dsh-parameter-browser.mjs`，零AI准备与两付费阶段分离；检查项目归属/登记、原件与表字节、实际运行和正式定义，不替换真实模型/SSE/业务返回。
- 零AI浏览器准备：首轮创建Table前未先运行SQL，真实UI按原规则拒绝；这是新验收脚本顺序问题，失败报告与截图保留于`.runtime/dsh-parameter-browser-2026-09-22/browser-1790087311954/`，模型/工具0，登记120→121只新增该项目。修脚本为先真实运行上游，再建Table；重新新建隔离项目完成4次手工运行（3单元East150、4单元East150、South80、新标签South80）。非法select成员值保存被拒、取消保留revision8，合法South保存revision9；原件/表字节与其他项目登记保持，121→122只新增本项目。[准备报告](../../.runtime/dsh-parameter-browser-2026-09-22/browser-1790087365617/prepare-report.json)及5张准备图均实际查看；主代理复看[非法选项](../../.runtime/dsh-parameter-browser-2026-09-22/browser-1790087365617/prepare-02-invalid-select-1440.png)和[真实South80](../../.runtime/dsh-parameter-browser-2026-09-22/browser-1790087365617/prepare-04-south80-1440.png)。不覆盖失败，不伪称首次即通过。
- 已执行193指纹同步/检查、类型与构建后类型、15个受影响TS/TSX/MJS文件严格ESLint、新脚本语法检查；生产构建退出0，保留既有500kB分块提示；[构建日志](../../.runtime/dsh-parameter-build.log)。最终`npm test -- --maxWorkers=2`退出0，261文件/3074应用测试及26工具测试通过，原真实EDS文件缺失3项跳过，不计通过；[全量日志](../../.runtime/dsh-parameter-full-tests.log)。diff-check通过。无全仓lint/格式化/依赖变更，不将SDK独立单测或数据库历史结果算本次执行。

## 3001真实模型与截图结果

- 首任务1公开/6模型/6工具：3次检索→编辑→真实运行→提交。只将既有select值South改East，新增引用说明，原Data/SQL/Table及参数其他字段不变；采用前正式revision9仍South。真实[两项差异](../../.runtime/dsh-parameter-browser-2026-09-22/browser-1790087365617/first-03-draft-review-1440.png)审阅后显式采用revision9→10/4→5单元，独立人工运行实际[East150和引用文本150](../../.runtime/dsh-parameter-browser-2026-09-22/browser-1790087365617/first-04-east150-text-1440.png)，保存新标签同会话重开保持；[首轮报告](../../.runtime/dsh-parameter-browser-2026-09-22/browser-1790087365617/first-report.json)。
- 第二任务同会话原句结论：1公开/3模型/2工具，检索→本轮新运行→只读完成，无edit/submit/新草稿，正式5单元/revision10、East参数与看板/文件不变。[1440结论](../../.runtime/dsh-parameter-browser-2026-09-22/browser-1790087365617/second-01-answer-1440.png)实际显示150与仅3行合成数据限制，明确South须另改参数并运行，不伪造本轮South结果。设置[正文与插件卡](../../.runtime/dsh-parameter-browser-2026-09-22/browser-1790087365617/second-04-parameter-plugin-1440.png)均一致，GET-only未应用设置；[第二轮报告](../../.runtime/dsh-parameter-browser-2026-09-22/browser-1790087365617/second-report.json)。
- 合计2次公开收费任务、9次模型调用、8次工具，无收费重试或额外任务；完整Token/金额未核账，不记零费用。两付费阶段登记122→122且其他项逐值不变，原件/表字节保持；DSH前后revision7/活动0。成功准备4次与采用后1次手工运行，不混入模型工具计数。
- 共15张本次新图（首准备失败1、成功准备5、首轮5、次轮4）均由验收代理实际查看，主代理复看6张关键状态。非法选项图原因可见、底部按钮裁切；差异图采用按钮在下方，实际采用另有UI和持久化断言；1024答案图仅过程与开头，未冒称全文数值可见。完整计数、场景和审阅见[证据总表](../../.runtime/dsh-parameter-browser-2026-09-22/browser-1790087365617/visual-review-and-counts.md)。不复用旧图，旧诊断fixture未重新截图；本批不改变Markdown纯文本或历史答复不随采用改写的行为。

## 状态与未验证项

本次限定范围源码、自动回归与3001真实模型/浏览器验收已完成，未发布3000、未重启服务、未修改模型设置、未提交推送或升级依赖。三站身份/启动时间/版本/健康/重启数和supervisor与开场一致，原稳定release保持。最终52项Git可见未提交内容为原49项与本批3个新增文件，其余均局部叠加；既有并行UI/研究文档及任务日志保留，不算本批实现。任务记录/合成证据仍本地留存，不强制加入Git。

保留原SDK风险、有限结果预览、Markdown纯文本及既有持久化边界。真实浏览器只新增single-select→SQL→Table/text链；四类型真实SQL由离线业务执行测试覆盖，未新增本地Python/自动重算/真实数据库浏览器复验，也未验证新电脑、服务重启记忆、生产数据或用户原件。

独立源码复审未发现新增权限/确认阻断项；一个保守体验限制保留：“当前参数值是多少”若被路由为数值结果问题，仅参数证据不能通过；明确询问定义/参数配置仍可说明。本批不扩自然语言分类，不把输入参数误称业务汇总来换取通过。

后续仍通过DSH驱动/模型适配替换执行引擎，参数业务入口不动；参数Schema或渲染调整应归Notebook模块。未来新增只读verifier调用必须同样从正式定义传入parameterCellIds，不能由模型决定排除范围；当前唯一生产调用已接线。
