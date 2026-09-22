# SQL 连接与 Notebook 第一阶段

状态：源码实现；未发布到 3000。2026-09-16 已恢复独立 AdventureWorks PostgreSQL 16 测试实例，并在开发站配置只读连接；本轮完整输出链路验收见[首批实施记录](verification/hex-foundation-2026-09-16.md)。Databricks 仍只有协议测试，不能据此宣称真实云仓库联调完成。

## 配置本机连接

服务管理遵守 [STABLE-RUNTIME.md](../STABLE-RUNTIME.md)。开发站使用源码私有 `.env.local`，稳定站使用独立运行目录的私有配置。不要将真实密码、Token 或完整私有配置提交到仓库或发送到聊天。

示例（占位值，实际使用时在本机填写；JSON 保持单行）：

```dotenv
STUDIO_SQL_CONNECTIONS='[{"id":"sales_pg","name":"销售 PostgreSQL","kind":"postgresql","projects":["local"],"allowAi":false,"host":"127.0.0.1","port":5432,"database":"analytics","user":"analytics_reader","passwordEnv":"SALES_PG_PASSWORD","ssl":false}]'
SALES_PG_PASSWORD=replace-locally
```

`projects` 必须显式声明：`local` 表示未打开文件夹项目的本机工作区；文件夹项目填写其项目 handle（项目 API 的 handle，UUID），不能填写任意路径。通过环境变量配置的连接只对列出的项目可见。此机制面向本机单用户，不构成多人认证系统。

PostgreSQL 默认开启 TLS 并校验证书；示例只对本机测试关闭 TLS。配置数据库只读账户，限制可读取的 schema / table，以及函数、扩展和系统权限；运行时另启 `BEGIN READ ONLY`，不能把 SQL 关键词检测当作账户权限的替代品。

Databricks 示例：

```dotenv
STUDIO_SQL_CONNECTIONS='[{"id":"sales_db","name":"销售 Databricks","kind":"databricks","projects":["local"],"allowAi":false,"host":"https://your-workspace.cloud.databricks.com","warehouseId":"0123456789abcdef","tokenEnv":"SALES_DB_TOKEN","catalog":"main","schema":"default"}]'
SALES_DB_TOKEN=replace-locally
```

`host` 仅接受 HTTPS origin，不接受路径、URL 用户名或密码。为身份授予目标 Warehouse 使用权限和目标数据的只读访问权限。第一阶段使用服务端 Token 引用，未实现 OAuth 登录 / 自动刷新。两种连接可放入同一个 JSON 数组。

`allowAi` 默认 false，允许手动查询，不向 Agent 提供该连接。设为 true 意味着授权 Agent 使用这个只读身份读取元数据、执行查询，并将有限结果发送给当前配置的模型；不会自动对远端 SQL 行做逐字段脱敏。需要脱敏时，应连接预先脱敏的数据库视图，并用数据库权限限制其他对象。凭据始终只在服务端解析。

### 本地私有连接文件（可热读取）

`core/connections/server/local-config.ts` 新增服务端适配：在当前进程 `STUDIO_LOCAL_STATE_DIR` 下读取 `sql-connections.private.json`。文件不存在时维持原有环境变量模式；它不是项目文件，不进入 Notebook、浏览器状态或项目导出。开发 / 稳定站必须使用各自的私有状态目录。

```json
{
  "version": 1,
  "connections": [{
    "id": "local_pg", "name": "本地测试库", "kind": "postgresql",
    "projects": ["local"], "allowAi": false,
    "host": "127.0.0.1", "port": 55432, "database": "test_database",
    "user": "test_reader", "passwordEnv": "LOCAL_PG_READER_PASSWORD", "ssl": false
  }],
  "credentials": { "LOCAL_PG_READER_PASSWORD": "replace-locally" }
}
```

这是占位结构，不是真实凭据。限制为 20 个连接 / 凭据引用和 192 KiB；文件损坏或重复连接 ID 拒绝读取，不静默覆盖环境配置。环境与文件连接合并后再次校验项目 / AI 范围。凭据优先取对应环境变量，显式空值会禁用该凭据，不回退文件。文件凭据只对文件中完整匹配的连接配置生效，不能由调用者仅猜测引用名获取。

两个驱动和字段目录作用域共用同一凭据解析入口；查询服务通过可注入的 `credentialIdentity` 接口，在返回结果前复查不透明身份，配置 / 凭据在查询期间撤销或轮换会拒绝旧结果。这里不是 OAuth、用户登录或多租户权限系统，也没有添加浏览器凭据编辑表单。

隔离 AdventureWorks 的恢复、启动 / 停止、只读注册及真实验收脚本见[测试库工具说明](../scripts/test-database/README.md)。注册脚本只修改已确认归属的开发站私有文件、保留其他连接、绑定显式项目；不修改 `.env`、稳定站或自动重启网站。默认 `allowAi=false`。项目中的查询 Dataset 依旧需要单独的 AI 数据授权。

## 用户与 Agent 流程

1. 打开开发站 Notebook，展开“数据库连接”，刷新连接、测试连接或浏览字段。字段目录带数据库、表 / 字段标识、同步版本与时间，可搜索表 / 字段并“同步目录”；新鲜目录复用 15 分钟，手动同步立即读取源结构。截断目录明确提示未加载部分。
2. 新建“数据库 SQL”单元；它查询所选数据库，可直接作为分析起点。
3. 添加 DataRecipe 单元处理查询结果，再接本地 SQL、表格或图表。没有保存 Dataset 的前置要求。
4. “保存为 Dataset”重新执行所选单元及依赖，保存完整结果和运行来源。来源包括本次 SQL / 单元定义、上游步骤、查询 ID、目录引用与结果摘要，可在保存提示和 Data Browser 中查看 / 下载。文件夹项目复用项目数据持久化；非项目模式沿用上传数据的临时保留规则。它是本次回执，不提供历史自动重放。
5. “生成看板预览”仍创建独立快照及 ChangeSet，确认后加入正式看板。它不是响应式 App 发布。
6. Agent 请求携带 Notebook 上下文，服务端注入可用连接。Agent 通过 `inspectConnectionSchema → createAnalysisPlan → createNotebookDraft` 生成并试运行相同单元，用户采用前仍检查文档版本。当前数据子 Agent 不执行数据库工具，仍由主 Harness 完成。

手动保存的外部查询数据集默认重新要求 AI 数据授权；仅运行 SQL 或保存文件不会自动授权模型读取结果。

## 结果与限制

2026-09-16 第五批仅调整源码归属：数据库连接使用 `core/datasets/table-contracts.ts` 的公共 `DataTable`，不再从 Notebook 获取表格式或额度。连接自己的 `CONNECTION_QUERY_LIMITS` 保持 1,000 行 / 2 MiB / 12 秒 / 两并发；公共 Schema 不代替这些执行边界。`core/sql/read-only-query.ts` 共用原来的 SQL 预检，旧 Notebook 函数名继续重导出同一实现，原错误和语法限制不变。详细验证见[第五批报告](verification/hex-data-boundaries-2026-09-16.md)；这不是新增查询模式、完整结果仓库或数据库权限机制。

- 每个成功表输出都有 `resultRef`：运行 / 单元 / 文档版本、直接上游结果 ID、声明的来源 Dataset、行数、完整性、内容指纹及 user / ai 访问模式。数据库单元可附执行前已存在的目录引用；目录版本不证明业务行未变化，也不证明 SQL 使用了目录中哪些表 / 字段。引用当前用于证据与血缘，不是持久结果服务地址。
- UI 预览与执行结果分开。源数据预览可只显示 100 行，DataRecipe 使用完整源表；数据库 / SQL 结果一旦截断，不能作为 DataRecipe 或下游 SQL 的完整输入。
- 远端查询最多并发 2 个、12 秒、返回 1000 行、结果 2 MiB；表目录最多 500 列。SQL 外层限制为 1001 行以检测截断，数据库扫描量仍由原 SQL 和数据库优化器决定。
- Databricks 使用 INLINE JSON，并轮询状态。结果分块尚未自动取全，多块结果明确标记为截断。取消会在已取得 statement ID 时请求远端取消；提交响应丢失、取消接口失败时不能保证远端已停止，需使用数仓资源管理和超时策略。
- PostgreSQL 数字按类型转换，BIGINT / NUMERIC 保持字符串；Databricks BIGINT / DECIMAL 同样保持字符串。需要绘图时在 SQL 或 DataRecipe 中明确转换并核对精度。重复列名、非有限数字、过大结果报错。
- Notebook 编辑或上游重跑使相关旧结果失效。远端数据变化不会主动推送到本机，需重新运行。没有查询结果缓存复用、Query 模式、远端 Chained SQL / 下推、参数单元、Python 内核或 App 发布版本。
- 凭据不写进 Notebook、Agent 上下文或导出。数据库原始错误不直接返回界面；PostgreSQL 返回可用的 SQLSTATE 以辅助排查。

实现依据：[node-postgres Client](https://node-postgres.com/apis/client)、[PostgreSQL 只读事务](https://www.postgresql.org/docs/current/sql-set-transaction.html)、[Databricks Statement Execution API](https://docs.databricks.com/api/statement-execution/v1/execute-statement)。

## 验证

2026-09-16 第五批复测：公共契约 / 配额归属迁移后，沿用已经恢复的隔离测试库，只使用 reader 重新跑八项真实链路（目录、数值 / 精度、PostgreSQL → DuckDB → 表图、Dataset、看板、重开、截断拒绝 / 权限拒绝 / 取消重试、脚本模型真实工具），全部通过；没有重新恢复数据库、修改开发站私密配置或发布。浏览器另以新合成项目真实本地 SQL / Python 验证八组和十一张截图，数据库目录使用明确替身，不把这组浏览器截图称作实库 HTTP 验收。[第五批证据](verification/hex-data-boundaries-2026-09-16.md)。

2026-09-16 AdventureWorks：真实本机 PostgreSQL 16 恢复 68 表 / 68 主键 / 90 外键，网站 reader 仅开放 10 表 / 107 字段。服务端 8 项与浏览器 10 项通过，覆盖 31,465 张订单、真实 SQL 与表图、Dataset / 来源下载、看板预览确认及项目重开；截断拒绝继续、42501 拒绝未授权表、取消重试通过。真实联调发现并修复 `pg.Query` 启用 `query_timeout` 时缺少回调导致的进程异常，保留行数 / 字节 / 时间保护，并补回归。Harness 用固定模型替身驱动真实工具验证，开发站连接仍仅手动；没有真实模型调用、Databricks 联调或稳定站发布。[本轮完整记录](verification/hex-foundation-2026-09-16.md)。

2026-09-14 数据底座切片：新增目录 / 来源实现，全量 991 项应用测试、14 项工具测试通过；类型 / lint / 构建通过，隔离浏览器完成 6 组目录界面与实际 CSV / SQL / 项目来源保存检查。目录界面采用 HTTP 替身，未进行真实外部数据库联调。目录采用现有私有运行目录 JSON 文件适配器，不需要安装新数据库；`STUDIO_LOCAL_STATE_DIR` 未配置时仅在内存保存，并在界面标明。目录按项目、手动 / AI 身份和连接凭据隔离，失败同步不覆盖旧版本；最多 60 个快照 / 8 MiB。源码与验证现状以 [Agent 架构](architecture/agent-architecture.md) 和根任务日志为准。

`core/connections/server/query.test.ts` 使用模拟协议验证连接范围、Agent 授权、只读事务、类型精度、截断、字节上限、轮询和取消。`core/notebook/transform-integration.test.ts` 真实运行本地 DuckDB 并连接 DataRecipe / 图表，验证 Agent 与人工采用同一契约。真实外部数据库账号、权限和网络需单独联调。

2026-09-13 最终验证：当前工作区全量离线测试 888 通过、3 跳过，另有 14 项 Node 测试通过；类型检查、相关 ESLint 和生产构建通过。浏览器通过实际手动 SQL / DataRecipe / 图表、保存 Dataset、上游重跑失效与窄屏控件不重叠检查。Agent 的完整路径使用脚本模型与模拟数据库输入，未调用真实外部模型或数据库。
