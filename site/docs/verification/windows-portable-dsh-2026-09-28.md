# Windows 完整运行包与独立分支交付 · 2026-09-28

## 交付

按用户授权推送最新版及运行依赖，不合并。源码分支为 `feature/eds-analysis-dashboard`；[GitHub 预览 Release](https://github.com/yuebingaa/AI-workspace/releases/tag/v0.1.0-windows-preview.20260928) 已公开，附件为 `AC-Win64.zip`、`SHA256SUMS.txt`、`README-Windows.txt`，不是源码 ZIP。main 保持 `134d543780a4b5df22870b92fe3c6194c6772c0a`，没有强推、分支切换或自动合并。

运行包构建及 Release 标签固定 `39acdc9566caff937f5841c5fac125f3a582ea24`；后续验收脚本 / 文档提交不改包内应用。ZIP 280,345,445 字节，解压后 767,402,304 字节、28,910 文件，最长归档路径 199 字符。SHA-256：

```text
69e6f2f0c59f5da6d8c1d4c47ed856dd01bce981f22a544289b067850fcd5b1c
```

含 Node 24.19.0、网站生产构建与运行依赖、DSH 0.1.7-rc.2、官方聊天与设置 Web、Python 3.14.2 / Pyodide 314.0.7、DuckDB、Chromium 151.0.7922.34 和许可证。用户不需安装 Node/npm/Python，但 AI 仍需网络与自己的密钥，外部数据库服务不在包内。建议 Windows x64 新短路径解压，不覆盖旧包数据。

沿用 `controlled-notebook-v1` 四包省略规则：未开放的 Office 转换和 DSH 原生图片处理包不分发；不是任意插件均可启用的通用 DSH CLI。旧 Harness 保留，网页对话使用 DSH，授权和草稿确认不变。

## 本次修改

- 提交已有的 DSH 原生会话 / 官方 UI、Notebook 与 Radix Themes、历史入口清理及测试文档，保留各批任务成果。
- `scripts/portable-build-utils.mjs` / `build-portable-windows.mjs`：只排除网站 `node_modules/.bin` 安装器生成的启动脚本。首次审计在 4 份脚本中发现本机路径，修复后重新构建；真正的包入口、许可证、DSH 依赖不裁剪。
- `scripts/package-portable-windows.mjs`：保留现有普通 ZIP 目录、CRC、路径检查和流式背压，用 Node 内置 zlib 压缩。旧 fflate 流式 Deflate 在 DSH 的 KaTeX 字体上产生无效距离引用，Windows/.NET 和独立 zlib 均能复现；修复后完整解压通过。
- `scripts/package-portable-windows.test.mjs`：补安装脚本过滤与多块二进制 / 空文件的独立 zlib 校验，未删除原断言。
- `scripts/verify-portable-windows.mjs`：适配实际 Radix 选择器、图表字段搜索、官方 DSH iframe、插件目录和新草稿按钮；不再把待确认草稿时的禁用输入框视为未结束。
- 便携使用说明与架构发行状态同步；未改业务实现、锁文件或升级依赖。

## 实际验证

- `npm test -- --exclude '**/.runtime/**' --maxWorkers=2`：284 文件 / 3,616 应用测试通过，既有实物工作簿 3 项跳过；随后 26 项 Node 工具测试通过。排除的是本机历史快照，不是源码失败测试。
- `npm run typecheck`、`npm run build` 通过；构建保留大 chunk 警告。新增改动仅为打包 / 验收和两行尾空白修正；最终发行的 app/components/core/runtime 与通过构建的源码一致。
- `npm run test:portable` 最终 32 项通过；打包与验收四个脚本的 ESLint 通过。未重跑全仓 lint，先前 vendored Python / worker lint 问题没有在本次修复或计为通过。
- `docs:agent:sync` / `docs:agent:check`：正文与发行记录同步，247 个源码指纹一致。
- Windows/.NET 完整解压通过；解压目录全树 SHA-256 与未运行发行目录一致。Node / DSH / browser 组件指纹及 13 个 Python 资源摘要一致；15,843 个文本文件扫描未发现令牌、私钥或本机构建路径，路径检查排除私有状态与 `.env`。未打包个人项目、原件、测试数据库和历史会话。扫描不构成绝对无漏洞保证。
- 首次启动只给 Windows 系统 PATH，不继承 Node/npm、模型密钥、代理或本机项目；确实由包内 Node 启动且观察到 Python 启动包内浏览器。HTTP、默认 DSH、首次无密钥、官方聊天和插件设置、实际 CSV → Python → SQL → 图表通过，精确核对 East 300 / South 160。
- 一次真实收费 `deepseek-flash` 用户任务：6 次模型请求 / 5 次工具调用，保留原四单元，新增“AI汇总表”，试运行并成功提交待确认草稿。未独立取得供应商账单或 token 总量，不伪造金额。验收环境显式设置有限工具 / 时间预算，只作用于本次测试，不写入运行包默认配置。
- 原脚本随后错误等待输入框恢复而超时，报告保留失败状态；实际已自动预览成功。使用原解压副本及已保存的同一草稿无费续验：不注入模型密钥、不发模型请求，正式四单元在确认前不变；确认后五单元运行成功，三个相关结果均精确匹配；保存重开保持定义，看板不变。不能把该分段验收称为原脚本从头到尾一次通过。
- 最后另从同一个最终 ZIP 新建解压副本，执行更新后的 `node scripts/verify-portable-windows.mjs --root <新解压的绝对目录> --output <新的证据目录>`（不加付费开关），首次启动、官方聊天 / 插件目录、CSV / Python / SQL / 图表、保存重开从头到尾一次通过，0 次模型任务、0 页面异常、0 禁止请求。报告为 `site/.runtime/portable-release-20260928-offline-final/report.json`。
- GitHub 三附件均 `uploaded`，远端大小 / SHA-256 与本地一致；匿名下载 HEAD 200、280,345,445 字节。没有声称重新下载整个远端 ZIP。

## 实际截图与证据

本批没有网站功能或视觉变更，截图来自隔离便携端口 3210，不冒充 3001 新 UI 验收。以下 7 张本批原图已实际查看：

| 本地证据 | 场景与结论 |
| --- | --- |
| `site/.runtime/portable-release-20260928-acceptance1/01-no-credentials.png` | 首启为空密钥，需使用者配置 |
| 同目录 `01b-official-plugin-settings.png` | 包内官方设置和真实安装目录加载，未写配置 |
| 同目录 `02-python-sql-chart.png` | 实际 Python / SQL 结果与图表 |
| 同目录 `failure.png` | 草稿已生成并自动运行；输入框因待确认禁用，记录脚本误判 |
| `site/.runtime/portable-release-20260928-adoption-resume/01-restored-real-dsh-draft.png` | 原真实草稿重开，尚未采用 |
| 同目录 `02-adopted-ai-table.png` | 确认后真实汇总表 300 / 160 |
| 同目录 `03-saved-project-reopened.png` | 5 个单元定义恢复，运行缓存不持久化；图中 DSH frame 仍在加载，不以它证明 DSH 恢复完成 |

上述两个目录的 `report.json` 分别保留原失败与无费续验成功。包体审计、压缩失败候选、全树摘要与发行操作证据在 `artifacts/releases/2026-09-28/`，均留本地，不上传用户日志或整个 artifacts。

最终非付费全流程的 4 张新截图亦实际查看，位于 `site/.runtime/portable-release-20260928-offline-final/`：`01-no-credentials.png`、`01b-official-plugin-settings.png`、`02-python-sql-chart.png`、`06-saved-project-reopened.png`。覆盖空密钥、官方设置、精确图表结果及四单元保存重开；重开没有自动计算。共查看 11 张本次截图，没有用旧图代替。

## 边界

GitHub 仅预览发行；本机 3000 未更新。3000 / 3001 / 3198 前后均健康，PID、revision、重启计数不变；只关闭本次自己启动的便携验收进程。

未在另一台实体电脑、Windows 10、特定 360 解压器上验收，未连接生产或外部数据库；没有代码签名，不建议关闭安全软件。原有 SDK 预发布依赖风险、未开放插件及已有全仓 lint 问题仍保留。根任务日志按现有规则保持本地忽略，源码不携带其敏感历史。
