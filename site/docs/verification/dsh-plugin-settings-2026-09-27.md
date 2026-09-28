# DSH 插件设置 · 2026-09-27

## 本批固定范围

- 将现有弹窗改为类似官方的设置导航、搜索、分组、插件详情及预设；复用现有模型配置入口，不接完整官方 Host。
- 新建受本机同源约束的配置 API，复用原子 JSON 快照，保存 revision / Skill 开关；下次任务生效，不改变在途任务。
- 接入固定版本官方 Skill registry / tool，使用网站自带的有界说明，不扫描用户目录、不启动终端。真实加载与关闭均经离线官方 SDK 验证。
- 区分已配置、随任务提供、未接入、策略禁用、组件缺失。保留 Notebook 数据范围、草稿采用、旧 Harness 与原引擎选择 API。
- 不引入社区包、依赖升级、自动发布或完整 Host 迁移；提问交互、上下文压缩和高权限能力不在本批启用范围。

## 开工记录

运行约定、最近任务、相关架构 / 视觉和固定 SDK 公共接口已核查；设置组件、driver、native conversation、旧设置 API 的基线 4 文件 / 64 项通过。已有未提交内容保留。

## 已落地及文件归属

- `components/studio/AgentEngineSettings.tsx` 管理读写、请求取消和配置草稿；`dsh-settings/PluginSettingsContent.tsx` 负责导航、搜索、分组、详情与预设。复用原模型配置入口；`app/agent-engine-settings.css` 保持暖白、黑白灰和桌面双栏布局。不是完整官方 Host 页面。
- `core/agent-engines/plugin-settings.ts` 是独立严格契约；`server/plugin-catalog.ts` 维护 11 项网站接入目录，组件版本来自实际安装核查；`server/plugin-settings.ts` 复用原子 JSON 快照与文件锁，防止陈旧覆盖和损坏后静默重置。
- `app/api/settings/dsh-plugins/route.ts` 提供同源本机 GET / PATCH，限定 JSON 大小、字段、revision、组件完整性和活动任务数。API 只保存 Skill 布尔配置，不改变旧引擎选择、项目格式或数据权限。
- `runtime/dsh/builtin-skills.mjs` 新增两份只读说明；`policy.mjs`、`controlled-plugin.mjs`、`driver.mjs` 按保存的设置装配官方 registry / tool，仅额外允许 `skill`。默认关闭；并非加载全部官方插件。
- `core/agent-engines/server/dsh-driver.ts` 每轮捕获保存的配置；`native-conversation.ts` 将非零配置 revision 纳入模型会话范围指纹，组合改变后重建模型侧上下文，网页历史不删除。配置期间有任务则拒绝保存，不修改在途运行。
- 同步类型声明、回归测试、浏览器验收脚本、便携载体清单和架构检查范围；架构正文 / 变更记录与视觉规范更新。本批没有删除业务文件、升级依赖或更改锁文件。

模块边界：界面只经配置 API 读写；服务端拥有配置和安装核查；DSH 拥有对话 / 工具决策；网站 Notebook、SQL、Python、Dataset 仍负责实际数据执行和访问授权。Skill 只提供说明，不算业务证据，不直接访问数据，也不替代工具执行。后续接入其他官方能力需增加对应运行组装、配置字段及验收，不是仅加一个开关。

## 验证结果

| 命令 / 检查 | 本轮结果 |
| --- | --- |
| 原设置 / driver / 原生会话 / 旧 API 基线（4 文件） | 64 项通过 |
| `npm test -- --maxWorkers=2 --reporter=dot` | 282 文件 / 3,588 项通过；1 文件 / 3 项既有 EDS 实物工作簿检查因缺测试文件路径跳过；之后 26 项 Node 工具测试通过 |
| `pnpm exec vitest run components/studio/AgentEngineSettings.test.tsx --maxWorkers=2 --reporter=dot` | 最终 18 项通过；包含刷新回归、模型入口委派及未保存保护 |
| `node --test runtime/dsh/driver.test.mjs` | 20 项通过；实际固定 SDK 子进程执行 Skill 加载，关闭时不暴露该工具，模型为离线替身 |
| `node --test runtime/dsh/session-server.test.mjs runtime/dsh/readiness.test.mjs scripts/package-portable-windows.test.mjs` | 33 项通过；原生会话、就绪检查、载体清单与打包夹具 |
| `npm run typecheck` | 通过 |
| 21 个本批代码 / 测试 / 脚本文件 `pnpm exec eslint … --max-warnings=0` | 通过；最后补充的设置测试再单独检查通过；未跑全仓 lint |
| `npm run build` | 通过；保留已有大 chunk 提示，没有发布 |
| `npm run docs:agent:sync` / `npm run docs:agent:check` | 240 文件指纹一致 |
| `node scripts/verify-dsh-settings-browser.mjs` | 3001 成功；15 图逐张实际查看，页面 / 路由错误与禁止请求均为 0 |

测试与构建日志：[全量测试](../../.runtime/dsh-plugin-settings-20260927/full-test.log)、[运行时与打包检查](../../.runtime/dsh-plugin-settings-20260927/runtime-portable.log)、[构建](../../.runtime/dsh-plugin-settings-20260927/build.log)。最终应用行为之后运行全量；收尾仅补强原设置测试的模型入口断言并单独复验，没有再改应用逻辑。

本轮曾出现并解决两项验证失败：

1. SDK 关闭 Skill 且无业务工具时，模型请求按原协议省略 `tools`，首个新增断言错误地要求空数组；调整为准确检验“没有工具”，未改 SDK 行为。
2. 首次浏览器验收在外部配置改变后无法无提示关闭。定位为刷新始终保留旧选择，误认为有本地修改；先补失败回归，再改为只有真正未保存的草稿才保留。最终回归与浏览器全程通过。首次失败证据保留在 `site/.runtime/dsh-plugin-settings-20260927/browser-1790516835451/`，不作为最终通过截图。

## 3001 截图验收

本次使用独立空浏览器状态，不打开用户项目。安装 / 接入目录来自真实只读 API；全部 PATCH 拦截到隔离夹具，不改变真实部署配置。真实原子文件持久化在独立临时目录测试，实际 SDK 加载单独通过；**这不是一次网页真实保存再调用付费模型的完整端到端验收**。

[机器报告](../../.runtime/dsh-plugin-settings-20260927/browser-1790516921347/report.json)。以下 15 图全部实际查看：桌面 1440 / 1024 px 布局、文本、操作可见；成功、失败与取消状态吻合。未验证手机端。

| 截图 | 场景 | 来源 |
| --- | --- | --- |
| [01-plugin-catalog-1440.png](../../.runtime/dsh-plugin-settings-20260927/browser-1790516921347/01-plugin-catalog-1440.png) | 实际目录、分组、状态 | 真实 GET |
| [02-skill-details-1440.png](../../.runtime/dsh-plugin-settings-20260927/browser-1790516921347/02-skill-details-1440.png) | 官方 Skill 详情、版本及配置字段 | 真实 GET |
| [03-empty-search-1440.png](../../.runtime/dsh-plugin-settings-20260927/browser-1790516921347/03-empty-search-1440.png) | 搜索无结果 | 真实 GET |
| [04-not-integrated-1440.png](../../.runtime/dsh-plugin-settings-20260927/browser-1790516921347/04-not-integrated-1440.png) | 已安装但未接入的说明 | 真实 GET |
| [05-overview-1440.png](../../.runtime/dsh-plugin-settings-20260927/browser-1790516921347/05-overview-1440.png) | 组件可用与持久化边界 | 真实 GET |
| [06-unsaved-preset-1024.png](../../.runtime/dsh-plugin-settings-20260927/browser-1790516921347/06-unsaved-preset-1024.png) | 未保存的预设选择 | 真实 GET / 本地草稿 |
| [07-save-conflict-1024.png](../../.runtime/dsh-plugin-settings-20260927/browser-1790516921347/07-save-conflict-1024.png) | 保存冲突、保留选择、刷新要求 | 明确 PATCH 409 夹具 |
| [08-saved-1024.png](../../.runtime/dsh-plugin-settings-20260927/browser-1790516921347/08-saved-1024.png) | 保存成功、下一轮提示 | 隔离内存写回夹具 |
| [09-reopened-1024.png](../../.runtime/dsh-plugin-settings-20260927/browser-1790516921347/09-reopened-1024.png) | 重开恢复已保存选择 | 隔离内存写回夹具 |
| [10-discard-confirm-1024.png](../../.runtime/dsh-plugin-settings-20260927/browser-1790516921347/10-discard-confirm-1024.png) | 放弃未保存修改确认 | 真实 GET / 本地草稿 |
| [11-read-failure-1024.png](../../.runtime/dsh-plugin-settings-20260927/browser-1790516921347/11-read-failure-1024.png) | 读取失败后标记待确认 | 明确 GET 503 夹具 |
| [12-missing-component-1024.png](../../.runtime/dsh-plugin-settings-20260927/browser-1790516921347/12-missing-component-1024.png) | 依赖缺失、不能冒充已启用 | 明确缺组件夹具 |
| [13-active-task-1024.png](../../.runtime/dsh-plugin-settings-20260927/browser-1790516921347/13-active-task-1024.png) | 在途任务禁止设置修改 | 明确忙碌夹具 |
| [14-cancelled-1024.png](../../.runtime/dsh-plugin-settings-20260927/browser-1790516921347/14-cancelled-1024.png) | 取消等待、返回焦点 | 挂起 GET 夹具 / 空工作台 |
| [15-restored-1024.png](../../.runtime/dsh-plugin-settings-20260927/browser-1790516921347/15-restored-1024.png) | 恢复实际状态、键盘焦点约束 | 真实 GET |

## 启用、保留与限制

- 源码与 3001 热更新可用；原 Skill 默认关闭不变。入口为“Agent 执行与插件”→“Agent 预设”→“分析 + Skill”→“保存配置”，下一轮生效。也可在 Skill 卡片开关；两处共用同一配置。
- 本轮不写实际部署设置，不迁移用户数据，不调用真实模型 / 实库，不测试分析质量提升；没有产生模型费用。旧 Harness、业务授权、草稿采用和看板确认保留。
- 官方完整 Host、所有官方插件批量启用、社区插件安装、目录 Skill、终端 / 任意文件访问、结构化澄清、上下文压缩、图片接入不在本批范围。高权限能力需要单独界定目录和执行范围。
- 配置是本部署默认，不是每会话或每项目独立设置；不进入项目备份，不包含密钥。配置变化会重建模型侧连续性，不能宣称模型仍继承完整旧会话。
- 仅复用本机已安装依赖；便携载体清单已包含新模块，但未制作 / 发布新版 ZIP 或 Releases。没有发布 3000。
- 工作分支 `feature/eds-analysis-dashboard`；原有大量未提交 / 未跟踪内容保留，本批未提交、推送、切换分支或清理历史。其他任务的 Notebook / 依赖 / 删除修改不计作本批成果。
- 起止稳定站、开发站和截图服务健康，PID / 重启数未变化，无服务启停。测试与构建不替代后续真实模型分析验收。
