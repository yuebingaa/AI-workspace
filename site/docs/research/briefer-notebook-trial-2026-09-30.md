# Briefer Notebook 替换试验：源码与运行前置检查

日期：2026-09-30。最新状态（10:33）：**WSL 3.0.1.0 安装成功、VirtualMachinePlatform 已启用，但系统要求重启；Linux 分发、Docker 与 Briefer 尚未安装/启动，尚未替换本站 Notebook。** 首轮核查保留如下，安装进展见末节。

## 首轮源码核查

用户要求尝试用 Briefer 替换现有 Notebook。本轮先检查现有项目约定、依赖、近期 B5 与 Notebook 研究记录，再将官方仓库浅克隆到 `artifacts/briefer-trial-20260930/source/`，仅稀疏检出核查所需文件，没有安装或执行第三方脚本。该目录在根项目既有 artifacts 忽略规则内，没有将整套源码复制进 site 或 node_modules。

- 来源：[briefercloud/briefer](https://github.com/briefercloud/briefer)。检出 commit `2ee5e84b2b40a065cbe37f780e27c228dcbf9174`，提交日期 2025-08-07；只是本次检出版本，不以此推断未来维护状态。
- 上游工作树检查无修改。README、LICENSE、web/editor package.json、v2Editor、环境状态 Hook、执行目录与 Jupyter Dockerfile 均做静态核查；没有把只读检查算作运行验收。
- 现有网站依赖 React 19.2.6 / Next 16.3.4 / vinext；上游 web 声明 React ^18.2.0 / Next 13.5.5。并非证明一定不兼容，但不能直接跨版本复制视作即插即用。

## 为什么不是安装一个组件就完成

| 实际源码 | 结论 |
| --- | --- |
| `packages/editor/package.json`、`src/index.ts` | `@briefer/editor` 是 private 工作区包，导出 Yjs block、布局操作、执行队列等模型能力；不是独立的完整 React Notebook UI |
| `apps/web/src/components/v2Editor/index.tsx` | 2,088 行页面编辑器，调用自有富文本、SQL、Python、可视化、透视、上传等块，依赖自有 Hook 和 Provider |
| `useEnvironmentStatus.tsx`、Editor 的 `ExecutionQueue` / `IProvider` | UI 通过协同与后台状态获取运行环境和执行结果，不仅是代码文本框 |
| `docker-compose.yaml`、`apps/api/jupyter.Dockerfile` | 官方完整路径包含 web、API、PostgreSQL、Jupyter 等；Jupyter 镜像安装扩展和原生系统依赖，并非本站 Pyodide 的直接替代包 |

依据：[官方架构说明](https://github.com/briefercloud/briefer#briefers-architecture)、[固定版本编辑器](https://github.com/briefercloud/briefer/blob/2ee5e84b2b40a065cbe37f780e27c228dcbf9174/apps/web/src/components/v2Editor/index.tsx)、[官方部署配置](https://github.com/briefercloud/briefer/blob/2ee5e84b2b40a065cbe37f780e27c228dcbf9174/docker-compose.yaml)。后者默认宿主端口为 3000，**不能原样启动覆盖本站稳定端口**。

## 首轮本机阻塞与权限边界（安装前）

- PATH 未找到 docker；常见系统级 Docker、用户级 Docker Desktop、Podman 安装目录未找到。没有断言任意磁盘路径绝无可执行文件。
- `wsl.exe --status` 返回 exit code 50，明确提示“未安装适用于 Linux 的 Windows 子系统”。最初 PowerShell 显示乱码，后使用 Node 捕获 UTF-16LE 字节核对原文。
- Windows 可选功能只读检查提示需要提升权限；没有提升权限、启用虚拟化、下载安装器、修改系统服务或重启电脑。
- 官方支持的本地容器运行方式当前缺前提；原生 Windows 拆装 API / Jupyter 的可行性未做运行验证，不能伪装成已可用替代路径。
- 上游 [AGPL-3.0 许可证](https://github.com/briefercloud/briefer/blob/2ee5e84b2b40a065cbe37f780e27c228dcbf9174/LICENSE)不是 MIT。正式移植、联网提供修改版或分发需评估适用义务；本轮不改变本项目许可证，不作法律结论。Docker Desktop 也有[企业使用条件](https://docs.docker.com/desktop/setup/install/windows-install/)，安装前须确认合适运行方案，不默认代用户接受条款或购买订阅。

## 后续建议（未实施）

先获得系统运行环境安装授权（或用户提供可用的容器服务器），以独立数据卷、仅回环监听、显式选择且不占本站端口的试验部署运行**完整官方 Briefer**，关闭匿名遥测与更新检查，不挂载用户项目/密钥，不开启 AI 或数据库写回。安装 WSL2 等可能要求重启，须另行确认重启时机。

先用模拟数据验收创建/修改单元、SQL/Python/图表结果、取消/错误、保存重开，确认值得采用后，再在 3001 做可回退的 Notebook 入口。DSH 工具、数据授权、本地项目保存及 GW 图表需单独定义双向适配；现有 Notebook JSON 与 Briefer Yjs 文档不是同一格式。只嵌一个 iframe 或绘制相似皮肤，都不等于已经替换执行、保存与 AI 链路。

## 首轮验证与未完成

`npm run site:status` 检查三个受管服务健康；没有进行任何服务启停。主项目业务代码、依赖、架构实现、用户项目及数据均未更改，仅新增本报告并追加任务日志。没有新 UI、构建、应用测试、截图、Briefer 执行、收费模型调用、发布或 Git 提交/推送；没有可交付的 Briefer 网页入口。下一步等待运行环境方向/安装授权，不能把源码下载写成替换完成。

## 获授权后安装 WSL（2026-09-30 10:24–10:33）

用户已同意安装运行环境，但未授权重启。选择 WSL2 + Linux 内 Docker Engine 的准备路线，不安装 Docker Desktop 或接受其订阅条款。参考[微软官方离线安装步骤](https://learn.microsoft.com/en-us/windows/wsl/install#offline-install)，只安装官方 WSL MSI 和启用 VirtualMachinePlatform；不额外启用 WSL1、不改启动项或 BIOS。

- 下载：[微软 WSL 3.0.1 正式发布](https://github.com/microsoft/WSL/releases/tag/3.0.1)，资产 `wsl.3.0.1.0.x64.msi`，367,669,248 字节。GitHub API 标记非 prerelease，SHA-256 `28b1a0d013640a2ac95898ea705fa186e5b4ff767a1c1b49257161bc106599c6` 与实文件一致；Authenticode 为 Valid，签名者 Microsoft Corporation。最初 curl 因证书吊销服务离线失败，未关闭证书检查，改用正常 HTTPS Invoke-WebRequest 下载并再次做文件哈希/微软签名核验。
- 执行：本机隔离目录 `artifacts/briefer-trial-20260930/install/` 中新增 `install-wsl-no-reboot.ps1`，先通过 PowerShell 语法解析，再通过 Windows 正常 RunAs 提升执行（没有修改 ExecutionPolicy）。脚本在管理员进程内再次核验哈希与签名，仅执行固定 MSI 和 VirtualMachinePlatform 操作；MSI 使用 `/qn /norestart REBOOT=ReallySuppress`，系统功能启用使用 `-NoRestart`，没有系统重启命令或延后自动任务。
- 实际结果：MSI exit 0；VirtualMachinePlatform 从 Disabled → Enabled，启用结果 `RestartNeeded=true`。`wsl --version` exit 0：WSL 3.0.1.0、内核 6.18.40.1-1。`wsl --list --verbose` 明确没有已安装分发；不能将版本输出当作 Linux 虚拟机已成功运行。
- 证据：本机 [安装状态 JSON](../../../artifacts/briefer-trial-20260930/install/wsl-install-state.json)保留阶段、签名、MSI 返回码与重启要求；同目录保留官方安装包、安装脚本及 MSI 日志，均在既有 artifacts 忽略范围内，不上传 Git。
- 网站复核：10:25 与 10:33 `site:status` 均为三个服务健康，supervisor / worker PID、revision、重启数不变。没有停止、重启或发布 3000/3001/3198，没有替换 Notebook、迁移项目、读取用户原始数据、修改网站依赖或 Agent 接口。
- 下一步：用户保存工作并重启电脑后，复核 WSL2 虚拟机可启动，再安装独立 Linux 分发与[官方 Docker Engine](https://docs.docker.com/engine/install/ubuntu/)，最后隔离启动 Briefer。**本轮停在重启前**，未安装 Linux / Docker、未拉取容器镜像、未启动 Briefer，无新网页或截图。没有应用代码修改，未运行本站构建/应用测试或同步架构指纹；本轮的实际验证是安装、CLI 与服务健康检查。
