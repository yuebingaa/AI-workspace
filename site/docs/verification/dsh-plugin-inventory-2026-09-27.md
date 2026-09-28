# DSH 完整安装目录 · 2026-09-27

## 本批固定范围

- 保留上一批网站能力与 Skill 配置，新增独立只读官方组件目录，懒加载、搜索、分类、分页及详情。
- 仅从已选受管 DSH 安装读取 `@deepseek-ai/dsh*` 包元数据，动态计数；不递归扫描全仓，不 import 插件代码、不启动完整 Host。
- 明确这是安装包清单而非官方 Host 的会话 / 全局实例列表。未知接入情况仅确认安装，不伪造 29 / 185 或运行状态。
- 已接入的能力关联网站目录，其他组件说明范围；读取失败 / 不完整可见。配置 API、实际执行及权限不扩。
- 不新增外部依赖、不切换 profile、不启用高权限能力、不调用付费模型、不发布 3000。

## 开工基线

已读运行约定、近期日志、架构与视觉现状；定向 3 文件 / 40 项通过。三个服务健康；当前 `feature/eds-analysis-dashboard`，包含其他任务大量未提交修改，均保留。按插件管理检查规则优先复用本机安装，区分安装、配置与实际可用；没有新增 Codex 外部插件。

## 实际落地与边界

1. `runtime/dsh/package-inventory.mjs` / `.d.mts`：受管安装内只读扫描，包名、文件类型、路径链接、硬链接、元数据大小与公共返回字段校验。最多 1000 个候选，单文件 64 KiB；不执行入口。读取逐包隔离，异常不泄露路径，包缺失 / 无效不算成功条目。
2. `runtime/dsh/driver.mjs` / `.d.mts`、`core/agent-engines/server/dsh-driver.ts`：现有安装选择解析后委派读取；载体修订 10，不更改 SDK 或执行规则。`scripts/portable-build-utils.mjs` 白名单包含新载体，但未制作便携包。
3. `core/agent-engines/plugin-inventory.ts`、`app/api/settings/dsh-plugins/inventory/route.ts`：严格公共 DTO 与同源只读 GET，拒绝路径 / 查询参数，私有不缓存、取消检查、固定错误，不暴露凭据 / 异常堆栈。无安装、启停或保存 API。
4. `components/studio/dsh-settings/OfficialPluginInventory.tsx`：目录查询状态与旧设置草稿分离，懒加载、搜索、四类筛选、网站标注项筛选、20 项分页、展开版本 / 依赖 / 原因。切走或关闭取消读取；刷新失败保留的快照降为待确认。`PluginSettingsContent.tsx` 仅新增目录切换；原有 Skill 配置和关闭确认保留。
5. `app/agent-engine-settings.css`：复用暖白卡片、窄屏自适应与固定底栏。翻页返回目录摘要，避免停在列表底部。
6. 新增 API / UI / 载体测试、`scripts/verify-dsh-inventory-browser.mjs`；更新架构正文、变更记录、指纹、视觉规范、载体 README。

本机该次实际读取 **274** 个顶层 `@deepseek-ai/dsh*` 包：运行与基础服务 172、模型工具 21、界面组件 72、配置组合 9；全部成功读取。这是本机当前安装快照，不是承诺固定总数、可用工具数或官方截图中的会话 / 全局实例数。分类依据公开包元数据 / 名称，不代表执行作用域。

已标注包关联既有网站能力状态；其他条目显示“仅确认安装”，不声称未加载、未使用或可以立即启用。此目录不含非 `dsh*` 依赖、全部嵌套依赖或完整 Host 实例。默认只读，不复制一批无实际接线的开关。

## 实际验证

命令均在 `site/`；本批没有真实模型、用户工作簿或远程数据库调用。

| 实际命令 | 本次结果 |
| --- | --- |
| `pnpm exec vitest run components/studio/AgentEngineSettings.test.tsx core/agent-engines/server/plugin-settings.test.ts app/api/settings/dsh-plugins/route.test.ts --maxWorkers=2 --reporter=dot` | 开工基线 3 文件 40 项通过 |
| `npm test -- --maxWorkers=2 --reporter=dot` | 284 文件 3609 项通过，既有 EDS 实物 1 文件 3 项因未提供工作簿路径跳过；随后 26 项 Node 工具测试通过。包含工作区当时其他已实现变更，不将它们计为本批新增功能 |
| `node --test runtime/dsh/package-inventory.test.mjs runtime/dsh/driver.test.mjs runtime/dsh/session-server.test.mjs runtime/dsh/readiness.test.mjs scripts/package-portable-windows.test.mjs` | 60 项通过；目录自身 7 项，真实固定 SDK 离线载体及现有会话 / 就绪 / 打包回归，不调用付费模型 |
| `npm run typecheck` | 最终通过 |
| `pnpm exec eslint` 对本批 13 个 JS/TS 文件加 `--max-warnings=0` | 最终通过，见下方精确文件列表；没有全仓 lint |
| `npm run build` | 通过；仍有既有大 chunk / 插件耗时提示，无发布 |
| `npm run docs:agent:sync`、`npm run docs:agent:check` | 245 个源码文件通过 |
| `node scripts/verify-dsh-inventory-browser.mjs` | 3001 浏览器通过，12 张截图逐张实际查看，0 页面错误 / 路由错误 / 禁止请求 |

定向 ESLint 文件：`components/studio/dsh-settings/{PluginSettingsContent.tsx,OfficialPluginInventory.tsx,OfficialPluginInventory.test.tsx}`、`app/api/settings/dsh-plugins/inventory/{route.ts,route.test.ts}`、`core/agent-engines/{plugin-inventory.ts,server/dsh-driver.ts}`、`runtime/dsh/{driver.mjs,package-inventory.mjs,package-inventory.test.mjs}`、`scripts/{portable-build-utils.mjs,check-agent-architecture.mjs,verify-dsh-inventory-browser.mjs}`。

过程问题已修复：新 API 测试的 `beforeEach` 误返回 mock 函数，被 Vitest 当清理回调；改为无返回值。类型检查发现两个未知 JSON 返回值断言未解析，改为严格 DTO 解析；定向 lint 发现测试替身未用参数，改用有类型替身。首轮截图发现翻页停留在列表底部，补焦点回归并重截最终 12 图。没有删除失败测试、降级断言或改已有业务规则。

[应用测试日志](../../.runtime/dsh-plugin-inventory-20260927/tests.log) · [载体日志](../../.runtime/dsh-plugin-inventory-20260927/runtime.log) · [构建日志](../../.runtime/dsh-plugin-inventory-20260927/build.log)。

## 3001 截图验收

独立空浏览器，1440 / 1024 px，未打开用户项目；实际安装目录与原配置通过只读 GET 获取。场景状态仅在浏览器拦截中模拟，任何持久化写请求均拒绝；结束后重新读取真实目录和配置，与开始快照相同。下列截图已逐张查看，不使用用户参考图或早期旧图替代验收。

| 截图 | 场景与结论 |
| --- | --- |
| [01 网站能力](../../.runtime/dsh-plugin-inventory-20260927/browser-1790520352069/01-website-capabilities-1440.png) | 真实目录；保留原配置、分组与底栏 |
| [02 官方组件](../../.runtime/dsh-plugin-inventory-20260927/browser-1790520352069/02-official-inventory-1440.png) | 真实 274 动态计数；清楚区分安装和运行状态 |
| [03 翻页](../../.runtime/dsh-plugin-inventory-20260927/browser-1790520352069/03-next-page-1440.png) | 第二页内容可达，焦点与滚动回到摘要 |
| [04 Skill 详情](../../.runtime/dsh-plugin-inventory-20260927/browser-1790520352069/04-skill-metadata-1440.png) | 名称 / 安装版本 / 依赖与网站状态分开显示，无新开关 |
| [05 分类](../../.runtime/dsh-plugin-inventory-20260927/browser-1790520352069/05-client-components-1440.png) | 实际 72 个界面组件，未误报完整 Host 已启用 |
| [06 网站标注](../../.runtime/dsh-plugin-inventory-20260927/browser-1790520352069/06-known-integrations-1024.png) | 1024 px 筛选已标注条目，状态有别于仅安装 |
| [07 无结果](../../.runtime/dsh-plugin-inventory-20260927/browser-1790520352069/07-no-match-1024.png) | 真实目录搜索为空，明确无匹配而非安装为零 |
| [08 部分读取](../../.runtime/dsh-plugin-inventory-20260927/browser-1790520352069/08-partial-inventory-1024.png) | 明确部分元数据夹具；未读取项单列，未伪造完整总数 |
| [09 刷新失败](../../.runtime/dsh-plugin-inventory-20260927/browser-1790520352069/09-failed-refresh-1024.png) | 明确 503 夹具；旧结果仅供参考、状态降级、可重试 |
| [10 草稿保留](../../.runtime/dsh-plugin-inventory-20260927/browser-1790520352069/10-draft-retained-1024.png) | 切换目录不丢失未保存 Skill 选择，退出需放弃确认；未提交 |
| [11 取消](../../.runtime/dsh-plugin-inventory-20260927/browser-1790520352069/11-cancelled-1024.png) | 明确挂起 GET 夹具中关闭，返回隔离空工作台 |
| [12 重开恢复](../../.runtime/dsh-plugin-inventory-20260927/browser-1790520352069/12-restored-1024.png) | 重开恢复真实目录，焦点仍在弹窗内，配置无改变 |

[机器报告](../../.runtime/dsh-plugin-inventory-20260927/browser-1790520352069/report.json)中所有 `actualImageReviewed` 均已据实际查看置真。视觉确认暖白布局、文本与状态可辨，目录滚动不遮挡固定操作栏。

## 交付与保留

源码与 3001 开发站可用；3000 稳定站、生产数据、安装依赖树、Skill 配置与执行白名单未改。不启用终端、任意文件、上下文压缩、提问澄清或完整 Host；尚未测量这些能力或模型效果。没有新便携包 / Release、提交 / 推送 / 分支切换或文件删除。共享工作区其他 Notebook 等修改保留、不归为本批成果。

后续若接入某项官方能力，仍须在实际驱动 / 工具边界接线、补执行回归，再更新网站目录的接入状态；安装目录无需硬编码补数量。本次并非完成全部插件可配置化。截图和日志位于本机 `.runtime`（忽略目录），Git 推送不会自动携带这些验收文件。
