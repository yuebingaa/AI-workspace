# Windows 便携包打包

完整包的接收者不需要安装 Node、npm、Python 或 DSH。下面是维护者在 Windows x64 / Node 24 构建端执行的步骤，不是接收者安装步骤。须先按现有锁文件准备网站依赖、`python:setup` 的固定资源，以及 `node scripts/setup-dsh-runtime.mjs` 的已修补独立 SDK。

构建端还需通过已安装的 Playwright CLI 准备固定 Headless Shell（不升级依赖）：

```powershell
$env:PLAYWRIGHT_BROWSERS_PATH = "$PWD/.runtime/portable-browser"
$env:PLAYWRIGHT_SKIP_BROWSER_GC = "1"
node node_modules/playwright-core/cli.js install chromium --only-shell
```

按项目运行约定构建未经运行的便携目录，再生成标准 ZIP：

```text
npm run build:portable:windows -- "../portable-release/AgentCanvas" ".runtime/portable-browser/chromium_headless_shell-1234/chrome-headless-shell-win64"
npm run package:portable:windows
npm run test:portable
```

构建程序验证 Windows x64 / Node 24，复制包内 Node、独立网站、受控 DSH 生产载体与已验证 SDK 树、Python / DuckDB 和浏览器资源。构建时需联网取得同版本 Node 许可证；启动包时不执行 npm 安装。必须用第三个命令行参数显式指定已准备的浏览器目录；当前锁定 revision 为 1234。已有网站构建可直接执行 `node scripts/build-portable-windows.mjs <新输出目录/AgentCanvas> <Headless-Shell内层目录>`。

生成 `portable-manifest.json` 和 `licenses/` 版本、来源与许可清单。DSH 保留当前已修补安装的 manifest / lock；发行 profile `controlled-notebook-v1` 精确省略未开放的 Office 转换及 DSH 原生附件图像处理四包（名单见清单），其余依赖保留。省略是由于对应源码分发未落实，并非升级或更改本机 SDK；受控实际加载图和便携分析另行验证。这是网站完整运行包，不是可任意启用官方所有插件的通用 DSH CLI 包。使用短路径 `app/.runtime/dsh-bundled`，不带历史安装、会话、凭据或用户项目。许可证清单不是对所有第三方分发条件的自动法律审查。

源目录默认为 `../portable-release/AgentCanvas`，新 ZIP 默认为
`../AgentCanvas-Windows-compatible.zip`。已有目录或压缩包不会被覆盖。
重新打包已有目录时只运行第二条命令，不需要重新构建网站。
也可以指定输入目录和一个不存在的输出文件：

```text
npm run package:portable:windows -- "输入目录/AgentCanvas" "输出目录/AgentCanvas-Windows-new.zip"
```

打包程序使用 [ZIP 规范 4.4.17.1](https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT) 要求的 `/` 路径分隔符、结尾 `/` 的目录条目和 DOS
目录属性 `0x10`，使用普通 STORE/DEFLATE 压缩并为中文文件名标记 UTF-8。
原来部分 ZIP 中的 `\` 路径和缺失目录属性可能使解压器误判目录为文件。
不要再依赖有此问题的压缩命令；Windows 自带解压成功不代表所有解压器都能读取非标准目录条目。

程序拒绝符号链接、过长或非法 Windows 路径、`.env`、`.git` 和运行后的 `data`
目录。此检查不是完整的敏感信息扫描，公开发布前仍需单独审核内容。

完整 SDK 树的实测路径达到 199 字符，因此本版上限从 180 调整为 210；未压缩体积上限从 768 MiB 调整为 1.5 GiB。采用逐文件流式 STORE / DEFLATE，条目少于 65535、压缩包小于 2 GiB，不使用 ZIP64。必须选择短解压目录，不承诺任意深层路径或特定 360 版本兼容。

便携启动器仅为该包设置默认 DSH 和包内 Python 浏览器，普通源码部署的默认 Harness 不变；网站只监听 127.0.0.1:3210–3229，遇占用自动选下一个，不触碰受管站。密钥由使用者启动后在 AI 接口配置输入，进程结束后需重填。切换执行器也仅在当前进程保留。

隔离验收使用新解压、从未运行的副本；不能拿已运行目录重新打包：

```text
node scripts/verify-portable-windows.mjs --root <完整绝对路径/AgentCanvas> --output <新的私有证据目录>
```

加 `--allow-paid-model` 才会读取本机既有凭据并发出一次真实收费 DSH 任务。默认不调用模型，验收只清理自身启动的便携进程；截图必须另行实际查看。最新实际结果见 [完整包交付记录](../docs/verification/windows-portable-dsh-2026-09-24.md)。

解压时选择一个新的空目录，建议使用短路径，如 `D:\AC-test`。旧包解压失败
后留下的同名文件可能继续妨碍目录创建，不要将新包覆盖解压到失败目录中。

便携包内置 Node 24，运行目标为 64 位 Windows 10/11（[Node 24 支持平台](https://github.com/nodejs/node/blob/v24.x/BUILDING.md#platform-list)）；解压兼容不等于支持
Windows 7 运行。目前的标准 ZIP 检查和解压验证不能替代目标电脑具体版本的 360 实测。
