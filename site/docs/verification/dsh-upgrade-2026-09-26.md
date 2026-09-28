# DSH 0.1.7-rc.2 升级验收（2026-09-26）

用户要求更新到已讨论的官方新版并去除旧版本。范围为当前项目嵌入的 DSH SDK / 测试内核，目标为[官方候选版 0.1.7-rc.2](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.7-rc.2)；不改全局应用或历史发行包。当前已完成升级，3001 运行新版且选中 DSH，三处旧安装已移除。

## 实际修改

- `runtime/dsh/package.json` / lock / policy 固定 0.1.7-rc.2，Cordis 4.0.4、Schemastery 3.18.4、pi-ai 0.85.1；保留 fflate 0.8.3 定向覆盖。网站主 package / lock 未修改。Windows 安装 518 个包，锁文件审计 0 已知漏洞。
- `chat-adapter.mjs` / `controlled-plugin.mjs` 使用官方 pi-ai 适配器维持 Chat Completions。新版 DeepSeek 专用适配器仅支持 Messages，不能直接沿用旧 protocol 参数。仅使用任务传入的精确模型和密钥，无环境凭据发现、额外插件或自动重试。wire policy 保持 thinking disabled，未指定上限时省略 max_tokens / reasoning_effort。
- `installation.mjs` 允许读取旧版本指针以完成升级，但解析执行树和回退仍要求当前版本。失败候选不得覆盖旧树。`native-loader.cjs` 和修订依赖图避免 Vite/RSC 导入改写以及缓存的旧 VERSION；3001 初次切换后为 ready / 0.1.7-rc.2、engine=dsh、revision=7。后述自动重启后通过原设置接口恢复 DSH，最终 revision=1、activeTasks=0。
- 官方工具失败事件迁至 `ToolResultMessage.isError`。离线 pilot 共用同一活动安装，删除单独的旧 manifest / lock；报告不再冒用旧版本 commit。便携载体清单和架构指纹纳入两个新文件。

## 已执行验证

- 最终候选安装：33 项真实 SDK / 回环模拟 SSE / 内核检查通过，无跳过。正式源码和活动安装：57 项 Runtime / 安装迁移 / 打包选择 / pilot 检查全部通过。
- `verify-dsh-embedding.mjs` 通过：4 工具、真实本地 SQL East=150 / South=80、草稿 awaitingConfirmation、内存采用和取消传递 / 子进程回收；未保存用户项目。证据：[JSON](../../.runtime/dsh-embedding-1790407770222/report.json)。
- `verify-dsh-capabilities.mjs` 通过：实际官方 SDK / 工具桥 / Pyodide pandas+openpyxl / DuckDB 完成 Excel→Python→SQL→Table/Chart，合成停机结果 3 分钟；数据库 Schema/查询端口使用明确替身，未连接真实 PostgreSQL。[证据](../../.runtime/dsh-capabilities-1790408044195/report.json)。
- `verify-dsh-dispatch.mjs` 通过：本地模拟 Chat Completions，实际 SDK / broker / 业务桥，同一响应的两工具按顺序串行执行，最大并发 1；报告已使用新的适配器名称。[证据](../../.runtime/dsh-dispatch-1790408272301/report.json)。验收进程出现 Vite 默认 HMR 24678 占用警告，业务断言及退出码均成功；未更改网站端口。
- 共享 Runtime 的旧 pilot 集成通过，真实本地 SQL East=150 / South=80，取消保持正式文档不变。[证据](../../.runtime/dsh-notebook-pilot-1790408272206/report.json)。
- `npm test -- --maxWorkers=2`：269 测试文件通过，**3378 项应用测试通过、3 项跳过**；后续 **26 项 Node 工具测试通过**。跳过项为既有 EDS 真实工作簿验收，未设置 `EDS_REAL_SOURCE_PATH` / `EDS_REAL_TEMPLATE_PATH`。[日志](../../.runtime/dsh-upgrade-20260926/full-tests.log)。
- `npm run typecheck`、本批文件严格 ESLint、`npm run build` 通过。构建有既有的大块体积 / 插件耗时提示；没有发布构建。[类型](../../.runtime/dsh-upgrade-20260926/typecheck.log)、[ESLint](../../.runtime/dsh-upgrade-20260926/lint.log)、[构建](../../.runtime/dsh-upgrade-20260926/build.log)。
- `npm run test:portable`：**30 项通过**。另实际使用生产复制函数创建 `controlled-notebook-v1` 依赖树，按既有规则剔除两项 LibreOffice 和两项 Sharp 包，完成 bundled 验证后运行 **16 项官方 SDK 检查全部通过**，包含工具成功/失败/取消及 Chat Completions 回环模拟；并非完整便携 ZIP 或新电脑验收。[打包检查](../../.runtime/dsh-upgrade-20260926/portable-tests-final.log)、[裁剪 SDK 检查](../../.runtime/dsh-upgrade-20260926/portable-sdk-smoke.log)。
- 活动安装 `npm audit --json`：**0 已知漏洞**。[审计](../../.runtime/dsh-upgrade-20260926/active-install-audit.json)。清理后重新运行 setup 复用新版且 previous 仍为空，pilot **7 项通过**，证明不再依赖删除的旧路径。[日志](../../.runtime/dsh-upgrade-20260926/post-cleanup-pilot.log)。
- 开发站设置实际返回新版 ready；不将 readiness 当作远程模型连接证明。最终 3000 / 3001 / 3198 均健康；稳定站和截图服务 PID / revision 未变，开发站自动重启及恢复见下。[服务状态](../../.runtime/dsh-upgrade-20260926/final-service-status.log)。

## 3001 浏览器验收

在全新隔离 Edge 上访问实际 3001，最近项目和连接列表返回空测试目录，实际读取引擎设置与 Python 能力状态；无项目写入、AI 请求或设置切换。取消前后保持 engine=dsh、revision=1，未发生页面脚本错误。三个最终截图均已逐张打开查看：[机器记录](../../.runtime/dsh-upgrade-20260926/browser/report.json)。

| 页面 / 场景 | 截图 | 实际查看结论 |
| --- | --- | --- |
| Agent 执行与插件，1440×1000 | [截图](../../.runtime/dsh-upgrade-20260926/browser/settings-1440.png) | 新版 0.1.7-rc.2 与已选 DSH 清晰可读，三组工具卡可读，无页面横向溢出；底部按钮需弹窗滚动，不声称同时完整可见 |
| 同一设置页，1024×1000 | [截图](../../.runtime/dsh-upgrade-20260926/browser/settings-1024.png) | 版本与工具目录可读，无页面横向溢出，同样保留纵向滚动 |
| 点击取消后，1024×1000 | [截图](../../.runtime/dsh-upgrade-20260926/browser/cancelled-1024.png) | 设置弹窗关闭，返回空白工作区；实际接口证明引擎选择未因取消改变 |

## 旧版清理与最终启用

核验受管绝对路径、非链接目录、旧 manifest 身份、无活动任务及无旧 SDK 子进程后，将 previous 原子置空并移除：

- `.runtime/dsh-runtime-installs/0.1.6-alpha.2-301823e31ec158413acd9a00821112ade652b9191be9b8a28b07bbcacd13d375`
- `.runtime/dsh-runtime-deps`
- `.runtime/dsh-pilot-deps`

三处共删除 1,163,013,669 字节旧依赖，54,231 个文件；没有删除项目、凭据、历史会话、稳定站发布目录或 GitHub 发行物。[清理回执](../../.runtime/dsh-upgrade-20260926/cleanup.json)。活动槽位为 `0.1.7-rc.2-785071027b611bd8f8a37f531e45ce3909c5897665642a39a021fb225ba7a4f8`。

额外尝试清理本次新版候选 / 裁剪验收的临时 node_modules，被自动审批拒绝，工具仅返回 `blocked by policy`；未重试或绕过。这两处新版测试副本仍保留在 `.runtime/dsh-upgrade-20260926/`，不是可选旧版运行入口，不计入已完成的清理范围。

## 升级过程中的失败与处理

- 初次沿用旧候选锁触发 npm ERESOLVE；重新生成隔离锁，未使用 force / legacy-peer-deps，活动安装未变。
- 初轮检查发现工具错误字段移动及旧 DeepSeek protocol 被移除；调整事件断言并改接官方 Chat Completions 适配器后通过。
- 最终候选安装重命名曾遇 Windows EPERM，旧指针保留。之后校验 manifest / lock 内容身份、受管绝对路径和目录属性，再移动已安装候选并由原安装器验证激活。
- 仅修改原生 driver 导入后，3001 曾返回 carrier_import_failed。增加 CJS 原生导入闭包、依赖图修订后恢复，初次切换无需重启服务。
- 清理脚本最初以 Windows `FileShare.None` 创建安装锁，Vite 文件监听触发 EBUSY，开发服务管理器于 07:40:32 / 07:40:36 UTC 自动重启两次。此时清理检查未通过，未删除旧树。将临时清理脚本改为 CreateNew（仍拒绝并发创建）加 ReadWrite/Delete 共享后恢复；未改生产服务配置或发送手动重启命令。3000 / 截图服务未重启。恢复后原进程级引擎选择回到默认 Harness，因此通过实际 PATCH / revision 校验恢复用户原 DSH 选择，并重新完成浏览器验收。[恢复回执](../../.runtime/dsh-upgrade-20260926/engine-restoration.json)。
- PowerShell 的 File.Replace 空备份参数曾触发参数异常，指针仍保持原值；改为在验收目录保留明确的旧指针备份后完成原子替换及删除。
- 首轮便携检查指出载体完整性测试只枚举 mjs、遗漏新增 cjs，补齐两种扩展后 30 项通过。首轮浏览器脚本误拦截 Python 能力 GET，改为允许该只读接口后通过；两者均是本次验收发现并修正，未冒称一次通过。

## 边界

本批模型响应为本地回环替身，实际执行官方 SDK 和项目工具，不代表真实付费模型质量或远程 API 已验证。未发布 3000，未替换 GitHub 便携 Release，也不把旧版真实模型 / 新机验收结果算作本次通过。历史文档保留其原版本信息。
