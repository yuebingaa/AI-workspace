# AgentCanvas 的 DSH 插件候选

核查日期：2026-09-26。本文是选型研究，不是安装、启用或兼容性验收记录。候选来自 DeepSeek Harness 官方仓库及社区插件作者仓库；未执行社区插件代码。

2026-09-27 补充：下方初审的 `0.1.6-alpha.2` 是历史版本；当前受管安装已是 `0.1.7-rc.2`。对用户所示官方插件设置与本项目差异的复核见文末，不将旧版本判断当作当前安装状态。

## 项目接入条件

- `runtime/dsh/package.json` 将官方运行时固定为 `0.1.6-alpha.2`；`driver.mjs` 使用 `sdk-minimal`，为每次任务创建独立目录并在任务结束后关闭子进程。
- `policy.mjs` 和 `controlled-plugin.mjs` 只允许项目登记的工具。常规工具为 `cellSearch`、`editNotebookCells`、`runNotebookCells`、`submitNotebookDraft`，按任务开放额外能力；工具列表还会按任务收窄。
- 当前设置页的插件目录是项目维护的能力组合，不是任意 DSH 插件安装器。新增工具需要接入现有权限、事件和结果验证链。
- 本机依赖中能找到下列官方插件的 `0.1.6-alpha.2` 包，但当前最小运行配置没有挂载这些功能。文件存在不代表网站已启用。
- 官方完整 DSH 的 Web 界面与本项目自建界面是不同宿主。依赖原生 DSH Web 页面、会话控制器或预设系统的社区插件，需要额外适配。

本地依据：`runtime/dsh/package.json`、`runtime/dsh/driver.mjs`、`runtime/dsh/policy.mjs`、`runtime/dsh/controlled-plugin.mjs`、`core/agent-engines/server/selection.ts`、`docs/architecture/agent-architecture.md`。只读元数据及已安装包 README 快照保留于 `site/.runtime/dsh-plugin-recommendations-20260926/`（相对于仓库根目录）。

## 优先考虑的官方插件

下表包名省略统一前缀 `@deepseek-ai/`。优先级与项目收益是本次评估，不是上游性能承诺。

| 插件 | 能力与本项目用途 | 接入判断 |
| --- | --- | --- |
| [dsh-skill / dsh-skill-filesystem / dsh-tool-skill](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/skill/tool-skill/README.md) | 按需加载工作说明。可编写 EDS 异常分析、Excel 清洗、字段检查和报告生成 Skill，减少每次重新解释流程。 | 优先。须编写自己的 Skill、提供受控内容目录并适配工具。Skill 描述操作流程，指标公式仍由现有语义模型和计算工具执行。 |
| [dsh-compaction-basic](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/compaction/compaction-basic/README.md) / [dsh-compaction-tool-result-pruner](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/compaction/compaction-tool-result-pruner/README.md) | 长分析任务中压缩旧上下文、裁剪过大的工具输出，适合多次读取、修正代码、执行查询的流程。 | 优先评估。需要补齐压缩引擎、容量计量等依赖并协调现有上下文逻辑。摘要会额外调用模型；裁剪工具输出可不调用模型。不是跨会话长期记忆，不能替代外部保存的证据与执行记录。 |
| [dsh-tool-ask-user](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/interaction/tool-ask-user/README.md) | 在字段含义或指标口径不明确时，向用户提出选项或问题，再继续执行。 | 优先。工具本身不负责渲染网页，需要问题服务、网站问答交互以及等待、恢复和取消处理。适合处理信息缺失，不能修复基础设施故障。 |
| [dsh-tool-todo](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/todo/tool-todo/README.md) | 维护待办、进行中、已完成步骤，用于展示“检查文件→清洗→汇总→图表→报告”。 | 次优先。与现有 Planner、任务事件统一映射，避免两套状态。模型标记完成不等于结果已通过验证。 |
| [dsh-mcp-client](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/mcp/mcp-client/README.md) | 将 MCP 服务的工具和资源接入 DSH，可作为未来 BI 或外部数据能力的入口。 | 外部接入阶段考虑。它是连接层，仍需目标 BI 对应的 MCP 服务或 API 适配器。当前工具白名单、网络及凭据配置需要显式适配。 |

官方 [sdk-minimal 说明](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/sdk-minimal/README.md)也明确区分最小 SDK 与完整配置。不能将完整 DSH 的默认能力当作我们已经启用的功能。

## 社区候选

| 插件及来源 | 上游提供的能力 | 对本项目的建议 |
| --- | --- | --- |
| [DSH Data Agent](https://github.com/omdsh-dev/dsh-data-agent)，包名 `@yejiming/dsh-data-agent`，MIT | 数据库对话分析、SQL、图表与看板、离线 HTML 报告，以及字段和指标口径治理。 | 最接近项目的产品方向，值得独立试用，重点评估报告与口径治理。当前源码 `0.2.0` 明确依赖 DSH `0.1.7-rc.1`，与本项目固定版本不同；还依赖 DSH 原生 Web 和预设系统。不能直接当作现有 Notebook 的即插即用插件。 |
| [dsh-data-mode](https://github.com/tieveto666-code/dsh-data-mode)，MIT | 原生 DSH Web 数据模式；数据库和 CSV/XLSX、DuckDB 查询，以及查询前检索业务口径与术语。 | 值得参考业务知识检索。与现有导入、SQL、语义模型重叠较多；其说明也区分提示词知识与经过认证的指标目录，不宜直接替换现有语义计算。 |
| [dsh-tool-sql](https://github.com/LJH-snow/dsh-tool-sql)，MIT | PostgreSQL/MySQL 查询、表结构、样本预览、列统计和解释计划等工具。 | 增加特定数据库能力时再评估。优先复用项目已有数据库权限和 SQL 执行链；不能仅凭 SQL 文本校验宣称数据库绝对只读。未实测与本项目 SDK 的兼容性。 |

版本核验：Data Agent 的部分网页缓存仍显示旧版 `0.1.5`，本次另通过 GitHub Contents API 读取 `main/package.json` 和 README，确认源代码版本为 `0.2.0`，`dsh.engines.dsh` 及官方 peer dependencies 为 `0.1.7-rc.1`。这是仓库源码核验，不代表 npm 最新发布版本核验。

## 建议顺序与验证边界

先评估 Skill 加载、上下文压缩、提问澄清；进度待办随后接入。明确外部 BI 目标后再选 MCP 服务。完整社区数据插件在独立副本试用，避免直接替换当前 Notebook 与验证流程。

没有安装插件、升级依赖、执行模型请求、运行兼容测试或启动服务；没有更改网站业务代码、运行开关或已交付 Excel。此次不涉及 UI 实现，不需要页面截图、构建或架构指纹同步。推荐收益仍需后续集成测试确认。

## 2026-09-27 · 官方插件设置与网站接入差异复核

本节只回答用户三张设置截图对应的可行性和原因，不实施界面迁移或自动开启插件。按插件管理检查顺序优先使用本地源码和已安装包，不搜索或安装无关的 Codex 外部集成。

### 已确认的事实

- `runtime/dsh/driver.mjs:111` 使用固定 `sdk-minimal` 与受控 patch，每轮独立 home / cwd；不是完整 DSH Web 宿主。已通过只读安装解析核对当前受管版本 `0.1.7-rc.2`，并读取实际安装包的 `cordis.patch.yml`，未启动执行任务。
- Skill 文件系统 / Skill 工具、上下文压缩、询问用户、文件工具、PowerShell 工具与设置 UI 的对应包都可在该安装树解析到同版本，**包存在不等于当前任务已加载**。最小配置不挂载上述大部分可选工具；Agent / loop / tools 等基础服务仍使用官方实现。
- `runtime/dsh/policy.mjs:24` 明确禁用默认终端、子进程、后台任务、MCP resources 等条目；`controlled-plugin.mjs:43–71` 要求注册的工具严格等于本轮网站目录并拒绝额外工具。原生 sessions 在指定模式按受控方式启用，不能笼统说“官方插件全部没启用”。这些限制在最近清理前就存在，不是删除 BI 原型或设置切换分支造成的。
- `core/agent-engines/server/selection.ts:19` 返回三组网站维护的能力说明，不查询官方插件注册表。当前设置页是能力只读目录，不是插件配置器。它没有证明全部官方插件未安装，也没有表达每个插件的真实挂载 / 启停状态。
- `runtime/dsh/web-assets.mjs` 提供官方聊天相关前端模块，`web-client.mjs:118–145` 只适配有限会话读取、发送和取消，未接官方插件 / 配置管理 RPC。设置 UI 包可用并不意味着完整设置窗口和服务端管理能力已接好。

官方 [sdk-minimal 说明](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/sdk-minimal/README.md)明确将其与包含设置、完整工具等能力的普通 SDK 配置区分。本次同时读了本机固定版本的真实配置，未用变化中的 master 推断固定版本运行状态。用户截图中的 29 / 185 是截图所示部署的数量，不能直接填入我们的网站，也不代表同样多的模型工具。

### 可行路线，尚未实施

界面可以对齐官方的左侧设置导航、搜索、会话 / 全局插件分组、状态卡片及展开配置。应优先评估复用当前固定版本的官方设置组件和管理协议，再接入本网站的实际插件清单及配置；不能只复制外观、显示假的“已启用”或可点击但无效的开关。

需要一并建立真实插件清单与状态投影、配置读写 / 校验与持久化归属、会话预设组装及生效时机。当前任务 home 是临时目录，直接在其中保存设置不等于后续任务仍生效。网站 Notebook / 数据 / 语义工具继续通过业务插件供 DSH 调用，不能为启用插件而旁路项目保存、来源范围和结果采用机制。

优先候选仍是限定目录的 Skill、上下文整理和提问澄清；它们各自需要内容来源、依赖、交互或会话生命周期适配，不是切开关即接通。终端 / 任意文件写入 / 外部网络单独明确作用范围，不默认全开；也不把所有官方能力永久禁用作为产品目标。若选择完整 SDK / Host 接管，需要显式迁移现有 RPC、会话和配置所有权，而非静默更换 profile。

本次仅研究 / 文档修改；没有修改执行配置、安装插件、调用模型 / 数据库、运行测试 / 构建或生成网站截图。`site:status` 显示三个既有服务健康，无启停 / 发布 / 提交 / 推送；现有未提交修改保留。没有声称管理界面已改成官方样式或插件已经启用。
