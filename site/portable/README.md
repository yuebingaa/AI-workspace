# Windows 便携包打包

先按项目运行约定构建未经运行的便携目录，再生成标准 ZIP：

```text
npm run build:portable:windows
npm run package:portable:windows
npm run test:portable
```

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

解压时选择一个新的空目录，建议使用短路径，如 `D:\AC-test`。旧包解压失败
后留下的同名文件可能继续妨碍目录创建，不要将新包覆盖解压到失败目录中。

便携包内置 Node 24，运行目标为 64 位 Windows 10/11（[Node 24 支持平台](https://github.com/nodejs/node/blob/v24.x/BUILDING.md#platform-list)）；解压兼容不等于支持
Windows 7 运行。目前的标准 ZIP 检查和解压验证不能替代目标电脑具体版本的 360 实测。
