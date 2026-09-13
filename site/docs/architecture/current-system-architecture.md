# AgentCanvas Harness 与 Agent 系统框图

> Agent 角色、上下文、预算和验证机制的最新维护入口：[Agent 架构](./agent-architecture.md)。多 Agent 的实现与启用状态以该文档为准。

> 依据 2026-09-11 的当前源码整理。这里的 Agent 指模型决策层，Harness 指掌握执行权、权限、预算、证据和任务状态的确定性运行时。

## 一句话关系

**Agent 负责提出下一步，Harness 负责决定它能看到什么、能调用什么、工具是否真的执行成功，以及最终结果能否交付。**

| 模块 | 主要职责 | 不直接负责 |
| --- | --- | --- |
| Agent / Model | 理解意图、提出分析步骤、选择当前允许的工具、根据观察继续推理、生成候选回答 | 直接读取服务器数据、绕过工具、直接修改正式页面 |
| Harness | 规范化请求、装配上下文、规划和限权、执行工具、记录证据、恢复重试、验收结果、管理任务状态 | 替模型编造业务结论 |
| Tool | 在严格 Schema 和权限范围内完成一次具体操作 | 自主规划后续步骤 |
| Verifier | 根据用户目标、计划、工具观察和视觉证据决定通过、重规划或失败 | 接受只有文字声明而没有证据的“完成” |

## 总体框图

```mermaid
flowchart TB
  User[用户] --> UI

  subgraph Client[Web Studio]
    UI[AI 工作台 / 看板助手 / Notebook]
    ClientState[页面选择、任务历史、会话 ID]
    UI --- ClientState
  end

  UI -->|JSON 或 multipart| API
  API -->|SSE 执行事件或 JSON 结果| UI

  subgraph Boundary[API 与信任边界]
    API[POST /api/ai/harness<br/>POST /api/ai/harness/stream]
    Guard[请求 Schema、大小与文件签名<br/>服务端身份、数据授权、同源策略]
    Canonical[规范化 AppSpec、数据源、配方<br/>语义模型与 EDS 上下文]
    Session[Idempotency Store<br/>Conversation Store]
    API --> Guard --> Canonical --> Session
    Clear[DELETE /api/ai/harness/conversation] --> Session
  end

  Session --> Runtime

  subgraph Harness[DeepSeekHarness：确定性控制层]
    Runtime[Task State / 预算 / 超时 / 取消]
    Router[语义路由与任务分类]
    Context[Context Selector<br/>Working Memory / Skills]
    Planner[Execution Planner<br/>规则计划 + 受约束动态计划]
    Agent[Agent Model<br/>DeepSeekHarnessModel]
    Turn[结构化 Turn<br/>callTool / complete / blocked]
    Gate[Action Normalizer<br/>Schema、策略、当前 allowedTools]
    Executor[Tool Registry / Executor]
    Evidence[Observation + Evidence Bus]
    Verifier[Task Verifier<br/>可选 Visual Verifier]
    Recovery[参数修复 / Recovery / Replan]
    Trace[Task Summary / Trace / SSE]

    Runtime --> Router --> Context --> Planner --> Agent
    Agent --> Turn --> Gate
    Gate -->|callTool| Executor --> Evidence --> Context
    Gate -->|complete 候选| Verifier
    Evidence --> Verifier
    Verifier -->|未通过| Recovery --> Planner
    Verifier -->|通过| Trace
    Runtime --> Trace
  end

  subgraph Tools[受控能力层]
    ReadTools[数据读取<br/>Dataset / Fields / Raw Workbook / EDS]
    Semantic[Semantic Query<br/>模型 ID + 版本 + 指标口径]
    Analysis[Analysis Planner<br/>目标、问题、步骤、依赖、交付物]
    Notebook[Notebook Draft + Runner<br/>Data / Semantic / SQL / Table / Chart / Text]
    DataRecipe[DataRecipe<br/>转换、预览、校验、Excel 导出]
    Preview[ChangeSet Preview<br/>看板与 EDS 组件变更]
    MCP[MCP Client<br/>允许列表与权限策略]
  end

  Executor --> ReadTools
  Executor --> Semantic
  Executor --> Analysis
  Executor --> Notebook
  Executor --> DataRecipe
  Executor --> Preview
  Executor --> MCP

  subgraph Domain[数据与执行引擎]
    Repo[Dataset Repository<br/>CSV / XLSX / 本地行数据]
    Models[Semantic Model]
    EDS[EDS Workspace / 原始工作簿]
    DuckDB[Notebook DuckDB Runtime<br/>只读 SELECT / WITH]
    Excel[Excel Export]
    AppSpec[AppSpec / Recipes / ChangeSet]
    External[获准的外部 MCP Server]
    Visual[Playwright 截图服务<br/>可选多模态模型]
  end

  ReadTools --> Repo
  ReadTools --> EDS
  Semantic --> Models
  Semantic --> Repo
  Analysis --> Models
  Notebook --> DuckDB
  Notebook --> Repo
  DataRecipe --> Repo
  DataRecipe --> Excel
  Preview --> AppSpec
  MCP --> External
  Visual --> Verifier

  Trace --> Result

  subgraph Output[任务产物与终态]
    Result{Verifier 结果}
    Done[completed<br/>回答 / 表格 / Analysis Plan / Excel]
    Confirm[awaitingConfirmation<br/>ChangeSet 或 Notebook 待确认]
    Stop[blocked / failed / cancelled]
    Result --> Done
    Result --> Confirm
    Result --> Stop
  end
```

## 一次 Agent 任务的时序

```mermaid
sequenceDiagram
  actor U as 用户
  participant UI as Web Studio
  participant API as Harness API
  participant H as DeepSeekHarness
  participant P as Router + Planner
  participant A as Agent Model
  participant T as Tool Executor
  participant E as Evidence Bus
  participant V as Verifier

  U->>UI: 输入目标并选择页面、数据或 Notebook
  UI->>API: instruction + context + idempotencyKey + conversation_id
  API->>API: 校验格式、身份、授权并规范化上下文
  API->>H: server-authoritative HarnessRequest
  H->>P: 语义路由、Skill 选择、生成执行计划

  loop 在模型、工具、时间和上下文预算内
    H->>A: 当前步骤 + allowedTools + 精简上下文 + 既有证据
    A-->>H: callTool / complete / blocked
    alt Agent 请求调用工具
      H->>H: 校验 Turn、参数和工具权限
      H->>T: 执行唯一获准的当前工具
      T-->>E: 结构化结果与可追溯元数据
      E-->>H: Observation 和证据摘要
      H->>P: 推进计划；失败时修复或重规划
    else Agent 提交完成候选
      H->>V: 目标、计划、观察、产物和可选视觉证据
      alt 验收未通过且仍可恢复
        V-->>P: 问题清单和重规划要求
      else 验收通过
        V-->>H: passed
      end
    else Agent 判断缺少要求
      H->>H: 校验是否确实缺少上下文或能力
    end
  end

  H-->>API: HarnessTaskSummary + Trace + 产物
  API-->>UI: JSON，或 SSE completed 终止帧
  UI-->>U: 显示结果、阻塞原因或待确认草稿
```

## Analysis Planner 与 Notebook 子链路

```mermaid
flowchart LR
  Goal[用户分析目标] --> AP[createAnalysisPlan]
  AP --> Contract[校验数据源、语义模型版本<br/>步骤依赖、字段和交付物]
  Contract --> PlanArtifact[analysisPlanArtifact]
  PlanArtifact --> Choice{用户是否要 Notebook}
  Choice -->|否| VerifyPlan[Verifier] --> PlanDone[completed]
  Choice -->|是| Draft[createNotebookDraft]
  Draft --> Match[强制匹配 analysisPlanId<br/>步骤 ID、顺序、依赖和口径]
  Match --> Run[notebookRunner]
  Run --> Evidence[executionEvidence]
  Evidence --> VerifyNotebook[Verifier]
  VerifyNotebook --> Adopt[awaitingConfirmation<br/>等待采用 Notebook]
```

Analysis Plan 中的 SQL 步骤保存转换目标，Notebook Cell 才保存实际 SQL。当前 Runner 使用本地 DuckDB 执行依赖已有 Dataframe 的只读 `SELECT` / `WITH`；它不是通用数据库连接器，也不是任意 SQL 或 Python 沙箱。

## 权限和数据流边界

```mermaid
flowchart LR
  Untrusted[浏览器输入、历史消息<br/>上传文件、MCP 返回] --> Validate[Schema、大小、签名<br/>清理与权限校验]
  Validate --> Context[受预算约束的 Agent 上下文]
  Context --> Model[Agent Model]
  Model --> Proposal[结构化动作建议]
  Proposal --> Policy[Harness 策略与 allowedTools]
  Policy --> Tool[受控工具]
  Tool --> Evidence[结构化证据]
  Evidence --> Verify[Verifier]
  Verify -->|只读任务| Answer[可交付回答或产物]
  Verify -->|页面变更| Preview[ChangeSet 预览]
  Preview --> Human[用户确认]
  Human --> App[正式 AppSpec]
```

关键约束：

- 浏览器不能提交服务端角色、API Key、MCP 地址或启动命令；身份和运行配置由服务端补齐。
- Planner 每一步只开放当前 `allowedTools`；Agent 不能调用未注册或当前未授权的工具。
- 工具参数、工具结果和最终任务都要通过 Schema；工具失败会进入有限次数的修复或重规划。
- Evidence Bus 保存公开证据清单和安全摘要，不把模型内部推理当作证据。
- 数据或页面任务必须有真实工具观察；只写“已完成”不能通过 Verifier。
- 页面修改只生成 `pendingChangeSet`；用户确认前正式 `AppSpec` 保持不变。
- 图片原件、工作簿字节和完整原始工具结果不会进入 Conversation Store。

## 主要工具分组

| 分组 | 当前工具 |
| --- | --- |
| 数据与语义读取 | `inspectDataset`、`inspectFields`、`querySemanticModel` |
| 原始工作簿与 EDS | `scanEdsRawWorkbook`、`queryEdsRawWorkbook`、`inspectEdsRawWorkbook`、`readEdsRawRows`、`analyzeEdsReports` |
| 分析文档 | `createAnalysisPlan`、`createNotebookDraft` |
| 数据处理与导出 | `transformSpreadsheetData`、`previewDataRecipe`、`validateDataRecipe`、`exportDataRecipeToExcel` |
| 页面检查与变更预览 | `inspectAppSpec`、`createChangeSetPreview`、`createEdsBreakdownChartPreview`、`createEdsLineIssueChartPreview`、`updateEdsTablePreview` |
| 外部能力 | `callMcpTool` |

## 状态与产物

| 终态 | 含义 | 常见产物 |
| --- | --- | --- |
| `completed` | Verifier 已通过，可直接交付 | `resultMessage`、`tableArtifact`、`analysisPlanArtifact`、`exportArtifact` |
| `awaitingConfirmation` | 预览或草稿已通过当前阶段校验，等待用户采用 | `pendingChangeSet`、`notebookArtifact` |
| `blocked` | 缺少明确的数据、字段、权限或能力 | `missingRequirements`、安全说明 |
| `failed` | 协议、工具、预算或最终验收失败 | `error`、`terminationCode`、失败 Trace |
| `cancelled` | 用户取消、连接中止或拒绝待确认结果 | 取消记录，正式页面保持原状态 |

任务回执统一由 `HarnessTaskSummary` 表达，并可包含语义意图、Skills、Working Memory、Execution Plan、Evidence、Verification、计数、耗时和公开 Trace。SSE 的 `completed` 只表示请求结束，界面仍需读取 `task.state` 判断真实终态。

## 当前实现边界

- 主 Harness 支持 JSON 和 SSE；原始工作簿或图片通过受限 multipart 上传。
- 会话按身份命名空间、`conversation_id` 和 `pageId` 隔离，保存精简问答、Working Memory 和最近任务状态。
- 已有四类动态 Skill：数据可视化、EDS 异常分析、看板组件编辑、原始工作簿分析。
- 已支持本地 Notebook SQL 执行，但还没有 MySQL、PostgreSQL、Databricks 等通用数据库连接器。
- 尚无 Python 执行沙箱。
- `/api/ai/plan` 是独立的单次 ChangeSet Planner；新的多步 Agent 主链路使用 `/api/ai/harness`。
