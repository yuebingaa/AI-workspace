# M5 收尾 3/3：统一上下文选择与汇总验收（第十五批）

日期：2026-09-17。状态：本批源码与开发站验收完成，M5 冻结的三个收尾包全部完成；3000 未发布。M2–M4 保留项和 M6 / M7 仍按原边界推进。

## 本批完成边界

- 在既有添加上下文菜单加入当前 Notebook 参数与单元，最多十项稳定 Cell ID；与数据表、语义模型等已有入口共处同一菜单。AI 工作台 / 侧栏均可见已选标签，可移除、搜索与键盘操作。
- 独立内存选择状态按项目、页面、会话 contextId 归属；同一范围的模式切换保留，切范围 / 刷新清空；删除清理，改名 / 重排按 ID 更新，不随撤销复活已移除引用。无持久格式迁移。
- 选中项时，非 Notebook 模式也发送现有 Notebook Context。请求仅新增可选 selectedCellIds；服务端 / 纯契约拒绝重复或不属于本次文档的 ID，从定义构建只读元数据，不接受浏览器旧运行结果。无选中项的旧请求保持兼容。
- 泛指已选单元的只读问题通过现有 CellSearch 按需核实，不因为有 Notebook 就盲目创建整份草稿；明确修改仍沿用试运行和采用确认。选择是关注范围，不是运行或授权凭证，不提高 Dataset / 连接权限、不绕过 Input Inspector 门控、不新增模型调用。
- 完成选中上下文的新浏览器截图、对应离线工具 / 请求验证；复查当前 M5 已落地的参数、SQL / Python / 图表 / 文本、自动重算和预览导出。真实本机只读 AdventureWorks 链与浏览器合成链分开记录。
- 不建设新的长期记忆、全局结果仓库、动态 Cell 插件、多用户权限或数据库连接管理。现菜单旧连接说明必要时纠正，不把它当成已新增连接选择能力。M6 / M7 与前面保留项仍独立核对。

## 审计与工作记录

- 已完整读取运行约定、根协作和近期记录；核对当前架构、M5 三包范围、视觉与实际菜单 → StudioWorkspace → assistant 请求 → Harness Context / CellSearch 链，非全仓重新审计。
- 原菜单无 Notebook 选择，StudioWorkspace 仅 Notebook 模式附带环境，故只增加标签会导致 AI 工作台实际请求缺失；原 CellTools 按指令关键词选择，泛指可能误走整稿。优先解决这两条真实接线问题。
- 原服务端 conversation.selectedContext 每次按 page / Dataset / model / recipe 重建，不用它存本批短期选择；不把 UI 焦点误记为长期上下文或运行证据。
- 审查没有发现需要改动 Conversation Store、Notebook 执行器或数据库驱动的理由；保持这些实现，通过接口和新增回归验证边界，而不是为目录整齐扩大迁移。

## 实际模块与文件

```text
core/notebook/context-selection.ts                 严格 ID 契约、UI 清理、声明元数据
core/harness/contracts.ts                          请求可选字段 / 模型端口
core/harness/context-selector.ts                   模型关注项投影与压缩
core/harness/notebook-cell-tools.ts                只读检索 / 原增量编辑路径选择
core/harness/input-inspector.ts                    已选数量，不提前读取数据
core/harness/runtime.ts                            既有模型端口接线
core/ai/server/deepseek-harness-model.ts            现有服务的请求适配
components/studio/workspace/
  notebook-context-selection.ts                    当前范围状态与请求组成
  useNotebookContextSelection.ts                   窗口内 React 状态
components/studio/notebook/NotebookContextSelection.tsx
                                                  显示元数据、多选项与可移除标签
components/studio/ComposerContextMenu.tsx           既有菜单组合
components/studio/AiBuilderAssistant.tsx            AI 工作台 / 侧栏组合
components/studio/StudioWorkspace.tsx               当前范围与请求接线
app/composer-context-menu.css                      灰度菜单 / 标签样式
scripts/fixtures/context-selection.mjs             固定模型 + 真 Harness 检索回执
scripts/verify-notebook-context-selection.mjs       隔离浏览器验收
scripts/verify-notebook-parameters.mjs              旧验收脚本适配既有改名确认
```

### 公开接口与替换边界

- Notebook 域维护 `MAX_NOTEBOOK_CONTEXT_SELECTION`、`notebookContextSelectedCellIdsSchema`、`normalizeNotebookContextSelection`、`notebookContextSelectionMetadata`。严格请求拒绝错误；UI 清理用于删除 / 范围变化，两者不能混为静默修正外部请求。新域不依赖 React、Harness 或服务端。
- UI 按项目 handle / instanceId、pageId、会话 contextId 维护一份 ID 列表。`composerNotebookContext` 仅组合请求；参数值与定义仍由原 Notebook 状态拥有，不复制执行结果。
- Harness 请求在 `notebookContext` 内新增可选 `selectedCellIds`，成员关系以**本次提交的 document**校验，不是新建服务端权威文档仓库。JSON 和 SSE 路由、身份来源、Dataset 同意、连接替换及错误语义沿用现有入口。
- 模型端口新增可选 `notebookSelection`，DeepSeek 适配器序列化同一份声明元数据。正常上下文为 ID / 类型 / 标题 / 输出名，压缩后保留 ID 和 `metadataOmitted`；无选中项不插入新占位字段。浏览器仍向既有 API 提交 Notebook 定义，不能宣传为 HTTP 请求只发送标签。
- Agent 在执行工具前看到的是声明；`cellSearch` 按需读取当前定义 / 血缘 / 本任务结果。选择只增加关注项，不收窄成授权白名单，也不把其他已授权单元变成不可访问。泛指解释提供只读工具，明确改动仍走检索、编辑、试运行、提交草稿与人工采用。
- Dataset / SQL / Dashboard 本批无新业务实现，保持仓库、连接查询端口、执行器和 ChangeSet 原有所有权。真实数据库、SQL、Dataset、图表与看板回归用于证明未被新上下文接线破坏，不能称为本批新造的完整结果仓库。
- 未来替换模型仍主要修改 `core/ai/server/` 对应适配及组装入口；其他模型需显式支持新的可选元数据。修改选择 UI 主要位于上述组件 / hook，调整焦点契约位于 Notebook 域。数据库仍通过现有 `core/connections/server/` 查询服务 / drivers 替换，本批没有承诺方言、认证或取消语义可零修改替换。

### 测试新增归属

- `core/notebook/context-selection.test.ts`：上限、唯一性、成员、纯元数据与清理。
- `core/harness/notebook-context-selection.test.ts`：普通 / 压缩模型投影、只读 / 变更 / 问候、旧请求等价、真实工具检索、伪造完成、取消。
- `app/api/ai/harness/notebook-context-selection.test.ts`：真实 JSON / SSE 入口的 ID、假结果、服务器连接和 Dataset 授权边界。
- `core/harness/server/notebook-selection-continuity.test.ts`：原 Conversation Store 的持久快照不新增焦点 / 源码 / 参数值副本，当前请求不被旧焦点覆盖，项目 / 用户 / 页面隔离保留。
- UI 两个新专项测试，以及 `workspace/assistant.test.ts`、`AiBuilderAssistant.test.tsx` 的增量断言：范围清理、陈旧回调、忙碌、多选上限、请求组成与双布局。
- `core/architecture/module-boundaries.test.ts`：增加 Notebook 纯域和 UI 接线的依赖边界检查，不引入第二套治理框架。

## 本次已执行验证

- 修改前完整离线基线：2081 项应用测试与 14 项 Node 测试通过，原有 3 项跳过保留。
- 根代理新增连续性与架构守卫：2 文件 30 项通过、严格 ESLint 通过。
- 后端新增 55 项、UI 新增 39 项均由负责代理执行通过；合并后的最终全量检查另列最终结果，不将这些局部计数冒充全量。
- 本机只读 AdventureWorks 原完整服务端链本次重新运行：10 项通过，10 表 / 107 列，15 份查询回执；31,465 笔订单、38 个月与独立 pg 查询对照一致。参数改为 3 后受影响链输出 94,395，共享完整输入见证未变时保留独立旧分支。
- 实库链覆盖 PostgreSQL → DuckDB → 表格 / 图表、受控文本、Dataset 保存 / 重开、看板快照预览 / 应用 / 撤销、截断拒用、权限与取消重试、固定模型下真实四工具提交。使用既有专用只读测试库，不是生产库；前后 PID 与只读 / 12s 超时 / 无 TEMP、CREATE、写权限完全一致。无远端模型 HTTP、无站点配置变更。
- 数据库工具 11 项、架构检查脚本测试通过；新浏览器与固定回执脚本语法检查通过。
- 合并后两轮 `npm test -- --maxWorkers=2` 均为 **2179 项应用 / 14 项 Node 通过**，198 个应用文件通过，原一文件 / 三项跳过不变，新增 98 项；最终以 `tests-final-after-fixes.log` 为准。25 个本批 TS / TSX / MJS 文件严格 ESLint 零警告，见 `lint-final.log`。没有删测试或放宽断言。
- 正式 `npm run typecheck` 通过，先按原命令生成框架路由类型，再检查全部 TypeScript；预检发现的新测试类型问题已修复，生成类型缺失不再出现。`npm run build` 退出 0，保留部分 chunk 大于 500 kB 的提示，没有调整阈值或升级依赖。
- 架构正文 / 变更记录与 149 个源码指纹已同步，`docs:agent:check` 通过；`docs:agent:test` 1 项、数据库工具 11 项通过。三个本批新增 / 修改 MJS 脚本语法检查通过；没有执行真实付费模型、发布或数据库生命周期命令。

证据根：`site/.runtime/hex-unified-context-2026-09-17/`。实库为 `adventureworks-final/report.json`，前后边界为 `database-precheck.log` / `database-postcheck.log`，正式类型 / 构建为 `typecheck-final.log` / `build-final.log`；中间失败和成功日志均保留。浏览器均使用新隔离项目，证据分列如下，不借用前批截图冒充本次重跑。

### 3001 新上下文验收

最终采用 `site/.runtime/hex-context-selection-2026-09-17/browser-1789619722966/`：**6 组 / 11 张截图通过**，全部由浏览器代理实际查看，根代理另看 05 / 06 / 07 / 11。1024 与 1440 桌面没有整页横向溢出，菜单、上限、标签换行、编辑禁用、键盘焦点、改名 / 重排 / 删除、清上下文 / 会话 / 页面 / 项目 / 刷新均已实际操作。

- 1 次真实本地 Notebook SQL HTTP，结果 14；2 次明确 SSE 回放来自固定模型 + 真 Harness，每次真实读取两个定义，合计 4 次 CellSearch。回放验证双布局实际提交的 ID / document，而不是从浏览器旧结果造成功回执。
- 1 次实际自有合成会话清上下文请求；脚本先校验项目 handle、pageId 和已发送 contextId，不接触用户会话。目录 7 次 GET 为明确空替身，无远程模型或仓库请求。
- 页面异常、违规请求与非预期 Notebook HTTP 错误为 0；3 个 `/api/projects` 请求在范围切换中 `ERR_ABORTED`，最终保存 / 重开校验成功，不把它们宣传为网络层完全无取消事件。

| 场景 | 实际截图 / 证据 |
| --- | --- |
| 十项上限与菜单 | [多选上限](../../.runtime/hex-context-selection-2026-09-17/browser-1789619722966/05-selection-limit-1440.png) |
| AI 模式十个标签 | [1024 标签换行](../../.runtime/hex-context-selection-2026-09-17/browser-1789619722966/06-ai-ten-chips-1024.png) |
| Notebook 当前定义检索 | [真实工具事件回放](../../.runtime/hex-context-selection-2026-09-17/browser-1789619722966/07-notebook-cell-search-1440.png) |
| 项目重开 | [定义保留、选择与旧结果不恢复](../../.runtime/hex-context-selection-2026-09-17/browser-1789619722966/11-project-reopen-1440.png) |
| 全部断言与回执 | [最终报告](../../.runtime/hex-context-selection-2026-09-17/browser-1789619722966/report.json) |

### M5 汇总回归与本次证据

| 本次实际运行的脚本 | 结果 | 本次报告 |
| --- | --- | --- |
| `node scripts/verify-notebook-context-selection.mjs` | 6 组 / 11 图 / 1 次真实 Notebook HTTP；另 2 次固定模型真工具 SSE 回放 | [上下文选择](../../.runtime/hex-context-selection-2026-09-17/browser-1789619722966/report.json) |
| `node scripts/verify-notebook-parameters.mjs` | 5 组 / 15 图 / 12 次真实 Notebook HTTP；四类参数、SQL、Python、图表、Dataset 与重开 | [参数链](../../.runtime/hex-parameters-2026-09-17/browser-1789619894471/report.json) |
| `node scripts/verify-notebook-parameter-auto-run.mjs` | 9 组 / 17 图 / 10 次真实 Notebook HTTP；SQL / 文本、编辑暂停、合并更新、取消、权限与重开 | [自动重算](../../.runtime/hex-parameter-auto-run-2026-09-17/browser-1789619828471/report.json) |
| `node scripts/verify-notebook-preview-export.mjs` | 8 组 / 11 图 / 9 次真实 Notebook HTTP / 9 个真实 CSV 下载；排序、完整 / 预览、空结果、失败重试和失效阻断 | [预览导出](../../.runtime/hex-preview-export-2026-09-17/browser-1789619959179/report.json) |
| `node scripts/test-database/verify-adventureworks.mjs --runtime-dir <已核对自有测试库> --evidence-dir <本次新目录>` | 10 项 / 15 条真实查询回执；独立参考查询、API 函数、Dataset、看板确认与撤销 | [实库输出链](../../.runtime/hex-unified-context-2026-09-17/adventureworks-final/report.json) |

合计 **28 组浏览器检查 / 54 张新截图 / 32 次真实 Notebook HTTP**，54 图全部实际查看。前三组脚本的 43 图由浏览器代理查看，根代理另外复看选择 05 / 06 / 07 / 11、参数 08 / 11、自动重算 05a / 11；CSV 的 11 图全部由根代理查看。自动重算有一个预期 SQL 失败，另一个成功但故意延迟的回执被 UI 正确拒用；CSV 有一个预期 SQL 失败。不能将 32 次 HTTP 宣传为 32 次 UI 成功展示。各脚本页面异常 / 违规请求为零，选择脚本的正常范围切换取消事件单独保留。

代表性结果：[真实 Python 参数计算](../../.runtime/hex-parameters-2026-09-17/browser-1789619894471/08-real-python-parameters-1440.png)、[参数变更后图表](../../.runtime/hex-parameters-2026-09-17/browser-1789619894471/11-manual-recomputed-chart-1024.png)、[编辑暂停自动重算](../../.runtime/hex-parameter-auto-run-2026-09-17/browser-1789619828471/05a-visible-paused-setting-1024.png)、[迟到回执拒用](../../.runtime/hex-parameter-auto-run-2026-09-17/browser-1789619828471/11-late-response-ignored-1440.png)、[1324 完整结果与 1000 行导出分开](../../.runtime/hex-preview-export-2026-09-17/browser-1789619959179/06-complete-vs-preview-export-1440.png)、[空结果只导出表头](../../.runtime/hex-preview-export-2026-09-17/browser-1789619959179/08-empty-success-header-only-1024.png)。

M5 的受控文本、自动重算、统一上下文三个冻结收尾包到此完成。本次汇总覆盖其共同主链和 1024 / 1440 桌面，不意味着重新执行过每一个历史独立浏览器脚本：第十一批完整输出改名专项、第十三批完整文本编辑专项仍以各自历史报告为证，本次由全量回归及上述交叉链保护。旧项目格式、完整结果仓库、动态 Cell 卸载等未实现项不因汇总验收而自动标成完成。

### 发现并处理的问题

- 新后端只读短语最初含过宽的“说明”；收窄为明确的查看表达，补“帮我说明一下这些”只读与“根据所选参数生成分析说明”原编辑链对照。不是把所有生成文本请求硬判为只读。
- 新增 UI 测试第一次把原有预览清理也当成零调用，改为精确验证既有 `cancelPreview` 行为，保留对文档不变的断言；新增后端测试的类型窄化随专项检查修正。未弱化生产校验。
- 第一轮浏览器 `browser-1789618903900` 尚未创建项目就遇到开发转换负缓存：新域文件已存在且 `.ts` 请求为 200，但旧 `ComposerContextMenu` 转换仍引用无扩展的 404 地址。检查真实转换后，仅为该入口补必要模块边界注释，正常 HMR 重新解析为正确依赖。没有硬编码 `.ts` 导入、修改框架配置、删除缓存或重启任何服务；首轮失败截图和报告保留，不能算产品验收通过。
- 第二轮焦点断言早于原有 `requestAnimationFrame` 恢复，改为等待真实 `activeElement`，仍严格检查焦点。第三轮固定回执末尾检查误用 `event.toolName`，实际协议为 `event.toolCall.name`；修正并增加完成工具数量断言，使用该轮自有合成项目做完整 Node 前置验证后才重跑浏览器。该前置真 Harness 为 completed / passed、两次 CellSearch、无草稿，证据在 `site/.runtime/hex-context-selection-2026-09-17/fixture-preflight-1789619640607/`。
- 第四轮在清空后对空白会话直接点“新建”，既有逻辑会保留该空白会话，不能期待 scope 变化。脚本先填合成未发送草稿再验证实际新建；没有改变原产品交互来迎合测试。
- 根代理直接 `tsc --noEmit --incremental false` 预检发现一个新 UI 测试把宽参数联合中的 number 也设为字符串；按实际合成文本参数收窄类型，17 项专项与严格检查重新通过。该预检另报生成路由类型缺失，随后正式 `npm run typecheck` 按原脚本先生成框架类型再检查，已全部通过；没有手工修改生成类型或关闭检查。
- 旧参数专项脚本来自第十批，首轮 `browser-1789619764618` 未适配第十一批新增的输出改名确认，在首次保存等待隐藏时失败且未运行数据。仅调整 `saveNew`，显式确认既有审阅卡；普通保存、失败与取消断言保留。新隔离完整重跑通过，未修改产品来迁就旧脚本。

## 工作区与启用状态

- 本次分支始终为 `feature/eds-analysis-dashboard`，HEAD `df5bbae` 未变；保留已有大量未提交 / 未跟踪修改，无提交、推送、合并、换分支或历史改写。新增模块、测试和脚本以后须与消费者一同纳入提交，不能只提交 import 改动。
- `site:status` 在开始、浏览器后、构建后及中断恢复后核对；三服务健康，supervisor、PID / worker、revision、release、启动时间与重启次数未改变。3001 为当前源码验收，3000 仍运行原独立发布版。
- 本批没有删除用户文件或清理证据。验收合成项目和 `.runtime` 按现有忽略规则保留；根 `TASK-LOG.md` 也被现有规则忽略，但仍按协作约定追加记录，不擅自更改 Git 忽略策略。
- 用户中断发生在实现、全量检查、截图与构建均完成之后；恢复后只核对状态、完成文档和记录，没有重新开启功能范围。

## 保留事项与验收边界

- 不调用真实付费模型；固定模型只能验证请求、真实 Harness / Tool 与 UI 事件链，不能证明任意自然语言或真实模型生成质量。
- 选择元数据基于提交定义，工具读取普通参数可能取得参数值；现有参数不是秘密输入容器。焦点不会额外授权工作簿、Dataset 或数据库。
- 不将选择持久化到项目或聊天记忆；刷新清空是本批设计，不是恢复失败。旧聊天中的模型答案可能自然提及已读内容，本批禁止的是自动保存新的焦点 / Notebook 状态副本，不声称聊天完全不含任何数据。
- 完整结果下载、持久结果仓库、动态 Cell 插件、Python 任意包 / 网络、实时发布 App、多用户权限、M6 能力关闭 / 恢复与 M7 总验收保留到各自范围。
- 原工作树大量未提交修改完整保留。本批没有删除文件、升级依赖、提交、推送、合并分支或发布 3000；验证生成的隔离合成项目和截图留作本机证据，不清理用户数据。
