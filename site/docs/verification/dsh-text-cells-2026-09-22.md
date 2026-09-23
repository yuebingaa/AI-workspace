# DSH 接入已有 Notebook 说明单元

日期：2026-09-22。承接用户“继续”，冻结为网站 DSH 消费/编辑原 text Cell（静态说明与受控单行引用），不同时开放 parameter、多模型、跨表或新插件。开场42项未提交修改属于前批，保留；`feature/eds-analysis-dashboard` / `addff463`不切换。运行约定、近期记录、架构和真实Schema→工具桥→Notebook执行/回执已经检查；193源码指纹与全量类型基线通过。

## 实现边界

- `core/harness/server/notebook-tool-bridge.ts`仅在notebook profile加入canonical text；CSV试点保持原四类，现有来源/附件/连接/权限/无数据拒绝保持。工具说明列出`id/kind/title/markdown`及可选`references:[{key,cellId,field}]`，不得把变量名当Cell ID。
- 动态说明仍复用`core/notebook/text-references.ts`及原图/执行器：只接受精确`{{key}}`，输入须是本次成功、完整、恰好一行的表；不会执行表达式、HTML或脚本。无references时旧大括号文字仍是静态字面量。没有新模板引擎、Schema、数据查询或文件入口。
- `dsh-engine.ts`普通与只读任务明确说明定义/文字/数据是内容而非指令或新增授权，静态说明不是计算证据。这是模型提示，安全边界仍是原工具目录、数据权限、执行和草稿确认，不宣称仅靠提示能够消除注入。
- 动态text回执仍必须经原`run-receipt.ts`验证；`runNotebookCells.textResults`只含最近3项/各800字的带截断标记预览。`cellSearch(view=output)`仍只支持表格，text返回noTable；只读数值交付仍须实际上游表证据，不将静态文字或textResults单独升级为数值证明。
- forAi仍在Dataset数据进入计算前处理敏感字段，文本引用读取处理后的结果。用户已有说明自由文字不是Dataset行，不会自动敏感字段脱敏；不要将敏感明文写入准备发送AI的说明。运行成功只证明引用/执行通过，不证明自由文字业务判断正确。
- `selection.ts`与`AgentEngineSettings.tsx`同步说明范围，保持原布局、控件和设置生命周期。模型/草稿/Notebook持久格式与正式采用机制均不变。

## 工作记录

- 复用原桥测试fixture补静态说明、真实SQL总额230动态说明、非法引用/表达式/越界、失败修复后提交；变更前7案RED，开放后修正测试中误写的status=error（实际failure）及遗漏的旧目录反断言，最终两文件91案通过。原text初始化拒绝案转换为支持且CSV仍拒绝的正反回归，不删安全边界。已有语义测试的目录断言同步text，不变语义限制。
- 新`core/agent-engines/server/dsh-text.test.ts`10案与公共HTTP新增3案通过，公共HTTP原38案保留（其中2案“不支持”哨兵改仍未开放的parameter，拒绝断言不变）；真实SQL→text230、SSE、非法模板/多行、坏回执缺text、masked、取消/撤权、静态文本不能替代计算证据均覆盖。[2文件51项日志](../../.runtime/dsh-text-engine-http.log)。引擎测试首次即GREEN，不伪称RED。根复跑原engine/readonly/semantic/设置4文件89项通过；[日志](../../.runtime/dsh-text-engine-existing.log)。
- 隔离UI准备已完成：新的4单元手工语义150/80，新增静态说明为5单元；编辑已有说明添加非法`{{total + 1}}`与references，保存明确拒绝，取消后定义/版本不变，再手动运行和保存重开验证。共5次手动运行（准备器2/4/4单元、说明加入5单元、重开5单元），无AI；[准备报告](../../.runtime/dsh-text-browser-2026-09-22/browser-1790086035420/prepare-report.json)。首错误截图只拍到JSON开头，未冒称完整错误可见；零AI再次编辑/拒绝/取消补清晰[原因截图](../../.runtime/dsh-text-browser-2026-09-22/browser-1790086035420/prepare-08-visible-template-error-1440.png)，0保存且定义/版本/其他登记不变，[补验报告](../../.runtime/dsh-text-browser-2026-09-22/browser-1790086035420/visible-template-error-report.json)。错误仍是原JSON样式，不宣称本批重做了错误UI。8张准备图已实际查看，主代理复看原因与[1024重开静态说明](../../.runtime/dsh-text-browser-2026-09-22/browser-1790086035420/prepare-07-reopened-static-1024.png)。
- 收费首轮通过：1公开请求/7模型/7成功工具，保留原5单元，新增semantic总收入与text说明（准确`销售总收入：{{total}}`及key/cellId/revenue引用）；真实试运行→提交→[差异审阅](../../.runtime/dsh-text-browser-2026-09-22/browser-1790086035420/first-03-draft-review-1440.png)→显式采用后revision10→11/7单元。独立人工运行中数值230与[引用说明230](../../.runtime/dsh-text-browser-2026-09-22/browser-1790086035420/first-04-text230-1440.png)一致，原150/80与静态说明保持；重开同会话、定义不变、无额外AI或自动运行。[首轮报告](../../.runtime/dsh-text-browser-2026-09-22/browser-1790086035420/first-report.json)。5图均实际查看，主代理复看差异和结果。不是把230硬编码进说明，也不把试运行成功解释为所有自由文本都已验证。
- 同会话第二轮通过：1公开请求/4模型/3成功工具，本轮重新运行后直接只读回答230与150/80，无edit/submit/新草稿，正式7单元/revision11、模型、看板不变。[执行过程](../../.runtime/dsh-text-browser-2026-09-22/browser-1790086035420/second-02-trace-1440.png)、[数值结论](../../.runtime/dsh-text-browser-2026-09-22/browser-1790086035420/second-01-answer-1440.png)与[设置范围](../../.runtime/dsh-text-browser-2026-09-22/browser-1790086035420/second-04-text-plugin-1440.png)已实际查看；1024图主要展示过程，不冒称数值全文可见。设置仅打开/关闭，无设置写入；[第二轮报告](../../.runtime/dsh-text-browser-2026-09-22/browser-1790086035420/second-report.json)。
- 合计2次公开收费任务、11次模型调用、10次工具调用，无自动收费重试；完整Token/金额未获核账，不能记零费用。新脚本`scripts/verify-dsh-text-browser.mjs`将零AI准备与两次显式付费分开，转发前写一次性标记并保护隔离项目和正式定义。共17张本次新截图全部由验收代理实际查看，主代理复看7张关键状态；[截图与计数总表](../../.runtime/dsh-text-browser-2026-09-22/browser-1790086035420/visual-review-and-counts.md)。

## 最终检查记录

- `npm run typecheck`、构建后类型检查、首轮10文件严格ESLint通过；`npm run build`退出0，保留原大分块提示，[构建日志](../../.runtime/dsh-text-build.log)。
- 首次全量捕获一个旧诊断夹具仍用text作为不支持哨兵，3038通过/1失败/原3跳过；[失败日志](../../.runtime/dsh-text-full-tests.log)保留。把`scripts/dsh-tool-diagnostic-fixture.ts`的哨兵改为仍未支持的parameter，增强零模型/零工具及真实preflight断言，浏览器脚本未来证据描述同步，不改变产品guard。该3项及3文件严格lint通过。未重跑旧诊断浏览器，不声称产生它的新截图。
- 最终`npm test -- --maxWorkers=2`退出0：260文件/3039应用测试、26工具测试通过，原真实EDS文件缺失的3项跳过，不计入通过；[全量日志](../../.runtime/dsh-text-full-tests-final.log)。最终`npm run typecheck`和上述13个受影响TS/TSX/MJS文件ESLint通过；新浏览器脚本`node --check`通过。没有全仓lint或格式化，也没有重跑SDK独立单测、真实数据库或用户EDS原件。
- 架构正文/变更记录和README同步维护，运行`npm run docs:agent:sync`后193源码指纹检查通过。最终构建日志见[构建复核](../../.runtime/dsh-text-build-final.log)；原500kB分块警告不在本批处理范围。

## 保留事项与后续替换入口

本批不新增另一套文本业务实现：DSH负责决策，Notebook工具桥负责受控适配，模板/DAG/执行/回执和正式采用仍归原Notebook模块。以后增加其他执行引擎应复用该业务入口；替换模型/SDK仍走`core/agent-engines/server/dsh-engine.ts`与`runtime/dsh/`原适配，不修改文本Schema来迁就模型格式。说明渲染改动应归Notebook展示模块，不放进DSH执行循环。

参数、多模型、跨表、任意表达式/脚本未开放；文本输出检索仍无分页、预览有界，自由文字不自动脱敏且不等于已验证结论。原SDK依赖风险、纯文本Markdown、采用后历史答案不动态刷新保持。未验证新电脑、服务重启记忆或云部署。合成项目只证明本次选定链路，不代表真实模型到生产数据库的端到端验收。

工作期间发现独立并行的`app/studio-layout.css`、`components/studio/AgentWorkspace.tsx`及`scripts/verify-ui-refinement.mjs`修改，保留，不计入本批实现；研究目录与其任务日志也保留。部分新截图包含这些并行界面外观，不能据此宣称本批完成头部/建议样式改版。

## 验证与交付状态

本次限定范围源码、自动化和3001真实模型/浏览器验收已完成。DSH revision7、结束活动任务0；准备登记114→115仅新增本项目，两收费阶段115→115且其他项目保持。未发布3000、未启停服务、未提交推送、未升级SDK依赖。任务记录与合成证据继续本地留存，不强制加入Git。
