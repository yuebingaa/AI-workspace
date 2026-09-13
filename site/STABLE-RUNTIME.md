# 本机稳定运行

日常使用 `http://127.0.0.1:3000`，修改代码时查看 `http://127.0.0.1:3001`。
稳定版从工作区外的独立发布目录运行。保存源码、开发热更新、构建失败、关闭启动终端，都不会覆盖稳定版。

| 服务 | 地址 | 运行内容 |
| --- | --- | --- |
| 稳定站 | http://127.0.0.1:3000 | 最近一次验收通过的独立生产构建 |
| 开发站 | http://127.0.0.1:3001 | 当前 `site` 源码，支持热更新 |
| 截图服务 | http://127.0.0.1:3198/health | 独立进程，异常不会连带停止网站 |

这些端口只绑定本机 IPv4 回环地址。端口被其他进程占用时，管理器报告 `port-conflict`，不自动杀进程，也不悄悄换端口。请统一使用上述地址：`localhost` 和 `127.0.0.1` 的浏览器 localStorage 不共享；3000 和 3001 也分别保存工作区。原地址上的工作区可用页面“备份”导出，再到新地址恢复。

## 日常命令

在 `site` 目录用 CMD 或 PowerShell 执行：

```text
npm run site:status
npm run site:logs
npm run site:logs -- stable
npm run site:start -- dev
npm run site:stop -- dev
npm run site:restart -- stable
npm run site:publish
npm run site:rollback
```

`start / stop / restart` 省略目标时处理全部服务；也可指定 `stable / dev / capture`。手动停止会保存停用状态，守护程序不会擅自重启被停用的服务。管理命令有独占锁，两个发布或启停命令不能同时执行。命令进程退出后锁由操作系统释放。

不要再同时在 3000/3001 上另开 `npm run dev`。旧的前台开发脚本也已改为分别恢复网站和截图进程，但长期运行使用上述后台管理命令。

## 首次安装和更新管理器

```text
npm run site:install
npm run site:publish
npm run site:start -- dev
```

安装会复制 Node、守护脚本及当前 `.env` / `.env.local` 到用户私有运行目录，并注册 `AgentCanvas-<工作区标识>` 计划任务。重复安装不会覆盖运行配置、密钥、数据或现有发布版本。

修改 `scripts/runtime` 中的守护代码后，用以下命令显式更新后台管理器；它会短暂停止并恢复之前启用的服务：

```text
npm run site:update-manager
```

Windows 使用 `AgentCanvasHost.exe` 无控制台宿主启动 Node，当前用户登录后自动运行。宿主编译为 Windows GUI 子系统程序（不会显示界面），以 `UseShellExecute=false`、`CreateNoWindow=true` 和重定向标准流启动 Node；不再通过 `powershell.exe -WindowStyle Hidden` 启动计划任务，避免 Windows Terminal 闪窗。

主任务 `AgentCanvas-<标识>` 常驻运行，只设置登录触发和失败重试，不设置每分钟重复触发。配套的 `AgentCanvas-<标识>-watchdog` 每分钟运行一次无控制台 `AgentCanvasWatchdog.exe`：通过 Windows 任务调度 COM 接口检查主任务，运行中/已排队时成功退出，已停止时请求启动，管理员明确禁用时不擅自启用。这避免对常驻任务重复触发产生 `0x800710E0` 拒绝请求记录。两者均使用 `IgnoreNew`，另有宿主互斥锁和守护进程独占管道防止双开；发现已运行的合法实例正常跳过。主任务没有默认 72 小时运行时限，短时检测任务上限为 30 秒。

安装和更新使用本机 Windows .NET Framework 的 C# 编译器生成宿主，不需要下载编译器。`site:update-manager` 在停止服务前先编译并检查 GUI 子系统，编译失败不会中断网站。旧任务 XML 和管理脚本保存在 `manager-updates/<更新标识>/previous`；任务注册/文件替换异常会尝试恢复旧配置。更新只替换后台管理器，不发布网站新版本，也不清除网站数据。

关闭 Codex、Orca 或普通终端不需要停止计划任务。机器关机、睡眠期间网站不可访问；当前用户注销后也不保证继续运行，登录后自动恢复。本方案没有修改电源策略，也没有将网站开放到公网。

## 发布与回退

`site:publish` 复制当前源码到唯一构建目录（含未提交的代码，排除 `.env*`、数据、缓存和构建产物），使用当前已安装的锁定依赖构建。仅构建目录使用依赖联接，最终发布目录复制运行依赖，不依赖源码目录的 `node_modules`。

候选版本在临时回环端口和独立数据目录启动，验证健康状态、持久化初始化、首页及静态资源。通过后停止旧稳定实例、备份稳定数据并切换新版本；启动失败时恢复旧版本选择。构建或候选检查失败不会停止当前稳定站。

正式切换有一次短暂重启，不是零中断发布。数据文件只支持单实例写入，所以不能让新旧版本同时写稳定数据。在途请求可能被中断，发布前宜完成当前操作。发布命令意外中断时，守护程序在切换事务的 150 秒期限后恢复原版本选择。

`site:rollback` 先验收上一版，再切换；切换后原来的当前版成为“上一版”，可再次回退返回。发布版本、源码快照和数据备份都保留，未实现自动清理。日志单文件约 5 MiB 轮转，保留 5 份历史。

回退程序不会自动覆盖数据或删除数据锁。若未来修改了数据格式，必须另外验证兼容性；目录中的备份可用于人工恢复。

## 数据和配置位置

`npm run site:status` 会显示完整运行目录。当前工作区记录在 `.runtime/runtime-location.json`；默认位于 `%LOCALAPPDATA%\AgentCanvas\site-<工作区标识>`。

```text
运行目录/
  runtime/node.exe
  bin/                       已安装的后台脚本
  config/.env、.env.local     稳定站的私有配置副本
  config.json、desired.json   服务配置和启停状态
  status.json                进程 PID、版本、健康、重启次数
  releases/<版本>/app/        独立运行产物
  builds/<版本>/             源码与构建快照
  state/stable/              稳定站服务端数据
  state/dev/                 开发站服务端数据
  state/checks/              候选验收数据
  state/backups/             每次切换前的数据备份
  logs/                      脱敏后的服务日志
    launcher.log             无控制台宿主启动、退出码及捕获的错误输出
    watchdog.log             短时定时检测任务的实际失败记录（成功不刷日志）
  manager-updates/            管理器更新产物、更新前状态与旧任务/脚本备份
```

稳定站配置从 `运行目录/config` 读取；编辑配置副本后服务会重启加载。开发站叠加源码中的 `.env` / `.env.local`，并固定为独立数据目录。受管开发站使用本机 Node 适配器，避免 Cloudflare 模拟器的虚拟文件系统导致本机持久化失效；Cloudflare 构建仍使用原有适配器。

临时 CSV 和 Excel 导出的原有 TTL 不变，持久化不等于永久保存。浏览器工作区仍使用 localStorage，需要自行导出备份。通过界面临时设置的 API Key 仍在服务内存中，重启后需重新设置；如需跨重启保留，使用私有配置文件。发布产物不会包含 `.env` 文件。

源码新增的“本地项目 / Data Browser”模式是独立选项，需发布后稳定站才具备：用户选择的项目文件夹保存原始 CSV/XLSX、有类型数据表、语义模型、Notebook 和看板定义，项目数据没有临时 TTL。私有运行目录中的 `local-projects.json` 只登记最近项目；完整数据备份应复制整个项目文件夹，不是只导出浏览器 JSON。API Key 不随项目迁移。详见 [本地项目使用说明](docs/local-projects.md)。

## 验证与排查

```text
npm run test:runtime
node scripts/runtime/browser-check.mjs
npm run site:logs -- launcher
npm run site:logs -- watchdog
```

自动化测试使用独立临时目录和端口，覆盖服务故障隔离、自动恢复、数据保留、重复启动正常跳过、陌生管道拒绝、降级状态不反复重启、发布中断恢复及手动停用。Windows 测试还会编译无控制台宿主与控制台探针，验证子进程 `GetConsoleWindow()` 为零、互斥保护、日志脱敏和非零退出码保留；使用唯一临时计划任务验证检测器的禁用保护、拉起及重复跳过，测试结束删除自己的临时任务和文件。不启动或停止实际网站。浏览器检查使用隔离的无头 Edge，阻断 AI 请求，证据写到 `.runtime/runtime-browser-verification.json` 和页面 PNG。

主任务正常常驻时状态为 `Running`，`LastTaskResult=267009`（`0x41301`，仍在运行），不是错误；检测任务完成后状态为 `Ready`，正常退出码为 `0`。排查启动失败先看 `launcher.log` 和 `watchdog.log`；不要把启动器异常误判为稳定站已中断，也不要通过关闭保活任务掩盖弹窗。

网站进程退出后按 1、2、5、10、30 秒退避重启；监测周期会带来额外延迟。正常运行超过一分钟后恢复初始退避。健康检查每 10 秒一次，稳定站有 60 秒启动宽限、开发站 180 秒；连续三次检查失败后只重启相应服务。`degraded` 是数据/持久化告警，不通过不断重启来掩盖。

若 `supervisorFresh` 为 `false`，查看 Windows 计划任务和 `logs/supervisor.log`。不要仅凭旧 `status.json` 中的 `ok` 判断当前存活。也可直接访问两个站点的 `/api/health`，确认 `persistence.configured=true`。

任务配置参考 [Microsoft 计划任务设置文档](https://learn.microsoft.com/en-us/powershell/module/scheduledtasks/new-scheduledtasksettingsset)，端口行为参考 [Vite 服务配置文档](https://vite.dev/config/server-options)。
