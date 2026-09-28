# DSH 默认工作台与旧聊天界面退出

## 范围与实现

用户要求主网页由DSH接替，并删除截图中旧底部提示、上下文卡片及步骤条。本批只切换网页接入 / 整理界面，不删除旧数据或重写分析执行器。

- `app/page.tsx`、`app/dsh/page.tsx`、`app/dsh/web/page.tsx`统一无参数`StudioWorkspace`，后者固定DSH独立会话与官方UI，三个URL保留同一存储且无重定向。旧入口banner / 导航及可视化实验菜单移除，实验API / 旧内核保留兼容，不在本批销毁。
- `AiBuilderAssistant.tsx`官方分支不再渲染父步骤条、safe-note或底部上下文卡片，也不套用旧欢迎页的底部对齐空状态class。头部“数据”复用原上下文菜单，`ComposerContextMenu`新增默认向上的`placement`选项，官方头部显式向下，主 / 子菜单同步定位并约束视口。数据浏览器 / 导入 / Notebook仍存在。预检与验证错误、失败重试、实际导出及Notebook / ChangeSet确认保留。
- `runtime/dsh/web-client.mjs`通过官方公开输入dock显示仅运行时的单行真实状态，无假步数 / 耗时；停止与最终消息不变。`DshWebFrame`加载失败保留手动重载，不回退旧AI。
- `AgentEngineSettings.tsx`新增`conversationOnly`只读模式，主工作台只GET就绪状态 / 插件，未改变全局引擎选择，不发PATCH。旧API选择与旧组件分支仅兼容 / 测试使用。
- `app/dsh/dsh.css`减少移除卡片后余白，保留官方布局及窄侧栏；共享样式只在`app/layout.tsx`加载，三个页面不重复导入。旧classic会话与任务仍按v7全量保存，DSH只筛选本命名空间，不改ID或将旧记录导入模型。

## 检查记录

- 开工完整阅读运行约定，当前分支`feature/eds-analysis-dashboard`且已有大量未提交内容，全部保留。`npm run site:status`三服务健康，未启停。基线类型、44项相关应用及26项Node工具通过。
- 相关设置15项 / 会话隔离等65项通过；Web客户端与资源29项通过。官方分支补充无旧卡片 / Trace、无turn错误、去重失败、确认按钮、Notebook / 下载、未接图片退路和忙碌上下文测试。
- 初次新测试fixture误用turn状态和NotebookArtifact结构，类型检查指出后已按真实契约修正；删除导航后未用setter lint已移除，没有关闭检查或放宽断言。

### 首轮全量与视觉复核

- `npm test -- --maxWorkers=2`：283个测试文件、3615项应用测试通过，既有EDS真实原件的1文件 /3项跳过不变；后续26项Node工具测试通过。日志：`.runtime/dsh-default-20260926-tests.log`。Mock评测11项全部通过，不代表真实模型能力。
- `node --test runtime/dsh/*.test.mjs scripts/package-portable-windows.test.mjs scripts/setup-dsh-runtime.test.mjs scripts/check-agent-architecture.test.mjs`：107项通过。日志：`.runtime/dsh-default-20260926-runtime.log`。
- 首轮`npm run build`通过，保留现有chunk大小 / 插件计时提示；日志：`.runtime/dsh-default-20260926-build.log`。后续共享CSS加载位置和菜单定位补丁的最终验证另记下方。
- 首轮离线浏览器脚本虽然自动断言通过，但主代理实际查看截图发现首页嵌入框退回浏览器默认尺寸，`/dsh`别名正常，因此**首轮不能作为视觉验收通过**。证据保留于[首次报告](../../.runtime/dsh-default-20260926/browser-1790430421496/report.json)。修正三个路由共享样式的加载归属到根layout，同时补齐框宽 / 高 / 外部视口及可见回执检查后重新验收，不以旧图冒充修复后结果。

### 最终检查

- 布局补丁后执行`node node_modules/vitest/vitest.mjs run components/studio/AiBuilderAssistant.test.tsx components/studio/ComposerContextMenu.test.tsx components/studio/dsh-web/default-entry.test.tsx --maxWorkers=2`：48项通过；没有重新把这48项计入上述3615项的全量结果。
- 最后`npm run build`通过，日志`.runtime/dsh-default-20260926-build-final.log`；随后顺序执行`npm run typecheck`通过。中途并行构建与代理只读tsc曾出现4项`.next`路由类型生成物不匹配，顺序生成后消失；新菜单测试的DOM append类型冲突已改用appendChild，未忽略检查。
- `npm run docs:agent:sync`、`npm run docs:agent:check`：234个文件一致，正文与变更记录已维护。17个本批TS / TSX / MJS文件严格ESLint零警告（四个路由 / layout，Workspace / Navigation，助手 / 设置 / 菜单及各测试，DshWebFrame / default-entry测试，Web客户端 / 测试，浏览器脚本）；`node --check scripts/verify-dsh-default.mjs`与相关`git diff --check`通过。未再运行全仓lint，已有不相关lint问题不归为本批通过。
- 第二轮浏览器的几何 / 菜单检查通过，但快速`fill→End→Shift+Enter→b`曾得到单个`b`，保留[失败证据](../../.runtime/dsh-default-20260926/browser-1790430848054/report.json)。没有放宽断言或插入等待来强行通过。最终原序列在完整网页通过并记录键盘 / 光标 / 父草稿事件；独立官方界面以0 /10 /40ms父回声延迟各10轮也通过。后者只覆盖内存父桥，不覆盖网站React与项目状态；**前次偶发失败根因未确定，不能宣称已彻底修复**。本批未据猜测修改输入同步协议。

## 3001实际截图

`node scripts/verify-dsh-default.mjs --offline`最终[报告](../../.runtime/dsh-default-20260926/browser-1790431066864/report.json)：7组检查、14张截图；主代理已逐张实际查看。页面 / 资源 / 路由异常、旧Harness请求和付费调用均为0；设置只有1次GET，无PATCH。 iframe占用正常工作区宽高，消息与输入框在视口内；脚本不仅检查DOM文字存在，也检查实际回执可视。

| 场景 | 实际截图与结论 |
| --- | --- |
| 默认首页 / 数据入口 | [空会话](../../.runtime/dsh-default-20260926/browser-1790431066864/01-default-home-1440.png)、[头部菜单](../../.runtime/dsh-default-20260926/browser-1790431066864/02-header-context-menu-1440.png)：无旧卡片 / 步骤 / 脚注，菜单向下，DSH可输入 |
| 换行 / 连续聊天 | [1024换行](../../.runtime/dsh-default-20260926/browser-1790431066864/03-shift-enter-workspace-1024.png)、[1440两轮回执](../../.runtime/dsh-default-20260926/browser-1790431066864/04-success-home-1440.png)：Shift+Enter不发送，Enter各发送一次，原始Markdown保存不变 |
| 旧地址兼容 | [/dsh](../../.runtime/dsh-default-20260926/browser-1790431066864/05-alias-1-1024.png)、[/dsh/web](../../.runtime/dsh-default-20260926/browser-1790431066864/05-alias-2-1024.png)：不重定向，保持相同DSH会话，无额外发送 |
| Notebook侧栏 | [1024](../../.runtime/dsh-default-20260926/browser-1790431066864/06-notebook-sidebar-1024.png)、[1440](../../.runtime/dsh-default-20260926/browser-1790431066864/07-notebook-sidebar-1440.png)：消息 / 输入框可见，未运行Notebook |
| 失败 / 运行 / 取消 | [失败与重试](../../.runtime/dsh-default-20260926/browser-1790431066864/08-failure-retry-1024.png)、[单行运行状态](../../.runtime/dsh-default-20260926/browser-1790431066864/09a-running-inline-status-1024.png)、[取消](../../.runtime/dsh-default-20260926/browser-1790431066864/09-cancel-1024.png)：保留真实交互处理，不恢复旧Trace；回执为明确替身 |
| 拒绝 / 设置 / 清除 | [HTTP拒绝](../../.runtime/dsh-default-20260926/browser-1790431066864/10-http-preflight-rejected-1024.png)、[只读设置](../../.runtime/dsh-default-20260926/browser-1790431066864/11-dsh-settings-readonly-1440.png)、[清除DSH](../../.runtime/dsh-default-20260926/browser-1790431066864/12-cleared-classic-preserved-1440.png)：拒绝可见可重试，不改引擎设置，合成旧聊天仍在项目中 |

浏览器使用新建空项目 / 新浏览器存储、真实官方Web资源与父桥；两次成功、失败、取消和HTTP400均为浏览器传输替身，不冒充真实模型或SDK执行器测试。HTTP400是服务端接纳拒绝，不是前端onAccepted之前拒绝的实测；后者由组件测试覆盖。模板 / 正式Notebook及合成classic会话在每次保存后比对保持不变。清除仅处理本测试项目DSH，不读取或删除用户项目。

## 状态与保留边界

- 仅当前源码与3001默认启用；三服务健康，PID / worker / revision / 重启次数与开工相同。未启停服务、发布3000、提交 / 推送、生成或上传新的便携包。
- 分支仍为`feature/eds-analysis-dashboard`，原有大量未提交修改全部保留。新增当前报告、菜单 / 入口测试与离线脚本；本批没有删除文件或历史数据。
- 旧界面不再有主导航入口，但兼容组件、旧API / 全局执行器选择和旧数据仍保留。更深业务工具与旧Harness契约的解耦不是本批完成范围。
- 官方`/ @ +`、原生图片 / 文件摄入和任意插件仍未接入；通过头部“数据”使用网站现有选择 / 导入。没有默认收费调用、实库或新UI完整分析→运行→确认保存的端到端重验；确认 / 导出保留由相关组件回归覆盖，不能把本批聊天替身验收等同于分析全链验收。

## 追加修正：空会话输入框贴顶（2026-09-26）

用户随后提供的2048px工作台与Notebook侧栏截图暴露了上面的14图验收未识别的缺陷：空会话时输入框位于聊天区域顶部，下方整片空白。此前“输入框在视口内”的断言只能证明没有溢出，**不能证明符合预期的底部位置**；原14图报告保留为当时证据，本节替代其空会话布局结论。

根因是固定官方DSH Web在空会话不渲染消息视图区，输入区的`position: sticky; bottom: 0`不能独自把元素推到容器底部；有消息时消息视图区填满上方空间，布局正常。`runtime/dsh/web-assets.mjs`仅对嵌入文档的官方输入座位加`margin-top: auto`，保持官方消息、输入、事件协议及有消息时的排列不变；内联样式继续携带服务端CSP nonce。资源测试锁定当前固定SDK包的类名，升级版本时不能无验收沿用。`scripts/verify-dsh-default.mjs`新增工作台、侧栏、清空后的输入框底部几何断言，并在2048、1440、1024视口实拍；视口切换后等待iframe实际完成尺寸更新，再执行原有严格断言，而非放宽检查。此前一次快速缩放触发的旧高度失败报告仍留存于`.runtime/dsh-default-20260926/browser-1790431818145/report.json`，没有把它算通过。

最终3001隔离复验：[报告](../../.runtime/dsh-default-20260926/browser-1790431854806/report.json)通过，17张截图已逐张实际查看、5个明确的浏览器传输替身、0次付费模型调用、0旧Harness请求、0页面/路由/资源错误；每个场景的输入座位底部间距均为0。尤其核对了用户截图对应的[2048空工作台](../../.runtime/dsh-default-20260926/browser-1790431854806/01b-empty-home-2048.png)与[2048空Notebook侧栏](../../.runtime/dsh-default-20260926/browser-1790431854806/01c-empty-notebook-sidebar-2048.png)，以及[1440空侧栏](../../.runtime/dsh-default-20260926/browser-1790431854806/01a-empty-notebook-sidebar-1440.png)、[1440已有消息](../../.runtime/dsh-default-20260926/browser-1790431854806/04-success-home-1440.png)、[1024已有消息侧栏](../../.runtime/dsh-default-20260926/browser-1790431854806/06-notebook-sidebar-1024.png)和[清空后](../../.runtime/dsh-default-20260926/browser-1790431854806/12-cleared-classic-preserved-1440.png)。本轮截图使用合成空项目，不包含用户项目数据；浏览器成功/失败/取消并非真实提供方结果，也没有运行Notebook。

修正后`node --test runtime/dsh/web-assets.test.mjs`12项、脚本语法与三个相关文件严格ESLint、`npm run build`、`npm run typecheck`均通过；构建保留已有大chunk提示。架构正文 /变更记录、视觉规范及源码指纹同步。仅当前源码与3001生效，没有发布3000、更新便携包、提交或推送。修复聚焦输入区定位：实际查看还发现[失败](../../.runtime/dsh-default-20260926/browser-1790431854806/08-failure-retry-1024.png)与[HTTP拒绝](../../.runtime/dsh-default-20260926/browser-1790431854806/10-http-preflight-rejected-1024.png)的摘要在官方消息和网站状态各出现一次；[运行中](../../.runtime/dsh-default-20260926/browser-1790431854806/09a-running-inline-status-1024.png)的“DSH 正在处理”出现两次；[取消后](../../.runtime/dsh-default-20260926/browser-1790431854806/09-cancel-1024.png)仍能看到前一次失败的历史状态。它们不是本次定位补丁的回归，也没有在本轮解决，不能称整张界面无重复提示。

## 追加视觉：主工作台空会话引导（2026-09-26）

用户以Hex空会话截图说明“不要太空”。本批不复制品牌图形、不启用上游`hero:true`：当前官方hero会引入本网站未接线的工作区选择和禁发状态。`AiBuilderAssistant.tsx`只在官方DSH主工作台、没有轮次/任务/错误/待发内容/有效草稿时，在iframe上方渲染复用本站`StudioArtwork`的装饰线描、标题与两行说明；`app/dsh/dsh.css`居中于输入框上方可用区域且`pointer-events:none`，由iframe继续处理输入。Notebook侧栏、已有消息、草稿、运行或失败时不渲染；清空后重新出现。不恢复旧三张建议卡片，不读取真实数据或暗示分析已执行。没有改模型、工具、请求事件、权限或持久化。

隔离3001的[最终报告](../../.runtime/dsh-default-20260926/browser-1790432776103/report.json)通过，17张截图已逐张实际查看；页面/路由/资源错误、旧Harness请求和付费调用均为0。实际界面包括[1440空工作台](../../.runtime/dsh-default-20260926/browser-1790432776103/01-default-home-1440.png)、[2048空工作台](../../.runtime/dsh-default-20260926/browser-1790432776103/01b-empty-home-2048.png)、[2048空Notebook侧栏](../../.runtime/dsh-default-20260926/browser-1790432776103/01c-empty-notebook-sidebar-2048.png)、[1024输入草稿](../../.runtime/dsh-default-20260926/browser-1790432776103/03-shift-enter-workspace-1024.png)、[1440成功有消息](../../.runtime/dsh-default-20260926/browser-1790432776103/04-success-home-1440.png)及[清空恢复](../../.runtime/dsh-default-20260926/browser-1790432776103/12-cleared-classic-preserved-1440.png)。几何断言验证图文位于输入框上方且不相交，空主区位置接近可用内容区中央；Sidebar和非空状态不存在该节点。失败/取消/HTTP拒绝仍以浏览器替身覆盖，不是真实模型故障或业务分析全链。上节记录的运行/失败重复提示仍可见，不属于本批欢迎层改动，未处理。

组件`AiBuilderAssistant.test.tsx`37项通过；`npm run typecheck`、`npm run build`、相关TSX及浏览器脚本严格ESLint、脚本语法检查通过，架构`docs:agent:sync/check`的234文件一致。构建仍提示已有大chunk。仅源码/3001启用；3000、既有便携包及GitHub均未更新，原工作区修改和用户数据不清理。
