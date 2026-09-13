# SQL 连接与 Notebook 第一阶段

状态：源码实现；未发布到 3000。连接器协议测试与本地 DuckDB 测试不等于真实 PostgreSQL / Databricks 联调。

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

## 用户与 Agent 流程

1. 打开开发站 Notebook，展开“数据库连接”，刷新目录，测试连接或浏览字段。
2. 新建“数据库 SQL”单元；它查询所选数据库，可直接作为分析起点。
3. 添加 DataRecipe 单元处理查询结果，再接本地 SQL、表格或图表。没有保存 Dataset 的前置要求。
4. “保存为 Dataset”重新执行所选单元及依赖，保存完整结果和运行来源。文件夹项目复用项目数据持久化；非项目模式沿用上传数据的临时保留规则。
5. “生成看板预览”仍创建独立快照及 ChangeSet，确认后加入正式看板。它不是响应式 App 发布。
6. Agent 请求携带 Notebook 上下文，服务端注入可用连接。Agent 通过 `inspectConnectionSchema → createAnalysisPlan → createNotebookDraft` 生成并试运行相同单元，用户采用前仍检查文档版本。当前数据子 Agent 不执行数据库工具，仍由主 Harness 完成。

手动保存的外部查询数据集默认重新要求 AI 数据授权；仅运行 SQL 或保存文件不会自动授权模型读取结果。

## 结果与限制

- 每个成功表输出都有 `resultRef`：运行 / 单元 / 文档版本、直接上游结果 ID、行数、完整性、内容指纹及 user / ai 访问模式。引用当前用于证据与血缘，不是持久结果服务地址。
- UI 预览与执行结果分开。源数据预览可只显示 100 行，DataRecipe 使用完整源表；数据库 / SQL 结果一旦截断，不能作为 DataRecipe 或下游 SQL 的完整输入。
- 远端查询最多并发 2 个、12 秒、返回 1000 行、结果 2 MiB；表目录最多 500 列。SQL 外层限制为 1001 行以检测截断，数据库扫描量仍由原 SQL 和数据库优化器决定。
- Databricks 使用 INLINE JSON，并轮询状态。结果分块尚未自动取全，多块结果明确标记为截断。取消会在已取得 statement ID 时请求远端取消；提交响应丢失、取消接口失败时不能保证远端已停止，需使用数仓资源管理和超时策略。
- PostgreSQL 数字按类型转换，BIGINT / NUMERIC 保持字符串；Databricks BIGINT / DECIMAL 同样保持字符串。需要绘图时在 SQL 或 DataRecipe 中明确转换并核对精度。重复列名、非有限数字、过大结果报错。
- Notebook 编辑或上游重跑使相关旧结果失效。远端数据变化不会主动推送到本机，需重新运行。没有自动缓存复用、Query 模式、远端 Chained SQL / 下推、参数单元、Python 内核或 App 发布版本。
- 凭据不写进 Notebook、Agent 上下文或导出。数据库原始错误不直接返回界面；PostgreSQL 返回可用的 SQLSTATE 以辅助排查。

实现依据：[node-postgres Client](https://node-postgres.com/apis/client)、[PostgreSQL 只读事务](https://www.postgresql.org/docs/current/sql-set-transaction.html)、[Databricks Statement Execution API](https://docs.databricks.com/api/statement-execution/v1/execute-statement)。

## 验证

`core/connections/server/query.test.ts` 使用模拟协议验证连接范围、Agent 授权、只读事务、类型精度、截断、字节上限、轮询和取消。`core/notebook/transform-integration.test.ts` 真实运行本地 DuckDB 并连接 DataRecipe / 图表，验证 Agent 与人工采用同一契约。真实外部数据库账号、权限和网络需单独联调。

2026-09-13 最终验证：当前工作区全量离线测试 888 通过、3 跳过，另有 14 项 Node 测试通过；类型检查、相关 ESLint 和生产构建通过。浏览器通过实际手动 SQL / DataRecipe / 图表、保存 Dataset、上游重跑失效与窄屏控件不重叠检查。Agent 的完整路径使用脚本模型与模拟数据库输入，未调用真实外部模型或数据库。
