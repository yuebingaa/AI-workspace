# M6 第八包：项目兼容性诊断与拒写保护

日期：2026-09-21。状态：本包限定范围的源码、自动化与 3001 故障 / 恢复验收已完成，3000 未发布；不代表完整未知 Cell 前向兼容或整个 M6 完成。

## 范围与边界

对原本因未知 Notebook kind / 较新工作台或项目格式而返回通用 500 的场景，提供受控的兼容性诊断与 409 拒写。仍拒绝打开整个不兼容项目；没有未知 Cell 只读占位、部分项目编辑、迁移或新的宽松执行类型。已知 Cell 的非法字段、坏 JSON、结构 / 容量超限不冒充已兼容。历史 Agent 草稿和任意未来字段不在本批。

## 实际模块

- `core/projects/compatibility.ts`：只读、有界元数据预检 / Schema / 消息；版本由原入口注入，kind 复用现有目录，不调用 UI / 存储 / 模型。
- `core/projects/server/store.ts`：每次读取独立捕获已观察兼容性错误，原文件检查与同 adapter 原子保存保留；`read` / `edit` 共用，无新路径权限。
- `core/projects/server/request.ts`：仅真实错误类返回可选 `error.compatibility`；同源验证先于披露。
- `core/projects/client.ts` / `state-repository.ts`：校验 409 元数据，错误正文 16 KiB 上限；队列保留失败后编辑与显式重试，不依赖浏览器错误类。
- `components/studio/projects/ProjectCompatibilityNotice.tsx`、`DataBrowser.tsx` / `LocalProjectsProvider.tsx` 和 `StudioWorkspace.tsx`：共用错误展示，恢复失败不安装项目，成功后移除诊断；沿用既有重试 / 取消操作。
- `app/data-browser.css`：四条局部暖灰样式；领域、存储、API、客户端和 SSR 新回归及一项架构边界。

## 本次验证

- 修改前：`npm test -- core/projects/server/store.test.ts core/projects/client.test.ts core/projects/state-repository.test.ts --maxWorkers=2`，3 文件 / 57 项应用与 14 项 Node 通过。
- 新 core / store / API：3 文件 / 22 项通过；UI / client / queue 与原回归 / 架构：5 文件 / 80 项通过。
- 首次全量类型检查发现新增 API 测试的 JSON `unknown` 未缩窄（两处）；改为严格 Zod error envelope 解析后，API 6 项复测与 `npm run typecheck -- --incremental false` 通过，没有类型断言或放宽产品类型。新 core / store / API 连同原 store / API / 通用文件适配器共 6 文件 / 65 项通过；本批 15 个 TS / TSX 严格 ESLint 通过。
- 独立复核客户端 / 队列 / Provider / Data Browser / 工作台及新展示组件，未发现本批新增回归；失败打开不改活动句柄，错误后的继续编辑保留诊断，重试仍固定原项目，成功清除错误。`npm run docs:agent:sync` / `docs:agent:check` 为 161 文件一致，检查器单测通过。
- 首轮全量 2,427 项应用通过后，实际截图发现长错误文字挤压 Data Browser 状态栏、工作台顶栏；修为共用短状态标签和短恢复提示，完整信息只在详情卡显示。新增 `DataBrowserCompatibility.test.tsx` 两项 SSR（大规模诊断下标签仍短、普通错误不变），未掩盖失败截图。
- `npm test -- --maxWorkers=2` 复跑：228 文件 / 2,429 项应用通过，既有 1 文件 / 3 项跳过；14 项 Node 工具测试通过，离线 Harness 11/11。本包新增 40 项应用回归，没有移除 / 弱化失败测试。[最终全量日志](../../.runtime/hex-project-compatibility-2026-09-21/tests-final.log)。最后将工作台顶栏也接到短标签后，相关 UI / 客户端 / 架构 4 文件 / 47 项再次通过，并重新完成类型检查与构建；不把前一版截图算作最后版验收。
- 最终 `npm run typecheck -- --incremental false`、本批共 16 个 TS / TSX 的严格 ESLint（最后四文件另复查）、`npm run build` 通过。构建保留既有大于 500 kB chunk 提示（PowerShell 的 NativeCommandError 包装来自 stderr 警告，并非构建失败）；[最终构建日志](../../.runtime/hex-project-compatibility-2026-09-21/build-final.log)。`git -c core.safecrlf=false diff --check` 通过。未重跑全仓 lint、真实模型或 AdventureWorks，不把历史验证计入本轮。
- `node --check scripts/verify-project-compatibility.mjs` 及该脚本严格 ESLint 通过。30 项架构边界测试通过；161 文件指纹 sync / check 与检查器单测通过。

## 实际截图与未验证项

执行 `node scripts/verify-project-compatibility.mjs`，在已核对身份和固定基线摘要的既有合成项目中仅临时改写清单，不增加最近项目登记。每次改写先比较预期 SHA，保存原清单 608,374 字节；finally 关闭测试浏览器后恢复精确原字节并核对 37 份表 / 15 份原件的目录和摘要。原文件、定义和历史均保留，主代理另以文件哈希复查恢复。

[最终报告](../../.runtime/hex-project-compatibility-2026-09-21/browser-1789978095446/report.json)：7 组 / 7 张 1440×1000、1024×900 桌面截图通过且全部实际查看；主代理另看 01 / 05 / 06 / 07。Notebook / 模型 / 外部数据库执行请求均为零。目录连接 GET 两次、无句柄最近项目 GET 四次为明确空 fixture；固定公共字体 URL 允许空 CSS fixture，本轮未触发；项目 open / read / save 与所有 409 均来自真实受管 3001，没有替换错误响应。

| 场景 / 实际截图 | 核对结论 |
| --- | --- |
| [01 未知 Cell 拒绝打开](../../.runtime/hex-project-compatibility-2026-09-21/browser-1789978095446/01-unknown-kind-open-rejected-1440.png) | 真实 open 409，仅显示 Notebook 1 / 单元 2 / futureMatrix，未知标题 / 源码 / 嵌套标记不进入 API 或 UI；不安装项目 |
| [02 取消打开](../../.runtime/hex-project-compatibility-2026-09-21/browser-1789978095446/02-close-keeps-temporary-workspace-1024.png) | 关闭错误面板后仍为原临时工作区，没有活动项目句柄或自动运行 |
| [03 较新版本拒绝打开](../../.runtime/hex-project-compatibility-2026-09-21/browser-1789978095446/03-newer-workspace-version-rejected-1024.png) | 真实 open 409，明确当前支持 6 / 文件版本 7，不转换或覆盖 |
| [04 恢复后打开](../../.runtime/hex-project-compatibility-2026-09-21/browser-1789978095446/04-restored-open-no-auto-run-1440.png) | 放回原清单后真实 open 200，保存定义可见、状态待运行，无旧运行缓存和自动执行 |
| [05 旧窗口保存拒绝](../../.runtime/hex-project-compatibility-2026-09-21/browser-1789978095446/05-real-save-409-keeps-local-edit-1440.png) | 外部未知定义导致真实 save 409，本地修改标题保留，磁盘清单不变，顶栏短标签不覆盖模式按钮 |
| [06 重试仍拒绝](../../.runtime/hex-project-compatibility-2026-09-21/browser-1789978095446/06-retry-still-refused-1024.png) | retry 先发真实 scoped GET 409，没有新的 save POST；项目路径、错误卡和重试 / 放弃按钮在 1024 下可读 |
| [07 恢复后重试保存](../../.runtime/hex-project-compatibility-2026-09-21/browser-1789978095446/07-restored-explicit-retry-succeeds-1024.png) | 放回原清单后，显式 retry GET 200 + save POST 200，仅保留的标题 / Notebook 修订与保存时间等预期状态变化，项目修订 125→126；结束后再恢复原始基线 125 |

控制台为 5 条与真实 `/api/projects` 409 对应的预期失败，没有其他 console 错误；页面、路由和违规请求异常为零。未知 Cell 仍在磁盘保留，并非被转换为可运行类型。身份 / 目录 / 完整字节保护以 HTTP 和文件核对证明，不把截图当作字节校验。

前轮证据保留：`browser-1789977684895` 在取消态误断言折叠侧栏文案而失败；`browser-1789977711681` 功能通过但视觉发现路径竖排，且故障注入早于 Dataset 恢复结束产生额外 409，不能当作最终验收；`browser-1789977931457` 修复前一处并通过严格控制台门槛，实际查看又发现工作台顶栏长文字重叠；`browser-1789978075116` 恰逢代码热更新，Playwright 已收的 200 响应体随页面导航失效，保留失败，源码稳定后完整重跑。每轮均恢复原清单字节。仅最终 `browser-1789978095446` 同时通过交互、控制台与实际视觉复核。

本批未单独截图启动自动恢复、五项省略、project-format 分支或坏 JSON；前述版本 / 元数据 / 存储分支由自动化覆盖，Provider 恢复接线经类型和代码复核，不能冒称全交互覆盖。没有未知 Cell 只读模式、自动修复、跨进程恢复事务或系统重启验收。通用旧错误提示不改为兼容错误，既有大 chunk 提示仍保留。

## 工作区和发布

分支 `feature/eds-analysis-dashboard`；本次与既有修改保留，未提交 / 推送 / 切换分支，未迁移数据库或调用真实模型。受管服务前后均健康，supervisor / PID / worker / revision / 启动时间 / 重启数不变，稳定 release 不变。操作仅检查状态，不启停、重启或发布；源码开发站与 3000 稳定站仍分开。
