# DSH 设置直接复用官方 Web · 2026-09-27

## 结论与范围

上一版为自绘的仿官方设置。当前改为实际加载已安装的 DSH 0.1.7-rc.2 设置外壳、导航及插件列表，不再维护第二套卡片 / 搜索 UI。按插件管理规则优先使用已安装组件，未安装或升级依赖。仅源码与 3001 生效，3000 / GitHub / 便携发行未更新。

本批边界是“官方设置 UI + 网站既有配置适配”，不是将完整官方 Host 接管网站。网站仍拥有数据授权、Skill 配置、模型密钥、任务和草稿状态；执行层、旧 Harness、Notebook、业务工具及数据格式没有改变。

## 实际复用与改动

- 原版 `dsh-client-ui-settings-general`：SettingsPanel、侧栏导航和通用页；`dsh-client-ui-settings-plugins`：插件页；`dsh-client-ui-settings-plugin-inventory`：搜索、分组、卡片及详情。包 JS / CSS 未修改。
- 官方 primitives：Button、Switch、SegmentedControl、Modal，用于网站配置页和放弃修改确认。两个网站能力组合仍是网站业务，不冒充完整 Host 的 Agent 预设编辑。
- `runtime/dsh/web-assets.mjs`：聊天保持原 23 项启动图，设置独立 26 项图；只在设置组装图省去 inventory 对 `ui-agent-preset` 的名称翻译依赖，避免加载没有后端的官方预设编辑器。不修改原包文件，不升级版本。
- `runtime/dsh/web-settings.mjs`：有限只读 RPC、原版设置启动、公开插槽、中文状态标注与网站表单。通用页提示客户端偏好仅作用于官方嵌入界面，不能启用网站尚未接入的工作步骤或代码能力。
- `core/dsh-web/settings-projection.ts`：严格命令契约和公开安装 / 网站配置投影；未知状态不报已启用，未提供真实 Host fiber 状态。
- `components/studio/dsh-settings/OfficialSettingsFrame.tsx` 与 `settings-contract.ts`：同源 frame / nonce、懒加载、取消、超时与受限命令桥。`AgentEngineSettings.tsx` 保留版本冲突、草稿、刷新、任务锁、确认退出等生命周期。
- `core/dsh-web/server/assets.ts`：仅固定 `?surface=settings` 选择设置文档；沿用可信同源与资源白名单、CSP `connect-src 'none'`，没有任意文件或私密配置入口。
- `scripts/portable-build-utils.mjs`、`scripts/check-agent-architecture.mjs`：载体复制清单与指纹覆盖新模块，未制包。

已退役 `PluginSettingsContent.tsx`、`OfficialPluginInventory.tsx` 及其专属 DOM 测试；原生命周期和目录失败 / 恢复 / 取消 / 状态断言迁到 `AgentEngineSettings.test.tsx`、`OfficialSettingsFrame.test.tsx`、`settings-projection.test.ts` 和实际浏览器验收，不通过删除失败断言修复回归。自绘 CSS 收为嵌入容器四条规则。先核对生产引用、测试、脚本和入口，再移除；[本地源码留底](../../.runtime/dsh-native-settings-20260927/retired-ui.patch)仅供恢复参考。两条旧浏览器脚本入口保留为新版验收的兼容入口，历史报告与截图不删除。

## 模块与状态边界

设置与聊天各有独立 bootstrap / bridge / 启动图；设置不提交消息或模型任务。官网 UI 的 `pluginInventory/list` 只读映射到已有网站目录 API，`settings/describe` 为无文件、不可写的展示用 locale 描述，其他 Host 写入拒绝。网站配置 PATCH 仍只接受 revision 与 Skill 布尔值，不提供通用文件写入或插件安装 / 执行接口。

目录本次实际读取 274 个顶层 DSH 包，网站接入标注 11 项；不是 274 个可用工具，不强行凑截图的 29 / 185。列表为打开期间的快照，保存配置后需关闭重开以刷新；切换页面不丢失未保存选择。目录读取期间若配置过期则拒绝状态投影，关闭中止请求，错误不泄漏上游文本和本地路径。

固定可信 SDK 同源 iframe 不是第三方插件安全沙箱，已有 `allow-scripts allow-same-origin` / `unsafe-eval` 边界保留。尚未支持的模型设置、终端、任意文件、完整 Host 预设管理和安装 / 卸载不因此自动开放。

## 验证

- 定向：`pnpm exec vitest run components/studio/AgentEngineSettings.test.tsx components/studio/dsh-settings/OfficialSettingsFrame.test.tsx core/dsh-web/settings-projection.test.ts core/dsh-web/server/assets.test.ts --maxWorkers=2 --reporter=dot`，4 文件 37 项通过。[日志](../../.runtime/dsh-native-settings-20260927/target-tests.log)。模拟 iframe peer 只测父协议，不访问实际网站，真实 iframe 由下面的 Edge 验证。
- `npm run typecheck` 通过；18 个本批 JS / TS / TSX 文件 `eslint --max-warnings=0` 通过。[类型日志](../../.runtime/dsh-native-settings-20260927/typecheck.log)、[代码检查](../../.runtime/dsh-native-settings-20260927/lint-final.log)。
- `npm run build` 通过，保留已有大 chunk 警告。[构建日志](../../.runtime/dsh-native-settings-20260927/build.log)。
- `node --test runtime/dsh/web-assets.test.mjs runtime/dsh/web-settings.test.mjs runtime/dsh/web-client.test.mjs runtime/dsh/package-inventory.test.mjs scripts/package-portable-windows.test.mjs`：55 项通过，1 项测试夹具无法创建文件符号链接（Windows `EPERM`）；不是业务断言失败，也不计作通过。保留测试，无跳过 / 权限绕过。公开资源和新的设置 transport / codec 检查通过；该复合用例中后续链接检查也未执行。[日志](../../.runtime/dsh-native-settings-20260927/runtime-tests.log)。
- `npm test -- --maxWorkers=2 --reporter=dot`：285 文件 3612 项通过；既有 EDS 实物 1 文件 3 项因未指定工作簿跳过，随后 26 项 Node 工具测试通过。[全量日志](../../.runtime/dsh-native-settings-20260927/full-tests.log)。最终重跑设置 transport 5 项通过。[日志](../../.runtime/dsh-native-settings-20260927/settings-transport-final.log)。
- 架构正文及变更记录已同步，`docs:agent:sync` / `docs:agent:check` 为 247 文件；目标 `git diff --check` 通过。最终 `site:status` 三服务健康，PID 与重启数保持任务开始状态。

开发中修正：官方 locale 字典需用新语言包扩展而不是重复注册；通过公开 launcher 打开官方 portal，而不是替换 root 或重复注册相同导航；移除未接通的原生预设编辑入口。测试的 iframe 自动网络、空窗口替身与可访问名称定位也已修正；失败记录保留，不计为验收。

## 3001 本次截图

运行 `node scripts/verify-dsh-native-settings.mjs`，隔离空浏览器，不打开用户项目。安装目录使用实际同源 GET；Skill 保存、409 与目录 503 是明确的浏览器拦截夹具，未提交到真实服务器。结束复读真实配置确认不变。没有收费模型或数据库调用。

以下 11 张原图已逐张实际查看；1440 / 1024 px 显示通过，Tab 留在官方 frame、Escape 关闭、版本冲突后刷新、继续编辑和放弃关闭通过。机器报告页面异常 / 禁止请求为 0。[本次报告](../../.runtime/dsh-native-settings-20260927/browser-1790523879052/report.json)。

| 图片 | 场景与结论 |
| --- | --- |
| [01](../../.runtime/dsh-native-settings-20260927/browser-1790523879052/01-official-shell.png) | 官方弹窗、导航及动态 11 / 274 分组，清晰标注快照 |
| [02](../../.runtime/dsh-native-settings-20260927/browser-1790523879052/02-official-plugin-cards.png) | 官方搜索与双列卡片，安装状态不冒充启用 |
| [03](../../.runtime/dsh-native-settings-20260927/browser-1790523879052/03-no-results.png) | 无匹配项，明确空结果而非读取失败 |
| [04](../../.runtime/dsh-native-settings-20260927/browser-1790523879052/04-save-conflict.png) | 409 夹具：草稿保留、禁存、提示刷新 |
| [05](../../.runtime/dsh-native-settings-20260927/browser-1790523879052/05-save-success.png) | 隔离配置保存成功，下一轮生效提示 |
| [06](../../.runtime/dsh-native-settings-20260927/browser-1790523879052/06-discard-confirmation.png) | 官方 Modal：继续编辑 / 放弃确认；背景重开到通用页但草稿仍保留 |
| [07](../../.runtime/dsh-native-settings-20260927/browser-1790523879052/07-inventory-failure.png) | 503 夹具：官方错误与重试，1024 px 无遮挡 |
| [08](../../.runtime/dsh-native-settings-20260927/browser-1790523879052/08-recovered-1024.png) | 恢复真实元数据，不误报零个组件 |
| [09](../../.runtime/dsh-native-settings-20260927/browser-1790523879052/09-closed.png) | Escape 关闭回工作台，真实配置不变 |
| [10](../../.runtime/dsh-native-settings-20260927/browser-1790523879052/10-general.png) | 官方通用页及明确的网站接入边界说明 |
| [11](../../.runtime/dsh-native-settings-20260927/browser-1790523879052/11-preset.png) | 官方分段控件切换网站组合，切回配置页保留选择 |

## 保留风险与未验证

- 没有完整 Host RPC / 注册树，目录语义是明确标注的映射；第三方插件管理需独立接入，不可把界面复用当作权限开放。
- 通用页的官方客户端偏好不承诺控制整个 DataCanvas；深色、字体与其他跨 frame 偏好的联动未逐项验收。模型密钥仍走网站现有配置。
- 官方包固定为候选版本；升级时应重新验证依赖图、插槽、RPC codec、locale 扩展及官方 portal 的嵌入。设置模块缺失会使受管资源初始化明确失败。
- 浏览器控制台仍观察到既有聊天投影 `SessionSeq -1` 警告（设置流使用空 session 投影）、可信 iframe sandbox 警告，以及预期的 409 / 503 夹具日志；不能称控制台零告警。未扩大本批为聊天协议修复。
- 未运行全仓 lint、真实模型 / 实库 / 工作簿端到端、手机或新便携包验收；本批 UI 不需要收费调用。文件符号链接用例受环境限制如上。
- 工作区保留原未提交内容；没有提交、推送、合并、安装依赖、改密钥、启停网站服务或发布 3000。截图与日志在本机忽略目录，不随 Git 自动分发。
