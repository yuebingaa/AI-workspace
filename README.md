# AgentCanvas / DataCanvas 本地数据分析工作空间

网站源码在 `site/`。使用本地项目文件夹保存数据、原始文件、语义模型、Notebook 与看板定义；AI 通过受控工具计算，修改先生成草稿，由用户确认采用。

## 本机使用

先阅读 [运行与安装约定](site/STABLE-RUNTIME.md)，所有 npm 命令在 `site/` 执行。已有环境先用 `npm run site:status` 检查，勿另外启动同端口服务。

- 当前开发成果：`http://127.0.0.1:3001`；稳定站 `http://127.0.0.1:3000` 是独立旧发布，不随源码修改更新。
- 在 Data Browser 的“项目文件夹”中创建或打开项目；建议为试用建立独立文件夹。备份整个项目，不仅复制 Notebook 定义。
- 导入 CSV / Excel；Excel 每个文件选择一张工作表转为 Dataset，完整原件另存。Notebook 可用 Data → SQL → 表格 / 图表；运行后检查结果和来源。
- 也可创建单表语义模型，再用 Data → 语义查询 → 表格 / 图表，统一维度和指标口径。跨表关系尚不支持。
- AI 工作台或侧栏可生成分析草稿；先审阅差异，再“采用草稿”。询问已有分析结论可只运行、回答，不必生成修改。看板输出仍须另行预览和确认。
- 保存后可重开继续对话；打开项目不自动运行全部分析。历史聊天不等于本轮计算证据，也不等于服务重启后的完整长期记忆。

## AI 执行器与限制

“设置与备份”可选择原 Harness 或 DSH。选择只影响后续任务、暂存在服务进程中；源码默认仍为原 Harness。DSH 的固定 SDK 安装、Node 环境与可用性见 [Agent 架构](site/docs/architecture/agent-architecture.md)。API 密钥只保留在服务端私有配置，不提交到 Git。

DSH 已接入受控 Data / SQL / Table / Chart / Transform / Text / Parameter，以及满足能力与授权条件的 Python、只读数据库。说明可以保留静态文字，也可以引用本轮完整单行结果；动态数值要配置引用，不在模板中执行公式。参考 [DSH 说明单元记录](site/docs/verification/dsh-text-cells-2026-09-22.md)。文本、数字、日期和单选参数以单行 `value` 表传入本地 SQL/Python，不拼接代码；不是远端 SQL 参数绑定或密码输入，见 [参数边界与验收](site/docs/verification/dsh-parameters-2026-09-22.md)。询问“当前参数值是多少？”可只读取已保存定义，不运行Notebook；这不等于业务结果已经计算，见[参数问答验收](site/docs/verification/dsh-parameter-inspection-2026-09-22.md)。本次选择有效的单表语义模型后，还可生成和运行 `semanticQuery`，沿用模型定义的维度与指标；模型本身仍由用户管理。它不等于桌面 DSH 的任意插件运行环境，不会悄悄回退另一个执行器。语义边界与验收见 [DSH 语义查询记录](site/docs/verification/dsh-semantic-query-2026-09-22.md)。

原件保存不代表自动发送给模型。DSH 原件分析仍要求当前请求实际附带原件；跨重开可使用持久 Dataset 分析。数据库必须在数据库侧使用最小权限账号，应用 SQL 校验不能替代只读权限。

## 开发入口

```text
site/
├─ app/api/              HTTP / SSE 与授权入口
├─ components/studio/    工作台、Notebook、数据浏览与看板 UI
├─ core/agent-engines/   Harness / DSH 选择及适配
├─ core/harness/         策略、工具、上下文、试运行与交付验证
├─ core/ai/server/       原 Harness 模型适配与组装
├─ core/notebook/        Cell 定义、依赖、执行端口与结果
├─ core/datasets/        数据描述、表契约与仓库
├─ core/connections/     只读查询、驱动与连接元数据
├─ core/semantic/        单表语义模型与查询
├─ core/projects/        本地项目保存、版本与兼容检查
├─ core/changesets/      看板预览、确认、应用与撤销
├─ runtime/dsh/          官方 SDK 子进程与受控协议
└─ scripts/              测试、受限浏览器验收与运行管理
```

常规检查：`npm test -- --maxWorkers=2`、`npm run typecheck`、针对变更的严格 ESLint、`npm run build`。Agent 相关修改须同步架构正文，再运行 `npm run docs:agent:sync` 与 `npm run docs:agent:check`。构建不等于发布；不要自动执行 `site:publish`。

真实模型端到端已有用户授权，验收仍采用隔离合成数据、显式付费参数、单次任务标记与实际计算断言；单测继续离线。浏览器验收串行运行，避免登记状态互相干扰。详细命令、实际截图、失败与未验证项见 [M7 本地交付记录](site/docs/verification/hex-m7-local-delivery-2026-09-22.md)。

进度及边界以 [里程碑](site/docs/architecture/hex-alignment-roadmap.md)、[Agent 架构](site/docs/architecture/agent-architecture.md)、[视觉规范](site/docs/visual-design.md) 为准。每次任务在本机 [TASK-LOG.md](TASK-LOG.md) 追加实际记录；测试数据和本机证据目录不自动提交到 Git。
