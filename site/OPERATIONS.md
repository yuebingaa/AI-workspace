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

## 备案号展示准备

只有收到备案系统下发的真实备案编号后，才在部署环境的构建变量中设置：

```text
NEXT_PUBLIC_ICP_LICENSE=您的真实备案编号
```

该变量会公开进入浏览器页面，只能填写需要公开展示的备案编号，不能放 API Key、证件信息或其他秘密。配置有效时，首页底部中央显示备案编号并固定链接到 `https://beian.miit.gov.cn/`；未配置、包含控制字符或超过 80 字符时完全不渲染备案占位。修改后必须重新生产构建和发布才会生效。此功能只准备页面展示，不代表备案已审核通过，也不授权提交、推送、域名解析或部署；当前共享 `demo-single-user` 身份边界仍然不适合直接承载不受控公网数据。

## 可选本地持久化

默认只使用进程内存。若确需在受控本机恢复临时数据集和尚未过期的 Excel 下载，可在未跟踪的 `.env.local` 中设置：

```text
STUDIO_LOCAL_STATE_DIR=C:\absolute\private\datacanvas-state
```

目录必须是当前机器上的绝对路径，不能放入 Git 工作树、同步盘或公开共享目录。应用使用 Schema 校验、普通文件/大小预检、同目录原子替换和落盘同步写入 `datasets.json` 与 `excel-exports.json`；只有持久化成功后才提交对应的内存变更。Windows 最终原子重命名若遇到 EPERM、EACCES 或 EBUSY，会按 10/25/50 ms 最多重试 3 次（总计最多 4 次尝试）；其他平台、永久错误、权限配置错误和目标冲突不会因此被放宽。Excel 下载仍遵循 10 分钟 TTL；数据集仍遵循上传时的 TTL。损坏快照会安全回退到内存模式并让健康状态降级。

同一个持久化目录只允许一个应用实例写入。写入时会创建短暂的 `.lock` 文件，并对已加载快照做 SHA-256 版本检查，发现并发写入或较新快照时会拒绝覆盖。异常退出可能留下锁文件；必须先确认没有其他实例在运行并保留快照备份，再人工处理锁文件，不能自动删除或绕过检查。

工作台 AppSpec、EDS 派生汇总、聊天上下文、Harness 摘要和 ChangeSet 审计保存在浏览器 localStorage。页面顶部“备份”菜单可下载或恢复带格式版本与 Schema 校验的 JSON 工作区备份；恢复会先校验文件并展示内容计数，只有人工确认后才覆盖当前本地状态。备份不包含原始 EDS 工作簿、逐行明细、临时 CSV 行数据或 API Key；跨浏览器恢复后，已经过期或不属于当前服务端的临时 CSV 必须重新上传。恢复时不会自动继续中断任务或应用待确认 ChangeSet。

## 运行硬边界

下列数值是代码硬上限，不是建议值。测试或调用方注入的覆盖值只能收紧，不能放宽；反向代理也不应扩大正文或等待时长。超限请求会在进入模型、写入仓库或生成下载前拒绝。

- CSV 上传：单文件 10 MiB、50,000 行、100 列、单元格 20,000 字符，最多保留 10 个数据集，默认 30 分钟到期。上传/读取返回体最多 32 MiB，浏览器会在下载过程中终止超限响应；服务端在确认响应可序列化且未超限后才提交数据集。
- Excel 配方导出：10,000 行、100 列、单元格 32,000 字符、文件 10 MiB、生成 8 秒；最多保留 20 个下载，10 分钟到期。下载令牌在 TTL 内允许同一所有者重复读取，以便网络中断后重试；撤销、淘汰或到期后立即返回 404。EDS 仍使用独立的输入与模板边界。
- EDS XLSX：单文件 10 MiB、两文件合计 20 MiB，multipart 读取最多额外容纳 1 MiB 协议开销且 15 秒超时；ZIP 最多 1,000 个条目、单条目展开 32 MiB、总展开 64 MiB；工作簿最多 10 张表，每表 50,000 行、100 列、500,000 个显式单元格，单元格文本 20,000 字符，共享字符串 500,000 条、样式与数字格式合计 100,000 条。服务端同时只执行 1 个 EDS 请求，单个工作簿解析 15 秒，最多返回 20 个共同日期/班次选择项，成功 JSON 按 UTF-8 序列化后最多 512 KiB；导出仍受 10 MiB、20 个工件和 10 分钟 TTL 限制。反向代理不能放宽这些值。
- 本地状态：工作台浏览器备份最多 5 MiB；`datasets.json` 和 `excel-exports.json` 读取上限分别为 128 MiB 和 256 MiB，且 Schema 条目数仍受上述数据集/下载容量约束。文件过大、Schema 不合法、锁冲突或版本变化都会失败关闭，不会截断后继续加载。
- AI Planner：请求正文与下发给 DeepSeek 的上下文分别最多 180,000 字节和 90,000 字节；客户端等待最多 30 秒、响应最多 1 MiB；服务端单次 DeepSeek 等待最多 20 秒、响应最多 512 KiB；首次请求与一次结构修复合计最多 12,000 prompt tokens 和 3,000 completion tokens。provider 必须返回完整、相加一致且未超限的 usage，否则按上游协议错误拒绝结果。
- Harness：普通 JSON 请求正文最多 180,000 字节、指令最多 1,000 字符；用户显式授权原始 EDS 行访问后，相关提问改用 multipart，除 JSON payload 外最多附带一个 10 MiB XLSX 和 1 MiB 协议开销。最多 8 轮、6 次模型调用（含 1 次语义路由）、6 次工具调用，模型/工具单次分别最多 25/10 秒，总主动执行时间最多 180 秒，浏览器等待最多 95 秒；模型单次 completion 最多 2,000 tokens，provider 单次 prompt 最多 12,000 tokens，模型响应最多 512 KiB，浏览器 Harness 响应最多 4 MiB。多步上下文最多 10,000 请求字符、4,000 工具结果字符、16 条工具结果、32,000 累计输入字符和 8,000 估算 prompt tokens。
- DeepSeek Live：固定三用例 manifest 不可替换；每个用例先进行一次结构化语义路由，整轮最多 10 次模型调用、15,000 prompt tokens、4,000 completion tokens、180 秒主动调用时间、0 次自动重试；单 HTTP 请求最多 120 秒、响应最多 4 MiB。模型名和 provider usage 都必须与可信配置一致。

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
- EDS 多日期或多班次：普通分析会返回两张原始明细表共有的可分析范围，页面要求用户选择单个范围，或选择“分别生成全部报告”后顺序生成独立 Excel。批量结果生成主看板时会同时保存最多 20 份派生汇总，并在画布顶部按日期/班次切换；数据源和 AI 工作区保留全部汇总，KPI、图表与表格只过滤显示当前选中范围，不能跨班次误相加。高级验收模式只能选择单个范围，因为一份目标模板只能对应一个日期和班次。原始文件默认不进入 AI；只有用户勾选“允许 AI 完整扫描原始数据”且提出相关问题时，浏览器才把文件附在该次请求中。文件只在请求内存中解析，不写入 localStorage、工作区备份或审计正文；模型回答中引用的单元格会按普通聊天记录规则保留。
- EDS AI 分析：主看板“AI 分析全部班次”会调用常规受控 DeepSeek Harness，并优先执行只读 `analyzeEdsReports` 工具。派生汇总任务只向模型提供已校验的日期/班次 KPI、相对首份报告的差异、主要线体与主要异常类别，不包含原始工作簿、逐行记录、文件名或下载令牌。显式授权后的原始数据任务按 `scanEdsRawWorkbook` → `queryEdsRawWorkbook` 顺序执行：前者完整扫描所有工作表和数据行并建立字段概况，后者对全部匹配行执行受控筛选、分组、计数、求和、平均值、最值或去重计数，只向模型返回最多 30 条聚合/原始证据。文件 SHA-256 作为数据版本，相同内容的解析结果与扫描索引在暖服务实例内最多保留 4 份、30 分钟滑动过期，不写磁盘或外部存储；结果包含工作表与行号，单元格内容始终按不可信数据处理。服务端必须配置 `DEEPSEEK_API_KEY` 与 `DEEPSEEK_MODEL`，缺失时明确返回“AI 服务尚未配置”，不得伪造 AI 结论或退化为固定文案。
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

若要同时验收“生成 EDS 分析看板”，在默认单文件模式增加以下开关。脚本会点击结果页的生成动作，核对主画布 4 个 KPI、2 张图和 24 条汇总，检查 localStorage v5 与审计正文只包含派生汇总，刷新页面后再次确认看板和 AI 数据上下文恢复；原始文件名、下载令牌、来源工作表和逐行明细不得进入本地快照：

```powershell
$env:EDS_BROWSER_MODE='standard'
$env:EDS_BROWSER_CREATE_WORKSPACE='1'
$env:EDS_REAL_SOURCE_PATH='C:\absolute\private\EDS\input.xlsx'
$env:EDS_BROWSER_EVIDENCE_DIR='C:\absolute\private\evidence\new-workspace-directory'
corepack pnpm test:eds:browser
```

脚本只接受 HTTP 回环服务/CDP 地址，默认分别为 `127.0.0.1:3102` 和 `127.0.0.1:9223`。若显式设置 `EDS_BROWSER_BASE_URL` 或 `EDS_BROWSER_CDP_URL`，仍必须使用回环 HTTP；目标列表只能包含一个 `about:blank` 页面，返回的 `ws:` 调试地址也必须是回环地址并使用配置的 CDP 端口。脚本在设置真实文件前再次确认最终页面与配置基址同源，下载地址同样必须同源且不能含用户名或密码。

同一个隔离 Edge 与本地生产服务也可运行工作区备份/恢复浏览器闭环；该脚本会清空隔离配置中的 localStorage，创建一轮不调用模型的本地对话，下载 JSON，清空上下文，再从刚下载的文件确认恢复：

```powershell
corepack pnpm test:backup:browser
```

脚本使用自动创建的独立临时下载目录并在结束时清理；它会检查页面与 localStorage 恢复为同一轮对话、没有未完成 Harness 任务自动续跑、没有 `/api/ai/harness` 请求，并拒绝在备份中发现疑似 API Key、固定验收工作簿名或下载令牌。该验收必须使用独立浏览器配置，不能在用户日常浏览器中运行，因为它会主动清空当前 origin 的 localStorage。

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
