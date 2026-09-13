# 本地 Notebook MVP

2026-09-13 更新：源码增加 PostgreSQL / Databricks 连接入口、DataRecipe（transform）单元、可选保存 Dataset 和统一结果引用；参见 [SQL 连接与第一阶段边界](docs/sql-connections.md)。下文原 MVP 的“无外部数据库”描述已由新实现替代；看板仍采用独立快照，尚未实现响应式 App 发布。项目文件夹内的数据使用项目存储，非项目上传仍为临时数据。

这是基于现有 TypeScript Harness 的本地分析闭环，不是完整的 Hex 平台，也没有更换后端框架。

## 使用

只在开发站 `http://127.0.0.1:3001` 验证；服务管理遵守 [STABLE-RUNTIME.md](STABLE-RUNTIME.md)。本轮没有发布或重启 3000 稳定站。

1. 选择一个工作界面，切换顶部 **Notebook**。
2. 导入 CSV / XLSX。可以使用现有多文件导入入口；每个 Data 单元选择一个已注册数据源。
3. 添加 Data 单元，设置简短的英文输出表名，例如 `sales`、`rates`。
4. 添加 SQL 单元，勾选输入表，再编写查询。也可用已有语义模型的维度和指标添加语义查询单元。
5. 单独运行某个单元会同时重跑其依赖；“全部运行”按依赖顺序执行。
6. 基于查询输出添加表格或图表。修改上游后，受影响的结果会失效并隐藏，需要重新运行；不会把旧结果标为新结果。
7. 点击“生成看板预览”会重新查询并建立结果快照。点击看板的“应用编辑”后，才修改正式 AppSpec。一个多指标图表在当前看板中会拆成多个单指标图表，不再次聚合指标。

示例（先勾选 `sales` 和 `rates`）：

```sql
SELECT s.region, COUNT(*) AS orders, SUM(s.amount * r.rate) AS revenue
FROM sales s
JOIN rates r ON s.region = r.region
GROUP BY s.region
ORDER BY revenue DESC
```

字段名在每个结果表头显示。SQL 中中文或含空格的列名需要双引号；输出会提供规范化字段名，供下游表格和图表选择。

## AI 草稿

在 Notebook 中点击“AI 编写步骤”，或直接向右侧助手描述任务。请求会携带当前 Notebook、版本和当前工作界面的数据源范围。模型可生成或调整 Data、本地 SQL、数据库 SQL、DataRecipe、语义查询、表格、图表、说明单元。服务端按项目重新注入已授权的数据库连接，连接凭据不进入模型上下文。

`createNotebookDraft` 先做结构和依赖校验，再实际试运行。SQL 没有执行器、运行失败或缺少数据时不能宣告成功。返回的执行证据与少量脱敏结果可供 Harness 使用；不会把全量结果发给模型。

草稿展示新增、修改、移除的单元，等待用户“采用草稿”。版本不一致时拒绝覆盖，必须基于当前版本重新生成。采用仅修改 Notebook，正式看板仍然不变。试运行通过不等于图表最终渲染通过，界面会明确标注这一点；现有 Harness 视觉验收机制未被移除。

AI 仍需要现有模型 API 配置及网络；手工 SQL 查询在本机运行，不调用外部模型。敏感数据沿用现有授权策略：未确认时拒绝 AI 查询；已授权的敏感文本使用运行期匿名标记，其他敏感值置空。人工运行结果与脱敏试运行可能不同，需要核对业务口径。

## 保存与当前边界

- 步骤定义保存在 `DataProduct.notebooks[workspaceId]`，包含 revision；打开本地项目时写入项目清单，否则保留原浏览器保存和备份机制。删除工作界面会同时清理其 Notebook 定义。
- 未打开本地项目的临时 CSV / XLSX 注册数据仍保留 **30 分钟**；源数据过期后要重新导入，并编辑 Data 单元重选来源。[本地项目 / Data Browser](docs/local-projects.md) 中的数据、原件和已保存结果不会按临时保留期过期，关闭时需等项目保存完成。
- 查询结果仅在当前页面内存中保留。刷新或切换工作界面后需重算，不恢复假“成功”缓存。
- 看板绑定的是独立快照，不会随 Notebook 后续编辑自动更新；需要重新生成预览。项目模式下快照保存至 Data Browser“已保存结果”，临时模式的快照仍受原上传数据保留规则约束。
- 支持单 Notebook 内的有序依赖图；上游变更或重跑标记下游失效，用户主动重算。数据库连接支持情况见 [SQL 连接说明](docs/sql-connections.md)。暂不提供跨工作界面的依赖、后台自动重算、循环依赖、Python / R 内核、任意文件路径读取或云端发布。
- EDS 功能保留在原入口。本版 Notebook 面向已导入的通用表格及本地演示数据，不直接读取 EDS 专用报告对象。

## 本地执行与限制

执行路径：`Notebook UI → POST /api/notebook/run → Runtime → 独立 Node 子进程中的 DuckDB-Wasm → 结果 / ChangeSet 预览`。

关键词校验只是提前报错，**不是安全边界**。每次 SQL 查询使用新的内存数据库和只读事务；只注入显式勾选的 Arrow 表。使用 `DEFAULT_RUNTIME`，不提供 Node 文件系统、HTTP、环境变量或 UDF 回调；关闭外部访问、扩展自动安装和加载并锁定配置。工作进程不继承模型密钥、`NODE_OPTIONS` 等敏感环境。

单条 SQL 超时 8 秒，整个 Notebook 超时 30 秒，最多 2 个并发查询；输入上限 16 MiB，输出上限 2 MiB、1000 行、30 列。源数据预览显示前 100 行，但 SQL 读取完整的已注册源数据。中间结果一旦截断，就不能作为下游 SQL 输入，避免产生错误汇总。看板快照最多 500 行且不能截断。步骤最多 30 个、定义最多 80 KB。

DuckDB 的 128 MB 内存设置与 Node 堆限制不是严格的操作系统 RSS 配额，超时由父进程终止查询进程。这是面向本机单用户的受限执行器，不应视为可直接暴露公网的多租户沙箱。继续使用固定回环地址；上线多人或公网前，需要独立的认证、隔离和资源限额设计。

大整数在安全范围内返回数字，超出 JavaScript 安全精度的整数、DECIMAL、时间及复杂值以字符串返回；NaN / Infinity 直接报错，不静默替换为 NULL。图表要求数值列，高精度字段需用户明确转换。快照保留字符串前导零、布尔值、空字符串和 NULL 的区别。

在运行管理器配置的 `STUDIO_LOCAL_STATE_DIR` 下记录 `notebook-query-log.json`，最多保留最近 100 次 SQL 的用户标识、任务、语句、耗时、返回行数、截断状态等；不记录结果行、密钥。扫描字节数当前不可得，记录为 null。SQL 本身可能包含业务字面量，这个本地运行文件不能进入公开仓库。没有配置状态目录时不提供持久查询日志。

## 代码与验证

- `components/studio/notebook/`：单元编辑、草稿采用、结果和图表。
- `core/notebook/`：数据契约、依赖图、失效判断、执行与看板转换。
- `app/api/notebook/run/`：规范化数据源读取、运行、结果快照 API。
- `core/harness/notebook*`：复用另一轮开发已加入的草稿契约与工具，扩展 SQL 和执行证据。
- `scripts/notebook-query-worker.cjs`：无宿主文件/网络接口的查询进程。
- `scripts/copy-notebook-runtime.mjs`：把工作进程、Wasm 和许可证放入 standalone 构建；便携包复用这些文件。

验证命令（均在 `site/`）：

```text
npm test
npm run build
npm run typecheck -- --incremental false
node scripts/notebook-browser-acceptance.mjs
```

浏览器验收只使用现有 3001 服务、隔离浏览器上下文和合成 CSV，并清理自身创建的数据集 ID。截图与报告写入 `evidence/notebook-*`。它覆盖导入、联表 SQL、图表、失效、确认、刷新、窄屏与草稿采用；AI 的页面部分使用明确标注的 SSE 夹具，不调用付费模型。另有 Harness 集成测试让脚本模型生成草稿并真实运行 DuckDB，不能将这些测试等同于真实模型生成质量测试。
