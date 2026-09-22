# M6 第九包：可选 Python 资源与缺件保护

日期：2026-09-21。状态：本包限定范围的源码、自动化、隔离构建与 3001 分层截图验收已完成；未发布 3000，不代表完整 M6 完成。

## 冻结范围

允许明确关闭 Python 的构建不携带离线运行资源；缺清单时 UI、Agent 和执行端统一不可用，旧定义仍可保存 / 重开，独立 SQL、表格、图表不依赖 Python 资源。恢复资源后可继续使用。不删除当前 `vendor/python`、不改受管服务配置；不删除 Python 类型、适配器或共用 Playwright，不称完整代码卸载。未知 Cell 只读打开及 M7 不在本包。

## 实际模块与改动

- `scripts/copy-notebook-runtime.mjs`：导出严格环境解析 `notebookPythonBuildEnabled(environment)`，复制入口新增可选布尔参数。默认仍要求资源；关闭时在任何写入前检查目标残留，连悬空链接也拒绝，保留 DuckDB、许可证及共用 Playwright。
- `scripts/runtime/site-runtime.mjs`：发布快照开始时解析稳定部署的有效开关，只向复制入口传布尔值，不改私有配置或复制凭据；该脚本新纳入架构指纹，检查器回归补齐对应漂移检查。
- `core/notebook/server/available-capabilities.ts`：`getNotebookCapabilities` 组装环境策略与可读普通清单标记；关闭优先不访问磁盘，缺失 / 非普通文件 / 读取失败 / 打开期间身份变化时返回有界原因，不回显路径。不读取内容、扫描全部资源或缓存状态。
- `core/notebook/server/runtime.ts`、`app/api/notebook/python/route.ts`、`app/api/ai/harness/handler.ts`：统一使用部署能力入口；请求不能覆盖，JSON / SSE 共用。现有 `capabilities.ts` 保持纯配置解析，RuntimeInfo / Python session 继续完整验证。
- `components/studio/notebook/NotebookPanel.tsx`：关闭提示补充实际服务端原因，保留原只读定义与操作约束；两项 SSR 覆盖缺件提示、独立 SQL 控件及文字转义，无新弹窗或安装操作。
- 新增 / 扩充核心、API、Harness、UI 与架构共 18 项应用测试；`scripts/copy-notebook-runtime.test.mjs` 新增 12 项 Node 测试，接入 `run-offline-tests.mjs`，不改依赖或锁文件。
- 验证脚本 `scripts/verify-python-optional-build.mjs` 将白名单源码复制到忽略的隔离目录，排除 Python 资源 / 私密配置，独立输出并运行真实打包 SQL worker，不启动服务；浏览器脚本 `scripts/verify-python-optional-runtime.mjs` 负责下节界面分层验收。

今后替换计算实现主要修改 `core/notebook/server` 的适配及资源复制入口；领域 Notebook / Dataset / 图表契约和 Harness 工具业务不因本次资源省略而改写。能力策略是可用性约束，不是授权替代。

## 实际自动化与构建

- 修改前：`npm test -- core/notebook/server/capabilities.test.ts core/notebook/server/runtime-capabilities.test.ts app/api/notebook/python/route.test.ts core/harness/notebook-capabilities.test.ts --maxWorkers=2`，4 文件 / 14 项应用、14 项 Node 通过。
- 运行侧最终专项 5 文件 / 25 项通过；真实临时目录覆盖缺失、恢复标记、非普通文件、错误脱敏和配置关闭零探测，I/O 异常 / 文件替换使用明确测试替身。Harness JSON / SSE 使用真实路由及能力目录、替身 HarnessRuntime，不调用模型；恢复清单只证明重新允许后续完整检测，不冒称 Python 已实际启动。
- 构建脚本 12 项通过，包含实际从无 Python 源目录复制 SQL 产物并执行 East=150 / South=80、CLI false / 非法值、默认缺件拒绝及目标目录 / 文件 / 有效和悬空链接拒绝；原资源不删不改。
- UI 7 项、架构 31 项通过。首次类型检查发现新 Harness 测试缺 `clock` 参数，另一次专项发现新字段夹具缺标签，修正合法测试输入后复跑，不放宽产品 Schema。首次隔离脚本遗漏独立 evidence 目录，尚未构建即失败；补 `mkdir` 后重跑成功，不将失败计为通过。
- `npm test -- --maxWorkers=2`：230 文件 / **2,447 项应用通过**，既有 1 文件 / 3 项跳过；**26 项 Node** 全部通过，离线 Harness 11/11。[全量日志](../../.runtime/hex-python-optional-runtime-2026-09-21/tests.log)。`npm run typecheck -- --incremental false` 通过。
- `npm run build` 默认完整产物通过，保留大于 500 kB chunk 提示；PowerShell 的 stderr 包装不代表构建失败。[默认构建日志](../../.runtime/hex-python-optional-runtime-2026-09-21/build-default.log)。
- `node scripts/verify-python-optional-build.mjs`：[隔离报告](../../.runtime/hex-python-optional-runtime-2026-09-21/build-1789979564361/report.json) 与 [构建日志](../../.runtime/hex-python-optional-runtime-2026-09-21/build-1789979564361/build.log) 通过。源和产物均无 `vendor/python`，完整 vinext 构建、两项运行资源复制及真实产物 SQL 查询得到 150 / 80 / 230；当前安装全部 Python 文件 SHA 保持。源码副本在仓库忽略的 `artifacts/hex-python-optional-build-2026-09-21/`，仅复用构建依赖联接，不修改依赖。此轮隔离构建早于界面补原因，运行 / 打包代码相同；之后的默认构建与全量回归包含最终 UI。
- 本批相关 TS / TSX、脚本严格 ESLint 与 Node 语法检查通过；架构 sync / check 为 163 文件，检查器测试通过；差异检查通过。未跑全仓 lint、真实模型、远程数据库或新的 AdventureWorks 联调。

## 3001 截图验收

执行 `node scripts/verify-python-optional-runtime.mjs`，[最终报告](../../.runtime/hex-python-optional-runtime-2026-09-21/browser-1789980027428/report.json) 6 组 / 8 图通过。最终全部 1440 / 1024 图已实际查看，主代理另逐图复核。缺件显示使用明确 `GET /api/notebook/python` 替身；不能将其写成真实受管服务卸载证明。真实服务端物理缺件由上节临时目录 / 路由测试，资源省略由独立产物证明。

| 实际截图 | 验收结论 |
| --- | --- |
| [01 缺件只读 1440](../../.runtime/hex-python-optional-runtime-2026-09-21/browser-1789980027428/01-missing-python-readonly-1440.png)、[02 缺件只读 1024](../../.runtime/hex-python-optional-runtime-2026-09-21/browser-1789980027428/02-missing-python-readonly-1024.png) | 准确说明缺资源及恢复方向，保留 Python 源码，创建 / 编辑 / 单跑 / 全跑受控；缺件阶段不发 Python 执行请求 |
| [03 独立表格](../../.runtime/hex-python-optional-runtime-2026-09-21/browser-1789980027428/03-real-independent-table-1440.png)、[04 独立图表](../../.runtime/hex-python-optional-runtime-2026-09-21/browser-1789980027428/04-real-independent-chart-1024.png) | 两次真实 3001 Notebook POST，Data → SQL → 表 / 图得到 East=150、South=80，运行闭包不含 Python |
| [05 取消 SQL 编辑](../../.runtime/hex-python-optional-runtime-2026-09-21/browser-1789980027428/05-cancel-keeps-saved-definitions-1440.png) | 整份已保存 Notebook 和项目修订不变，旧 Python 定义未改 |
| [06 刷新保留](../../.runtime/hex-python-optional-runtime-2026-09-21/browser-1789980027428/06-refresh-retains-definitions-no-auto-run-1024.png) | 同一项目重开保留所有定义，结果待运行，不自动计算 |
| [07 真实恢复 1440](../../.runtime/hex-python-optional-runtime-2026-09-21/browser-1789980027428/07-real-python-restored-1440.png)、[08 真实恢复 1024](../../.runtime/hex-python-optional-runtime-2026-09-21/browser-1789980027428/08-real-python-restored-1024.png) | 移除 GET 替身后真实状态可用，同一份 Python 手工运行成功，East=300、South=160，无迁移 |

最终轮共三次真实 Notebook POST，未替换执行结果；console / page / route / 违规请求均为零。仅连接目录 GET（8 次）和无句柄最近项目 GET（1 次）用空 fixture，精确公共字体 URL 允许空 CSS但本轮未请求；无真实模型、外部数据库或稳定站访问。

复用已核对归属的合成项目，不增加 / 清理登记。首轮仅追加固定页及五单元 Notebook，项目修订 125→127、页 / Notebook 各 15→16；原 37 表 / 15 原件、原页面和定义均保持。后三轮复用同一页不追加，最终轮清单起止同为 610,568 字节且 SHA 相同、修订均 127；旧表 / 原件目录和文件摘要逐项一致。新合成页保留用于复核，没有删除用户文件。

保留失败证据：`browser-1789979902336` 误把 aria-hidden 行号计入源码等值断言；`browser-1789979938124` 六组通过但误要求可选字体 fixture 必须触发；`browser-1789979987880` 六组通过但关闭浏览器后重复使用其请求上下文进行核对。修正测试脚本的断言 / 关闭顺序后完整重跑，只有最终轮同时通过全部检查，不弱化业务、结果或资源保护断言。

## 工作区与保留边界

`feature/eds-analysis-dashboard` 上既有及本批未提交内容均保留；不提交 / 推送 / 切分支、不删除用户数据 / 安装资源、不修改依赖、锁文件或现有服务配置，不发布 3000。构建和 SQL 子进程仅服务本批验证，不新增网站端口。前后 `npm run site:status` 均健康，supervisor / PID / worker / revision / 启动时间 / 重启数一致，稳定 release 未变。

仅资源清单缺失 / 不可读取使能力目录关闭；其他单个资源损坏、浏览器或 SDK 缺失仍由原 RuntimeInfo / 执行检测，不保证 Agent 目录在所有部分损坏下都隐藏 Python。未实际运行受管 publish、无 Python 独立服务器 HTTP、完整便携压缩包 / 新电脑或系统重启；无 Python 安装包的持久化 / UI 行为按模块和 3001 替身分层验收，不冒称实机卸载。未知 Cell 打开、完整能力代码卸载与 M7 仍独立保留。
