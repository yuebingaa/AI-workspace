# DSH 主线第三批：官方 Web 聊天嵌入

本批固定范围为可选 `/dsh/web` 的官方文字对话组件、显示通信适配与原生 / 网页清除互斥。默认 `/dsh` 过渡界面保留；两个DSH入口共用网站会话，经典入口继续隔离。源码 /3001，不发布3000、不提交 /推送、不更新便携发行。

## 实际实现

- `runtime/dsh/web-assets.mjs`：固定官方0.1.7-rc.2资源与22客户端模块、受审桥boot graph；文件范围 / 容量 / 链接 / 版本检查和MIT声明，无新Host或端口。
- `runtime/dsh/web-client.mjs`：公开逻辑RPC、官方`conversation.content`，只接受父网站消息显示状态，文字发送和停止转交父页面；所有其他变更RPC拒绝。
- 最多32项未确认草稿只保护短期输入回声，最新确认 / busy / 换会话 / 清除后恢复父权威。先红测复现旧`a`覆盖新`ab`，修复后覆盖交错回声、80次快速输入、busy和会话生命周期。
- `core/dsh-web/protocol.ts`、`request-projection.ts`、`components/studio/dsh-web/DshWebFrame.tsx`：严格显示DTO、来源 / nonce / 重复请求检查、任务建立后才接受发送、首次新回执关联、真实输入挂载检查及超时退路。
- `app/dsh/web/page.tsx`、`app/api/ai/dsh/web/`、`core/dsh-web/server/assets.ts`：框架路由和固定资源缓存；原工作台状态 / 数据选择 / 工具 / Notebook采用机制共用，不暴露私有日志或配置。
- `components/studio/workspace/assistant.ts`：可选任务接纳通知，预检拒绝不假报accepted；现有返回类型及执行流程保留。
- `HarnessConversationStore.clearWith` 与清除handler：已有线程锁贯穿异步原生撤销和网站clear，其他线程独立；回调失败不清网站历史。旧释放幂等，仍不是跨存储事务。
- `scripts/portable-build-utils.mjs` 及架构检查器：复制 / 指纹包含载体新文件，未重新打发行包。

## 权威状态和限制

网站拥有项目、当前输入、可见历史与任务回执；模型记忆仍由第二批原生接受点持有。官方临时显示事件不是模型原始事件，不伪造token流、工具执行或用量。真实工具Trace仍在父网站。官方自身可保存草稿 / 视图偏好，但每个frame / 显示代独立ID，父draft在回声确认后同步，不从这些缓存恢复模型历史。官方公开插槽屏蔽基于显示投影推断的耗时 / 步数，真实网站Trace保留；原版占位提示中的`/`、`@`、`+`当前尚未接入，顶部明确说明，文件改由网站“添加上下文”处理。

此处使用固定可信SDK的同源iframe，`allow-scripts allow-same-origin`不是恶意插件沙箱。官方Cordis必须`new Function`，仅该文档允许`unsafe-eval`；`connect-src none`、nonce、资源白名单和服务端授权保留。无官方终端、任意文件访问、设置写入、队列编辑、MCP注册或动态第三方插件。首批官方输入仅文字，文件由父工作台导入；模型 / SQL / Notebook工具仍是网站既有能力，不因更换UI增加权限。

浏览器资源按公开精确URL提供，SDK中未修改的代码由MIT授权；不把复制源码或自制皮肤称为官方运行。原生日志仍含正文 / 结果，清除只是逻辑遗忘。原生撤销后网页存储写失败仍可能失去原连续性，已明确返回失败。

## 验证记录

- 开工 `npm run site:status`：3000 /3001 /3198健康；开发站原有重启数2，不因本批主动操作服务。
- 开工 `npm run typecheck` 及70项相关应用 /26项Node工具基线通过。
- 新协议 / 资源路由15项，后补显示关联3项通过；111项相关应用 /26项Node工具通过。资源载体 / 客户端 / 打包 / 架构分组检查逐批通过，收尾完整检查见下。
- 初轮类型错误为测试fixture联合类型的headers可选undefined，已用显式RequestInit数组修复；React refs / Effect和保留变量lint已修正，无忽略规则。
- 实际加载发现Vinext正规化官方combo URL，资源allowlist需接受严格等价URL；虚拟浏览器发现Cordis需要文档级eval。网站发送前置拒绝和同文重试ID问题在代码复审中定位后修复，不能仅依据虚拟模块可加载就声称3001已验收。

- 完整应用回归执行两次：初轮3594项，收尾 `npm test -- --maxWorkers=2` 为282文件 /3597项通过，1文件 /3项既有EDS跳过；26项Node工具均通过。[最终日志](../../.runtime/dsh-official-web-20260926-tests-final.log)。后补179项相关应用 /26工具也通过。
- 类型和本批适用文件严格ESLint通过；多次构建和最后输入同步修复后的收尾构建均通过，保留既有chunk与插件耗时提示，[收尾构建日志](../../.runtime/dsh-official-web-20260926-build-closeout.log)。全仓lint未重跑，不把原有问题算已修复。
- 初轮真实模型仅发送1次且任务成功：新建原生会话、1模型 /0工具，网页已经正确显示答案；脚本因直接比较Markdown `**加粗**`和渲染后文本而停止，不是产品答案缺失。保留[源报告](../../.runtime/dsh-web-20260926/browser-1790428736126/report.json)与[当时实际界面](../../.runtime/dsh-web-20260926/browser-1790428736126/failure.png)，主代理已查看。后续通过显式安全续跑补第二轮，不能重发第一轮或掩盖这次验收脚本问题。

- 最后输入修复后执行 `node --test runtime/dsh/*.test.mjs scripts/package-portable-windows.test.mjs scripts/setup-dsh-runtime.test.mjs scripts/check-agent-architecture.test.mjs`，106项全部通过，其中Web客户端16项 / 资源12项。[最终载体日志](../../.runtime/dsh-official-web-20260926-runtime-final.log)。最后一处纯MJS改动重跑载体、浏览器、类型、lint和构建；没有把此前3597项应用回归声称为最后MJS修改后再次全量执行。
- `npm run typecheck`、`npm run docs:agent:sync`、`npm run docs:agent:check`通过，234源码指纹一致。定向`git diff --check`通过，只有既有LF/CRLF提示；新文件另经严格lint。收尾`npm run site:status`三服务健康，PID / revision / 重启次数与基线相同。

## 最终浏览器与收费证据

验收脚本`node scripts/verify-dsh-web.mjs --offline`默认不收费。付费入口必须显式`--confirm-paid-model`（最多2轮）；首轮脚本断点后的`--resume-paid-run`只允许严格校验本脚本拥有的项目和成功回执，用独占claim防止重复付费续跑。本批仅2个唯一真实收费任务，各1次模型 /0工具，无数据 / 数据库操作、无草稿或正式Notebook / AppSpec改动。

- 实际执行 `node scripts/verify-dsh-web.mjs --resume-paid-run .runtime/dsh-web-20260926/browser-1790428736126`通过。[续跑报告](../../.runtime/dsh-web-20260926/browser-1790429150890/report.json)复用原成功首轮，仅新发送第二轮；新建→刷新重开项目→原生`resumed`，正确回答合成代号“晨星42”。12张1440 /1024截图全部由主代理实际查看，不以DOM断言代替。
- 最后输入修复后再次执行一次`--offline`通过，[最终离线报告](../../.runtime/dsh-web-20260926/browser-1790429350131/report.json)共13张截图全部由主代理实际查看；无付费、页面错误 / 路由错误 / 意外资源错误均0。成功 / 失败 / 取消模型回执是明确浏览器替身，官方SDK资源、加载、交互及项目保存 / 清除走实际3001接口。
- Enter每次只发1次，Shift+Enter真实换行；刷新与同标签页`/dsh`↔`/dsh/web`共用历史，Notebook侧栏1024px可读；清除后两入口均为空。两组各注入1次预期document503，真实等待30秒超时再手动恢复，不自动重发或恢复旧历史；最终离线等待31.314秒。失败 / 取消均是界面替身验收，不声称真实提供方取消已重验。

最终25张截图包含全宽 / 窄侧栏、成功 / 失败 / 取消 / 清除 / 资源故障恢复；正文、输入和错误可读，无横向溢出。窄侧栏采用固定SDK选择器、仅≤480px减小消息留白，不修改上游组件或隐藏内容。代表性截图：

| 页面 / 场景 | 本次证据 | 结论 |
| --- | --- | --- |
| `/dsh/web` 真实第二轮 | [真实续聊](../../.runtime/dsh-web-20260926/browser-1790429150890/03-round-2-1440.png) | 原生续接成功，记住合成代号 |
| `/dsh/web` Notebook侧栏 | [1024px侧栏](../../.runtime/dsh-web-20260926/browser-1790429150890/04b-notebook-sidebar-1024.png) | 同一会话可读，无单元执行 |
| `/dsh/web` Shift+Enter | [最后换行检查](../../.runtime/dsh-web-20260926/browser-1790429350131/02-shift-enter-1024.png) | 真换行，不发送 |
| `/dsh` 切回过渡入口 | [共用历史](../../.runtime/dsh-web-20260926/browser-1790429150890/05-shared-transition-1024.png) | 同一会话，无重复请求 |
| `/dsh/web` 失败 / 取消替身 | [失败](../../.runtime/dsh-web-20260926/browser-1790429350131/06-failure-fixture-1024.png)、[取消](../../.runtime/dsh-web-20260926/browser-1790429350131/07-cancel-fixture-1440.png) | 不假报完成，可继续输入 |
| `/dsh/web` 清除 | [清除后](../../.runtime/dsh-web-20260926/browser-1790429350131/08-cleared-official-1024.png) | 两入口均无旧历史 |
| `/dsh/web` 资源暂不可用 | [加载失败](../../.runtime/dsh-web-20260926/browser-1790429350131/10-official-document-unavailable-1024.png)、[手动恢复](../../.runtime/dsh-web-20260926/browser-1790429350131/11-official-document-recovered-1024.png) | 明确退路，不自动重发 |

## 发布与剩余范围

仅源码 /3001，当前分支`feature/eds-analysis-dashboard`，原有未提交和未跟踪修改保留，没有提交、推送、切分支、发布3000、启停三服务或更新GitHub运行包。打包复制清单有回归，但未制作新包或进行新电脑便携验收。

本批不是完整官方Host迁移，也不是全量插件 / Skill能力开放。图片、文件原生摄入、`/`命令、`@`引用、模型切换、工具原生日志实时渲染未接入；仅从网站现有授权和业务桥使用已有能力。本批真实收费测试只证明普通对话和原生续聊，数据分析 / 实库 / 草稿确认链未通过新UI重做收费端到端，不复用旧批次结果来宣称完成。官方占位文案仍来自固定上游实现，顶部限制提示须保留；同源可信资源及跨存储清除的残余边界如上。
