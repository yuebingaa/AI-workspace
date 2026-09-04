# DataCanvas AI 本地与内网运行说明

## 安全定位

本应用仅用于本地或受控公司内网的非敏感数据。当前身份模式仍是共享的 `demo-single-user`，不得开放到公网，不得用于正式个人信息、商业敏感数据或受监管数据。

## 启动与停止

要求 Node.js 22.13 或更高版本。首次在当前工作树运行：

```powershell
corepack pnpm install --frozen-lockfile
corepack pnpm dev
```

生产构建验证使用 `corepack pnpm build`。本项目没有获准部署；构建成功不代表允许发布。

前台运行时按 `Ctrl+C` 停止。停止后确认进程已退出，再检查 `GET /api/health` 不再可访问。禁止以明文命令行参数传入 API 密钥。

## 可选本地持久化

默认只使用进程内存。若确需在受控本机恢复临时数据集和尚未过期的 Excel 下载，可在未跟踪的 `.env.local` 中设置：

```text
STUDIO_LOCAL_STATE_DIR=C:\absolute\private\datacanvas-state
```

目录必须是当前机器上的绝对路径，不能放入 Git 工作树、同步盘或公开共享目录。应用使用 Schema 校验、普通文件/大小预检、同目录原子替换和落盘同步写入 `datasets.json` 与 `excel-exports.json`；只有持久化成功后才提交对应的内存变更。Windows 最终原子重命名若遇到 EPERM、EACCES 或 EBUSY，会按 10/25/50 ms 最多重试 3 次（总计最多 4 次尝试）；其他平台、永久错误、权限配置错误和目标冲突不会因此被放宽。Excel 下载仍遵循 10 分钟 TTL；数据集仍遵循上传时的 TTL。损坏快照会安全回退到内存模式并让健康状态降级。

同一个持久化目录只允许一个应用实例写入。写入时会创建短暂的 `.lock` 文件，并对已加载快照做 SHA-256 版本检查，发现并发写入或较新快照时会拒绝覆盖。异常退出可能留下锁文件；必须先确认没有其他实例在运行并保留快照备份，再人工处理锁文件，不能自动删除或绕过检查。

工作台 AppSpec、Harness 摘要和 ChangeSet 审计保存在浏览器 localStorage；代码提供带版本校验的备份/恢复函数，恢复时不会自动继续中断任务或应用待确认 ChangeSet。

## 运行硬边界

下列数值是代码硬上限，不是建议值。测试或调用方注入的覆盖值只能收紧，不能放宽；反向代理也不应扩大正文或等待时长。超限请求会在进入模型、写入仓库或生成下载前拒绝。

- CSV 上传：单文件 10 MiB、50,000 行、100 列、单元格 20,000 字符，最多保留 10 个数据集，默认 30 分钟到期。上传/读取返回体最多 32 MiB，浏览器会在下载过程中终止超限响应；服务端在确认响应可序列化且未超限后才提交数据集。
- Excel 配方导出：10,000 行、100 列、单元格 32,000 字符、文件 10 MiB、生成 8 秒；最多保留 20 个下载，10 分钟到期。下载令牌在 TTL 内允许同一所有者重复读取，以便网络中断后重试；撤销、淘汰或到期后立即返回 404。EDS 仍使用独立的输入与模板边界。
- EDS XLSX：单文件 10 MiB、两文件合计 20 MiB，multipart 读取最多额外容纳 1 MiB 协议开销且 15 秒超时；ZIP 最多 1,000 个条目、单条目展开 32 MiB、总展开 64 MiB；工作簿最多 10 张表，每表 50,000 行、100 列、500,000 个显式单元格，单元格文本 20,000 字符，共享字符串 500,000 条、样式与数字格式合计 100,000 条。服务端同时只执行 1 个 EDS 请求，单个工作簿解析 15 秒，成功 JSON 按 UTF-8 序列化后最多 512 KiB；导出仍受 10 MiB、20 个工件和 10 分钟 TTL 限制。反向代理不能放宽这些值。
- 本地状态：工作台浏览器备份最多 5 MiB；`datasets.json` 和 `excel-exports.json` 读取上限分别为 128 MiB 和 256 MiB，且 Schema 条目数仍受上述数据集/下载容量约束。文件过大、Schema 不合法、锁冲突或版本变化都会失败关闭，不会截断后继续加载。
- AI Planner：请求正文与下发给 DeepSeek 的上下文分别最多 180,000 字节和 90,000 字节；客户端等待最多 30 秒、响应最多 1 MiB；服务端单次 DeepSeek 等待最多 20 秒、响应最多 512 KiB；首次请求与一次结构修复合计最多 12,000 prompt tokens 和 3,000 completion tokens。provider 必须返回完整、相加一致且未超限的 usage，否则按上游协议错误拒绝结果。
- Harness：请求正文最多 180,000 字节、指令最多 1,000 字符；最多 8 轮、5 次模型调用、6 次工具调用，模型/工具单次分别最多 25/10 秒，总主动执行时间最多 180 秒，浏览器等待最多 95 秒；模型单次 completion 最多 2,000 tokens，provider 单次 prompt 最多 12,000 tokens，模型响应最多 512 KiB，浏览器 Harness 响应最多 4 MiB。多步上下文最多 10,000 请求字符、4,000 工具结果字符、16 条工具结果、32,000 累计输入字符和 8,000 估算 prompt tokens。
- DeepSeek Live：固定三用例 manifest 不可替换；整轮最多 7 次模型调用、12,000 prompt tokens、3,000 completion tokens、180 秒主动调用时间、0 次自动重试；单 HTTP 请求最多 120 秒、响应最多 4 MiB。模型名和 provider usage 都必须与可信配置一致。

正文大小均按 UTF-8 实际字节或流式读取计数，不能依赖 `Content-Length` 绕过。客户端取消和超时会中止正文读取；服务端在仍可控制时会把取消信号继续传给模型或工具执行。

## 健康检查

请求：

```powershell
Invoke-RestMethod http://127.0.0.1:3000/api/health
```

检查 `status`、`persistence.configured`、`startupErrors`、`runtimeErrors`、数据集/Excel 下载容量及 `warnings`。响应不会返回持久化目录、底层异常、密钥或文件内容。容量达到 80% 或运行期写入失败会出现告警；后者会返回 `degraded`，相关业务变更已回滚，下一次成功写入后恢复为 `ok`。

## 日志与故障排查

- 日志只记录阶段、错误代码、行列数、耗时和脱敏摘要；不得记录 Authorization、API 密钥、nonce、原始数据行、完整工作簿路径或 ChangeSet 正文。
- 记录未知错误前先调用 `redactOperationalText()`；该函数会遮蔽 Bearer、常见密钥赋值和用户本地路径。
- XLSX 解析失败：确认扩展名为 `.xlsx`、单文件不超过 10 MiB、合计不超过 20 MiB，并确认输入含两张具备六个必需字段的明细表、模板含 14×20 映射。服务端会流式限制 multipart 总体积、检查 XLSX 解压后体积并限制读取/解析时长；不要通过代理关闭这些边界。
- EDS 数值不一致：先查看返回的首批差异单元格，再核对模板日期、班次、Line、Instance 与完整异常名称；不得修改目标表制造通过。
- EDS 目标模板中的公式不会由服务端重新计算；读取的是 XLSX 内已保存的公式缓存值。上传前应在受信任的 Excel 环境完成重算并保存；缺失、错误或过期缓存会表现为对应单元格差异，不能把零差异解释为服务执行过公式。
- 持久化降级：检查配置目录是否存在写权限、快照是否损坏或是否有并发实例；保留原快照后使用已验证备份恢复，不能跳过 Schema、写锁或版本检查。
- DeepSeek Live 只允许经独立双门禁 Runner 执行；普通启动、测试、EDS 确定性分析均不会调用真实模型。预算耗尽、usage 缺失/不一致或模型标识不一致时不得把结果计为成功，也不得自动重试。

## 验证命令

```powershell
corepack pnpm test
corepack pnpm test:eval
corepack pnpm test:eds:browser:unit
corepack pnpm exec tsc --noEmit --incremental false
corepack pnpm lint
corepack pnpm build
corepack pnpm audit --prod
```

真实 EDS 原始材料验收不会混入普通离线测试。先以只读路径显式设置输入与目标模板，再运行专用命令；缺少任一路径时命令会失败，不能以“跳过”冒充验收成功：

```powershell
$env:EDS_REAL_SOURCE_PATH='C:\absolute\private\EDS\input.xlsx'
$env:EDS_REAL_TEMPLATE_PATH='C:\absolute\private\EDS\output.xlsx'
corepack pnpm test:eds:real
```

该验收覆盖原始工作簿解析、确定性分析、multipart API、Excel 下载以及下载产物重新读取比对。它只读取原件，不会改写输入或目标模板。

生产网页的 EDS 验收使用显式浏览器命令，不混入普通测试。先构建并在一个终端启动本机生产服务：

```powershell
corepack pnpm build
corepack pnpm start -- --port 3102
```

再用本次任务独占、可删除且此前不存在的浏览器配置启动 Edge DevTools；可见窗口不是验收所需，必须隐藏运行。必须以唯一 `about:blank` 页面启动，验收结束前不能在该调试实例中新开其他页面，也不能复用日常浏览器配置：

```powershell
$edsBrowserProfile = Join-Path $env:TEMP 'datacanvas-eds-browser-acceptance'
New-Item -ItemType Directory -Path $edsBrowserProfile -ErrorAction Stop | Out-Null
Start-Process -FilePath 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe' -ArgumentList @('--headless=new','--remote-debugging-port=9223',('--user-data-dir=' + $edsBrowserProfile),'--no-first-run','--no-default-browser-check','--disable-gpu','about:blank') -WindowStyle Hidden
```

最后在第三个终端显式设置固定输入原件和一个尚不存在的证据目录后运行默认单文件业务验收：

```powershell
$env:EDS_REAL_SOURCE_PATH='C:\absolute\private\EDS\input.xlsx'
$env:EDS_BROWSER_EVIDENCE_DIR='C:\absolute\private\evidence\new-run-directory'
corepack pnpm test:eds:browser
```

默认模式会确认页面只有一个文件选择器、未显示验收基准上传项、模板/规则版本可见，并只上传 `input.xlsx` 完成分析、图表与下载。若需执行内部 560/560、660/660 网页验收，显式进入高级模式；脚本会先点击页面的“高级验收”，再上传锁定基准，基准只参与结果核对，不改变内置规则：

```powershell
$env:EDS_BROWSER_MODE='acceptance'
$env:EDS_REAL_SOURCE_PATH='C:\absolute\private\EDS\input.xlsx'
$env:EDS_REAL_TEMPLATE_PATH='C:\absolute\private\EDS\output.xlsx'
$env:EDS_BROWSER_EVIDENCE_DIR='C:\absolute\private\evidence\new-acceptance-directory'
corepack pnpm test:eds:browser
```

若要同时验收“生成 EDS 演示看板”，在默认单文件模式增加以下开关。脚本会点击结果页的生成动作，核对主画布 4 个 KPI、2 张图和 24 条汇总，检查 localStorage v3 与审计正文只包含派生汇总，刷新页面后再次确认看板和 AI 数据上下文恢复；原始文件名、下载令牌、来源工作表和逐行明细不得进入本地快照：

```powershell
$env:EDS_BROWSER_MODE='standard'
$env:EDS_BROWSER_CREATE_WORKSPACE='1'
$env:EDS_REAL_SOURCE_PATH='C:\absolute\private\EDS\input.xlsx'
$env:EDS_BROWSER_EVIDENCE_DIR='C:\absolute\private\evidence\new-workspace-directory'
corepack pnpm test:eds:browser
```

脚本只接受 HTTP 回环服务/CDP 地址，默认分别为 `127.0.0.1:3102` 和 `127.0.0.1:9223`。若显式设置 `EDS_BROWSER_BASE_URL` 或 `EDS_BROWSER_CDP_URL`，仍必须使用回环 HTTP；目标列表只能包含一个 `about:blank` 页面，返回的 `ws:` 调试地址也必须是回环地址并使用配置的 CDP 端口。脚本在设置真实文件前再次确认最终页面与配置基址同源，下载地址同样必须同源且不能含用户名或密码。

CDP 目标列表最多读取 1 MiB 且等待最多 5 秒；WebSocket 连接最多 5 秒，每条 CDP 命令最多 10 秒，畸形 JSON 帧会立即关闭连接；网页下载最多等待 15 秒，并按流同时限制声明大小和实际大小为 16 MiB，同时核对 `Content-Length`。这些是验收工具自身的失败关闭边界，不会放宽应用的 EDS/Excel 服务端上限。

使用到的固定原件必须匹配 SHA-256；默认模式只读取输入原件，高级验收模式才读取目标原件。证据目录必须是绝对路径且不能已存在。成功证据先写入同父目录的临时目录，只有 JSON、PNG、XLSX 三件全部完成后才原子发布最终目录；Windows 最终重命名对 EPERM、EACCES、EBUSY 同样只按 10/25/50 ms 最多重试 3 次，EEXIST 等冲突或重试耗尽仍会失败并清理临时目录，最终目录不会以半成品形式出现。JSON 只记录输入文件名、相对工件名、大小与 SHA-256，不记录本机绝对文件路径。普通模式成功覆盖默认单文件状态、版本追溯、网页上传、分析、KPI、两类图表、下载、重新选择、关闭回焦和重开聚焦；工作区模式改为覆盖主界面生成、派生汇总边界、审计与刷新恢复，不伪报未执行的重置或回焦步骤。

脚本不会启动、停止或批准外部进程；无论成功失败，都要由操作者只停止本次生产服务和使用上述独立配置启动的 Edge。确认没有进程使用并验证配置目录确属本次任务后，才能删除该独立浏览器配置，不能按模糊进程名停止其他 Edge，也不能按宽泛路径递归清理。

浏览器命令会在写入通过证据前独立重新解析网页下载链接返回的工作簿并比对 560/560、660/660。也可以对已有浏览器下载单独复核，不会增加普通测试的条件跳过项：

```powershell
$env:EDS_REAL_SOURCE_PATH='C:\absolute\private\EDS\input.xlsx'
$env:EDS_BROWSER_DOWNLOADED_PATH='C:\absolute\private\evidence\EDS-browser-result.xlsx'
corepack pnpm test:eds:download
```

真实 Live 评测必须另行确认密钥已注入当前授权环境，并继续遵守累计预算与零自动重试约束。
