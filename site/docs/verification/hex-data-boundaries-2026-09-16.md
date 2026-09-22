# Hex 第五批：公共数据契约与仓库端口

日期：2026-09-16。状态：本批选定范围的源码、离线检查、实库链路及 3001 浏览器截图验收完成；3000 未发布。

## 本批选定范围

- 将原 Notebook 字段 / 值 / 表形状提取到 Dataset 公共契约；Notebook 与数据库连接分别保有原行数 / 字节政策，数据 JSON 和类型含义不变。
- 共享 SQL 提前校验归到 SQL 模块，保留旧 Notebook 导出、字符限制、语法取舍和错误文案；不把词法预检当作数据库安全边界。
- Dataset 仓库端口和错误类型从内存 / 文件实现中分离，补全实际使用的同步撤权检查，避免项目仓库仅引用错误就加载全局临时仓库。
- 验证实际消费者、权限 / 取消 / 精度 / 截断 / 持久化兼容及真实开发站截图。没有新 Cell / 查询语法 / 页面交互、通用结果仓库或动态插件。

## 基线及工作记录

- 分支 `feature/eds-analysis-dashboard`，HEAD `df5bbae`；保留前四批未提交内容。
- 开始时 stable / dev / capture 均健康；进程与第四批结束一致，dev 历史重启数 2；未启停服务。
- 修改前实际全量测试 1,313 项应用及 14 项 Node 通过，3 项既有跳过；证据 `.runtime/hex-data-boundaries-2026-09-16/tests-baseline.log`。
- 执行器和编辑器注册只读审计后保留：当前生命周期和各类表单有实际差异，优先解决连接与仓库的真实跨层耦合，不机械增加处理器框架。

| 切片 | 状态 |
| --- | --- |
| 公共表形状与 Notebook 兼容 | 完成 |
| SQL 预检 / Connection 消费及自有政策 | 完成；实库 8 项通过 |
| Dataset 端口 / 错误身份 / 同步授权复查 | 完成；真实热更新冲突修复后通过 |
| 架构边界 / 全量检查 | 完成 |
| 浏览器截图 | 本批新运行 8 组 / 11 图通过并实际查看 |

## 实际目录与关键变更

```text
core/datasets/
  table-contracts.ts                 # 新增：DataTable / 字段 / 标量的公共形状
  table-contracts.test.ts            # 新增：原契约特征化及消费边界
  repository.ts                     # 新增：仓库端口与错误类型，无实例
  repository.test.ts                # 新增：内存 / 项目双适配器契约
  repository-boundary.test.ts        # 新增：导入不得初始化临时仓库
  server/dataset-repository.ts       # 原 Memory / 快照 / 默认实例；兼容重导出
core/sql/
  read-only-query.ts                 # 新增：原 SQL 预检实现的明确归属
  read-only-query.test.ts            # 新增：原语法 / 错误顺序与旧入口身份
core/notebook/
  contracts.ts                      # 旧表名称兼容，仍施加 Notebook 原额度
  sql.ts                            # 旧函数名重导出，无第二套算法
core/connections/server/
  query-contracts.ts                 # DataTable 端口及连接自己的原配额
  query-service.ts / query.ts        # 依赖 Dataset / SQL，不依赖 Notebook
  result-table.ts                   # 原转换、类型和截断，保留独立结果上限
  drivers/postgres.ts / databricks.ts # 原驱动行为，仅迁移额度依赖
```

同时更新 `projects/server/store.ts`、`request.ts`、Dataset / consent API、`exports/server/harness-excel-exporter.ts` 的实际消费者，新增或扩充关联测试。`core/architecture/module-boundaries.test.ts` 增加四项保护；架构检查器将新 `core/sql` 纳入源码指纹并增加漂移回归。没有删除源码文件、迁移存储格式、增加第三方依赖或生成新锁文件。

### 表契约与执行政策分开

`dataFieldSchema` / `dataValueSchema` / `dataTableSchema` 只依赖 Zod，保留原字段长度、四种类型、有限数字、标量最大长度、1–100 列、rows 和 truncated。公共表形状不表示可无限查询或读取，也不是结果句柄服务；消费边界继续有自己的限额。

- Notebook 原 `notebookFieldSchema` 是同一字段 Schema 的别名，`NotebookTable` 是 `DataTable` 类型别名；结果仍最多 1,000 行，SQL 输入仍最多 50,000 行。旧 API JSON、strict 规则、值类型和错误路径保持。
- Connection 自有 `CONNECTION_QUERY_LIMITS`：1,000 行、2 MiB、12 秒、两个并发，与原值一致；结果 Schema 对公共 shape 追加自己的行数限制。两个驱动 / 查询服务不再依赖 Notebook，未来 Notebook 的 UI 或运行预算变化不会隐式改变数据库查询预算。
- BIGINT / DECIMAL 和日期仍按原驱动保持字符串，未进行新的精度转换；没有把现有 CSV / Excel 导入强行接到结果 Schema，也没有将大数据全部物化到浏览器。

### SQL 与仓库接口

`normalizeReadOnlySql` 直接保留原算法：10,000 字符、SELECT / WITH、引号 / 注释、单语句及禁用关键词，旧错误文案和检查先后不变；`normalizeNotebookSql` 重导出同一函数。它不是完整 SQL parser，也不是权限边界。数据库只读角色、PostgreSQL 只读事务、隔离执行、项目 / AI 授权与查询后撤权复查仍由原实现负责。

`DatasetRepository` 明确 CRUD、敏感策略和同步 `assertAiAccessPolicies`；`StoredDataset` 与原错误类型归公共端口文件。Memory 和 LocalProjectStore 均实现此端口，请求选择器显式返回端口。原来的所有权差异保持：临时仓库对其他身份返回空，项目仓库拒绝错误所有者。没有新建全局 service、重复仓库或新缓存。

此前项目存储为了引用错误类，会运行时加载临时仓库文件，间接初始化全局实例、读取快照及可能清理过期项。本批通过公共错误入口消除此跨模块副作用；测试用明确 tripwire 先复现，再证明端口和项目存储导入不会触发它。真正需要默认临时仓库的 API / 组装入口仍明确导入原 server 实现。TTL、持久化文件、全局实例 key、容量、健康及失败原子性未改。

### 热更新发现和最小修复

开发站真实 HTTP 首轮复现：上传合成敏感 CSV、确认 masked 和同策略重放均成功，但改策略返回 500 而非原 409；重新读取仍为 masked。原因是热更新保留了旧全局实例的方法 / 错误构造器，新错误类的 instanceof 无法识别旧实例抛出的错误。

仅在 consent API 的 catch 添加窄兼容：真实 Error、name 与 constructor.name 都匹配原冲突类，消息必须是原三个精确业务文本之一。新构造器仍沿原 instanceof，普通 Error、仅同名的普通对象、伪装名称及任意私密文本继续返回脱敏 500。它只映射已经拒绝的操作，没有放宽授权、重置全局对象、重新创建仓库或重启服务。七项回归先复现三项失败后全部通过，且断言原存储内容不变。

修复后真实 HTTP 两场景通过：敏感样本 201/pending → masked 200 → 幂等 200 → 改策略 409 → 仍为 masked；无敏感字段样本 201/not-required → 策略确认 409 → 仍为 not-required。错误中文逐字匹配。中间一次临时命令因 PowerShell 管道把中文期望转成问号误失败，改用 Unicode 转义后完整复测，没有放宽断言。每轮仅删除经 ID、唯一文件名、创建时间、来源 ID 核验的自建样本，DELETE 204 后 GET 404；未列出或读取已有用户数据。所有进程不再持有迁移前实例后，可移除此 HTTP 兼容分支；公共旧类型 / 函数出口要等旧 import 迁移后再移除。

三轮实际观察与五个自建样本的核验 / 删除记录见[热更新 HTTP 观测摘要](../../.runtime/hex-data-boundaries-2026-09-16/hot-reload-http.json)。这是已执行断言的脱敏记录，不是原始 HAR 或完整网络抓包。

## 验证结果

| 实际执行 | 结果 |
| --- | --- |
| 修改前 `npm test -- --reporter=dot --maxWorkers=2` | 148 文件 / 1,313 项通过，1 文件 / 3 项既有跳过；另 14 项 Node 通过 |
| 最终同一全量命令 | 152 文件 / 1,397 项通过，原 3 项仍跳过；另 14 项 Node 通过，新增 84 项 |
| `npm run typecheck -- --incremental false` | 官方 typegen + tsc 最终通过 |
| `node node_modules/eslint/bin/eslint.js <本批 28 个文件> --max-warnings=0` | 通过；不是全仓 lint |
| `npm run build` | 最终明确 exit 0，保留既有大 chunk 提示 |
| `npm run docs:agent:sync` / `check` / `test` | 正文与变更记录维护，137 文件指纹一致，检查器测试通过 |
| `git -c core.safecrlf=false diff --check` | 通过 |

新增 84 项组成：公共表 31、SQL 19、连接结果 / 协议 / 超时 9、仓库端口 / 导入边界 14、架构边界 4、热更新 API 7。公共表的 26 项原 Schema 样例与 SQL 的 18 项样例先在迁移前跑通；新增模块缺失 / 缺独立字节配额、导入副作用及 HMR 错误分别先失败后通过。类型检查过程中修正测试 BigInt 字面量与项目 ES2017 不兼容，未调低编译限制；直接 tsc 碰到 `.next` 旧路由类型后由项目官方 typegen 修复，没有更改业务路由或关闭检查。

检查日志：[修改前基线](../../.runtime/hex-data-boundaries-2026-09-16/tests-baseline.log)、[最终测试](../../.runtime/hex-data-boundaries-2026-09-16/tests-after-hmr.log)、[类型检查](../../.runtime/hex-data-boundaries-2026-09-16/typecheck-final.log)、[最终构建](../../.runtime/hex-data-boundaries-2026-09-16/build-final.log)。`tests-final.log` / `build.log` 是 HMR 修复前已通过的中间检查，不冒充最终结果。

## 实库到输出端

重新执行 `scripts/test-database/verify-adventureworks.mjs`，先经既有 status / owner / 进程 / 端口 / 数据库身份核验，使用用户此前授权建立的回环 PostgreSQL 16 隔离测试库及其只读 reader。使用新建证据 / 项目 / 状态目录，没有恢复数据库、执行写 SQL、改变网站连接配置或启停数据库。

[本批实库报告](../../.runtime/hex-data-boundaries-2026-09-16/adventureworks-chain/report.json) 为 8 项通过：10 张授权表 / 107 字段、31,465 张订单 / 38 个月 / 10 地区与独立 pg 查询核对；numeric 原值保持字符串。PostgreSQL → DuckDB → 表格 / 图表、结果引用、保存 Dataset / 来源、预览不应用 / 确认 / 撤销、项目重开均通过。超过 1,000 行明确截断并拒绝下游伪全量和保存，未授权表数据库拒绝，取消后重试正常。固定模型替身驱动 4 个真实 Harness 工具至 awaitingConfirmation，不自动采用且拒绝过期版本。

该实库验收加载真实 API 实现但不监听 HTTP；浏览器另验证真实 HTTP / UI，不把两者合称一条真实模型链。没有收费模型调用、Databricks 实库或生产验证。金额供绘图的显式浮点转换只按固定样例核对，不宣称一般十进制转换无损。

## 本批浏览器截图记录

重新执行已有 `node scripts/verify-cell-modules.mjs`，使用新的隔离 Edge、合成项目与本次时间戳目录，脚本未修改；没有用第四批的截图代替第五批验收。[本批 report.json](../../.runtime/cell-modules-2026-09-16/browser-1789562267489/report.json) 首轮 8 组通过、11 次真实本地 Notebook HTTP 请求、11 张图；页面错误 / 禁止请求 / 模型调用均为 0。数据库目录仅为明确 GET 替身，远端 SQL 未在浏览器运行；真实数据库证据为上节独立验收。

| 图片 | 本次核对结果 |
| --- | --- |
| 01 / 02 | 无连接时不插入非法单元；新增后取消仍保留已插入默认说明 |
| [03 图表 1440](../../.runtime/cell-modules-2026-09-16/browser-1789562267489/03-real-chart-1440.png) / [04 图表 1024](../../.runtime/cell-modules-2026-09-16/browser-1789562267489/04-real-chart-1024.png) | 真实 CSV → SQL 150 / 80 → Python / DataRecipe → 图表与表格 300 / 160，布局可读 |
| [05 Python 失败](../../.runtime/cell-modules-2026-09-16/browser-1789562267489/05-real-failure-1440.png) / [06 下游阻断](../../.runtime/cell-modules-2026-09-16/browser-1789562267489/06-blocked-1024.png) | 实际 ValueError、准备 / 执行耗时，依赖图表不复用旧结果；显式修复后成功 |
| [07 语义结果](../../.runtime/cell-modules-2026-09-16/browser-1789562267489/07-local-semantic-result.png) / 08 | 本地语义汇总 150 / 80；数据库目录失效后原定义仍保留 |
| 09 / [10 重开](../../.runtime/cell-modules-2026-09-16/browser-1789562267489/10-reopened-nine-kinds.png) | 删除 Data 正确提示 6 个下游，保留不写入；九类改名 / 保存 / 编辑取消 / 重开一致。画面只显示当前滚动范围，完整九类由 DOM 与磁盘断言补充 |
| [11 合成单元删除](../../.runtime/cell-modules-2026-09-16/browser-1789562267489/11-test-cells-deleted-1024.png) | 仅删除本次九个 Cell，合成 CSV / Dataset / 语义模型保留，看板为空白 |

验收代理实际逐张查看全部 11 图，主代理另查看 04 / 05 / 07 / 11；本批没有新增 UI / CSS，仅验证模块边界迁移后的原有展示。取消场景为编辑取消 / 删除保留；远端运行取消由实库验收验证，不冒充浏览器点击运行取消测试。

## 工作区与启用状态

仍在 `feature/eds-analysis-dashboard`、HEAD `df5bbae`；所有既有修改和本批改动均未提交，未推送 / 切分支。没有重启、停止或发布网站，稳定站 3000 仍是原独立构建；开发站 3001 源码已验收。前后 stable / dev / capture 全部健康，进程、revision 与重启数未变，dev 历史两次本批未增长。

未修改网站凭据、既有数据库或用户项目。实库验收只用 reader SELECT / 取消及新建隔离证据状态，未重新绑定连接。HTTP 清理仅删除五个本次临时合成 Dataset，无回收恢复需求；浏览器仅删九个本次测试 Cell，原件和数据留档。TASK-LOG 与 `.runtime` 继续按现有规则保留在本地，任务日志原有历史前缀核验不变。

## 后续替换与保留边界

- 更换 Dataset 存储：实现 `DatasetRepository`，保持同步撤权语义，在请求选择入口组装；公共错误无需加载默认 Memory 实现。现有端口仍使用物化 rows，不等于流式数据仓库。
- 更换数据库：实现既有 `ConnectionDriver`，使用 `DataTable` 结果及明确的连接政策；SQL 方言、认证、取消与分页差异仍由驱动承担。
- 调整 Notebook 配额不会自动更改 Connection 配额；未来增大任一结果上限仍需独立评估调用方、序列化、完整性及 API，不能仅修改公共 shape。
- Agent / Harness / Model / Dashboard 的策略、执行循环、模型适配、确认 / 撤销和渲染入口本批未重写。新增 Cell 注册、动态插件、通用结果访问 / 分页 / Arrow、响应式 DAG、参数与能力卸载仍待后续。
- 保留全部原有未提交修改；无 Git 提交 / 推送 / 分支操作、依赖升级、数据库迁移或用户数据清理。新源码文件需随未来功能分支提交，不能只提交旧文件的 import 改动。
