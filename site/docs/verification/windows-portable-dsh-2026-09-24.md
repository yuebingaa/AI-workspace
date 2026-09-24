# Windows 完整 DSH 便携包交付记录（2026-09-24）

## 范围与当前状态

Windows x64 / Node 24 完整网站运行包，包含受控 DSH、Notebook Python / SQL 和离线浏览器资源。最终受控 profile 已通过实际解压及收费模型闭环验收；GitHub 上传状态见文末。源码默认执行器、3000 稳定站与 3001 受管进程不切换、不重启。

## 实际修改

- `runtime/dsh/installation.mjs`：固定短目录 bundled 安装选择，复用原版本、身份、补丁和路径保护。
- `core/agent-engines/server/selection.ts`：进程首次启动可读取显式服务端默认引擎；普通部署仍默认 Harness，运行中切换和租约不变。
- `portable/windows/launcher*.mjs`：检查完整资源并使用随包 DSH / 浏览器；可选父进程 IPC 仅供验收停止自有子进程，不新增 HTTP 控制接口。
- `scripts/build-portable-windows.mjs`、`portable-build-utils.mjs`：固定浏览器版本及 EXE 摘要、Python 全资源摘要、Node 版本、生产载体白名单与许可证清单；不复制本机全部运行目录。
- `scripts/package-portable-windows.mjs`：逐文件流式标准 ZIP，安全名称 / 目录属性 / UTF-8，不覆盖既有输出。实测完整 SDK 最长路径 199 字符，上限有界调整为 210；总原始体积上限 1.5 GiB、ZIP 小于 2 GiB，不用 ZIP64。
- `scripts/verify-portable-windows.mjs`：隔离 Windows-only PATH、本机项目 / 浏览器、真实 UI 与可选一次收费任务；只结束自身创建的便携进程，不调用受管服务停止命令。

## 依赖分发边界

DSH 为 `controlled-notebook-v1`，只精确省略 `@deepseek-ai/libreoffice-kit`、`@deepseek-ai/libreoffice-kit-win32-x64`、`sharp`、`@img/sharp-win32-x64`。这四项负责网站未开放的 Office 转换 / DSH 原生附件图片处理；受控 SDK 的 410 模块加载分析未引用这些模块，网站独立构建也没有 Sharp 依赖。LibreOffice wrapper 的仓库公开不可获取对应源码，Sharp 原生多库源码分发亦未在本任务落实，因此采取不分发未用能力的保守方案，不虚构 source offer。普通本机安装、原 manifest / lock、全部其他依赖不变，bundle 专用验证要求严格 profile 和四包实际缺席。

这是网站功能完整的运行包，不是可任意启用全部官方插件的 DSH CLI 包。原 MIT / BSD 等许可文件保留，额外携带匹配 Node / Chromium / Playwright / CPython 许可证和 Pyodide 对应源码、构建定义链接。不是法律合规认证或逐文件代码签名。

## 验证与限制

已执行：`npm run typecheck`、`npm run build`、`npm test -- --maxWorkers=2` 退出 0；全量离线测试的 26 项 Node 工具检查通过，原有 3 项真实 EDS 条件测试跳过。构建仍有原大 chunk 提醒。`npm run test:portable` 最新 30 项通过；安装 / SDK 另外 44 项、相关严格 ESLint、架构指纹和差异检查通过。

候选二通过 Windows .NET 解压到新建中文 / 空格短目录，使用包内 Node，子进程 PATH 只有 Windows 系统目录、无继承凭据或 NODE_OPTIONS。默认 DSH 可用、首次无密钥页面、实际 CSV → Python 倍增 → DuckDB 汇总 → 图表得到 East 300 / South 160、本地项目保存重开均通过。实际观察到网站进程启动包内 Headless Shell。此候选仍为最初未裁剪私有 SDK 树，不作为公开发行物；最终四包省略版本的独立重新验收结果见下节。

如实保留已修复失败：候选一组装模板时误用不覆盖目录复制，改为先预检再逐项复制并新增回归；候选二首次 UI 验收未先运行 SQL 就新建图表，属于测试顺序错误；第二次计算已正确但进程采样遗漏，测试合成代码显式增加两秒观察窗口后第三次完整通过，不修改产品计算或弱化结果断言。三个隔离现场保留，尚无模型费用。

无付费最终证据位于本机忽略目录 `site/.runtime/portable-release-20260924/acceptance-candidate2c/`：报告和三张实际截图（无密钥、Python/SQL 图表、保存重开）已查看。本批没有站点 UI 改动；截图来自独立便携站 3210，不冒充 3001 截图或发布到 3000。

## 最终受控包验收与校验

- 从提交 `973416a705d9ca38070bde819b465246a32e02b4` 清洁已跟踪源码重新构建、组装和压缩，未运行的发行目录与解压测试目录完全分离。
- `AC-Win64.zip`：262336286 字节；解压后 717558500 字节、27654 文件、3510 目录、最长归档路径 199 字符。SHA-256：`5972530c41ea55529f2bd596738c858a228292d4d54203bdbd1ac96c44e0bc66`。
- Windows .NET 将最终 ZIP 解压到新的中文/空格短目录；完整验收仍只允许 Windows 系统 PATH，包内 Node 24.19.0、DSH 0.1.6-alpha.2 和 Chromium 151.0.7922.34，启动没有模型凭据。
- 本批唯一收费任务使用 `deepseek-flash`：7 次模型调用、8 次工具调用，得到 `awaitingConfirmation` 的 5 单元草稿。未采用前正式 Notebook 不变，明确采用后重新实际运行，表格与图表输出 East 300 / South 160；保存重开保留五个定义和本轮对话，未自动再调用模型。费用金额 / 服务商 token 账单未独立读取，不把调用次数当作金额。
- 合成数据的 Python、SQL、图表和模型新建表格全部实际执行；三次观察到包内浏览器子进程。没有伪造业务响应或重放模型回执，无自动收费重试，页面错误 / 违规网络请求为 0。测试退出时仅关闭自身便携进程。
- 六张最终截图均由主代理逐张实际打开查看，覆盖缺密钥、图表结果、真实 DSH 完成、待采用、采用后表格及重开。私有证据：`site/.runtime/portable-release-20260924/acceptance-final-paid/`，其中 `report.json`、`synthetic-paid-task.json` 和 `01`–`06` 截图不上传。
- 独立最终目录审计：profile/身份/SDK 真实导入、Node/DSH/browser 指纹与 13 个 Python 资源摘要通过；全树四包实际缺席，无私有案例、data、会话或 .env。187 个自家脚本/清单/构建文本无本机路径；文本扫描仅 jose 的 PEM 解析字符串误报，无实际密钥。542 包 / 535 许可文件索引与实际一致。审计证据：`site/.runtime/portable-release-20260924/final-package-audit.json`。

## 发布与保留事项

已发布 [GitHub Windows 预览 Release](https://github.com/yuebingaa/AI-workspace/releases/tag/v0.1.0-windows-preview.20260924)：`isDraft=false`、`isPrerelease=true`，ZIP、`SHA256SUMS.txt` 和 `README-Windows.txt` 均为 `uploaded`。GitHub 返回的 ZIP 大小和 SHA-256 与上述本地发行物完全一致；匿名下载地址 HEAD 为 HTTP 200，长度 262336286 字节。没有把远端摘要核验描述为重新下载全包。

实际收费验收的解压副本亦已单独核对 Node、browser、DSH 及全部 Python 资源摘要，与未运行的发行目录一致；未扫描解压副本新建的数据或会话。证据为上述审计文件的 `zipExtractionIntegrity=passed`。

Release 标签与构建源码均固定为 `973416a705d9ca38070bde819b465246a32e02b4`；实现已推送 `feature/eds-analysis-dashboard`，最终验收记录另作仅文档提交，不重打包已验收附件。远端 main 仍为 `134d543780a4b5df22870b92fe3c6194c6772c0a`，未合并、未强推；3000 / 3001 / 3198 最终健康，PID、版本与重启计数保持不变。

目标电脑无需全局 Node/npm，但在线模型仍需自己的密钥与网络。完整包不能代替远程数据库服务；不携带用户数据、模型密钥或本机历史会话。DSH 为固定 alpha SDK。未做另一台实体电脑、Windows 10、特定 360 解压器、外部数据库、取消中的强制关窗口或任意插件测试。无代码签名，不能建议关闭安全软件。两份原有私有案例仍留本地未跟踪，未进入提交/压缩包；失败候选和隔离验证现场保留，不覆盖或删除用户数据。
