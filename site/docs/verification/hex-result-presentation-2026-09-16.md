# Hex 第九批：结果展示边界与预览排序

日期：2026-09-16 启动、2026-09-17 收尾；证据目录沿用启动日期。状态：源码、离线 / 实库回归及3001新截图验收完成；未发布 3000。

## 本批固定范围

- M5 中 Notebook 已返回预览的排序和分页；不新增查询、导出或全局结果存储。
- 图表 Recharts 适配、表格交互、纯预览计算分开，NotebookResult 仅组合。
- 数值 / 布尔按类型排序，字符串（含高精度数值）与日期按原始文本排序，不转换时间或精度。NULL 与缺失值始终在末尾，相等值保持原顺序。
- 表格排序不影响图表、下游、保存的 Dataset、Notebook 定义；新运行重置排序 / 页码。
- 保留原完整 / 不完整 / 未知范围、每页20行和图表前100行规则。

审计：`NotebookResult.tsx` 同时直接引用 Recharts、计算图表、维护分页和表格渲染；当前表格无排序。`NotebookPanel.tsx` 结果组件 key 使用指纹加 queryId，非SQL回执没有 queryId。本批以实际 runId 标识新结果，视图状态不跨运行延续。

执行器审计后保留：其取消、Python生命周期、结果发布和日志已有明确端口，强行创建通用插件上下文不具有本批收益。未实施动态 Cell 注册，不将其称为 M2 完成。

## 实际目录与变更

```text
core/notebook/
  table-preview.ts                  新：三态排序、稳定比较、分页
  table-preview.test.ts             新：16项纯函数回归
components/studio/notebook/
  NotebookResult.tsx                改：可用性与两个展示组件的组合
  NotebookResultTable.tsx           新：预览页码、排序、可访问表头 / 范围说明
  NotebookChart.tsx                 新：既有Recharts渲染适配
  NotebookChart.test.tsx            新：27项SSR属性契约测试
  NotebookResult.test.tsx           改：2项排序入口 / 缺失值回归
  NotebookPanel.tsx                 改：结果子树按实际runId:cellId标识
app/notebook-cells.css               改：六条暖灰表头 / 排序说明样式
core/architecture/module-boundaries.test.ts 改：纯预览及图表 / 表格依赖约束
scripts/verify-result-presentation.mjs      新：隔离项目真实HTTP与截图
```

无文件移动 / 删除。保留原工具、API、查询算法、项目格式、额度和确认规则；未引入依赖或再建执行器。图表参数与样式从旧组合组件搬到所属组件，表格缺失属性由显示 `undefined` 改为与空值一致的 `NULL`；这是本批有测试的最小相关修复。

## 模块接口与状态所有权

- `nextNotebookPreviewSort(current, fieldName)` 表达原序→升序→降序→原序；`notebookTablePreview(table, sort, page)` 返回当前页、总页数、合法排序及20行视图。仅类型依赖Dataset公共表，不加载React、Zod运行时、驱动或模型。
- 数值 / 布尔字段先按实际值类型分组，组内按数值 / 布尔排序，非同类型组按字符串字符顺序；降序反转非空顺序。避免混合值逐对强转导致非传递比较。NULL / 缺失均在最后，同值按原索引稳定排序。
- 日期文本不按时间戳转换，高精度数字字符串不转Number；中文不是拼音 / 语言本地化排序。空字符串不是NULL。排序复制索引视图，不修改原行 / 表字段。
- `NotebookResultTable` 只拥有组件内的排序 / 页码；排序跨整个已返回预览而非当前20行。字段变化无效排序忽略、页码越界收敛；生产父入口使用runId:cellId重建，复用组件时需保留该生命周期约定。
- `NotebookChart({ cell, table })` 接收未排序原表；五类图、前100行、颜色、NULL连接、负值保护、尺寸和标签保持。Recharts被隔离在该组件，不表示全站Dashboard已替换渲染层。
- Agent / Harness / Tool / Model / SQL / Dataset / ChangeSet都维持原边界。仅视图排序不进入分析定义、工具参数、模型上下文、数据保存或看板配置，不能把它解释为全量数据重新排序。

## 验证记录

修改前全量基线：163文件 /1577应用通过、1文件 /3项原有跳过，另14 Node通过。基线日志保留于[候选审计目录](../../.runtime/hex-cell-execution-2026-09-16/tests-baseline.log)，目录名称来自审计阶段，未为整齐而重跑或删除旧证据。

| 本批命令 | 实际结果 |
| --- | --- |
| `npm test -- --reporter=dot --maxWorkers=2` | 165文件 /1623应用通过，1文件 /3项既有跳过；14 Node通过，exit0 |
| `npm run typecheck -- --incremental false` | exit0 |
| `node node_modules/vitest/vitest.mjs run core/notebook/table-preview.test.ts components/studio/notebook/NotebookResult.test.tsx components/studio/notebook/NotebookChart.test.tsx core/architecture/module-boundaries.test.ts --reporter=dot` | 4文件 /70项通过 |
| `node node_modules/eslint/bin/eslint.js <本批10个TS/TSX/脚本> --max-warnings=0` | exit0；不是全仓lint |
| `npm run build` | exit0，既有500kB chunk提醒保留 |
| `npm run docs:agent:sync`、`check`、`test` | 正文及变更记录同步，142文件指纹一致，检查器1项通过 |
| `node --check scripts/verify-result-presentation.mjs` | 验收代理实际运行通过 |
| `git -c core.safecrlf=false diff --check` | 通过；新增文件另验编码 / 尾空白 |

新增46项：纯预览16、图表27、结果SSR2、架构1。新增展示测试先真实复现2失败 /4兼容通过，接线后转绿，没有删除或弱化既有断言。图表SSR用显式Recharts属性探针，仅证明适配契约，不能替代真实SVG和交互截图。

日志：[红测](../../.runtime/hex-result-presentation-2026-09-16/presentation-red.log)、[专项](../../.runtime/hex-result-presentation-2026-09-16/targeted-final.log)、[全量](../../.runtime/hex-result-presentation-2026-09-16/tests-final.log)、[类型](../../.runtime/hex-result-presentation-2026-09-16/typecheck.log)、[严格检查](../../.runtime/hex-result-presentation-2026-09-16/lint.log)、[构建](../../.runtime/hex-result-presentation-2026-09-16/build.log)。

### 真实数据库兼容

完整阅读现有脚本及说明、核验隔离库归属 / 进程 / 回环监听 / reader只读及12秒超时后，运行原 `node scripts/test-database/verify-adventureworks.mjs --runtime-dir <既有v3隔离目录> --evidence-dir <本批目录>/adventureworks-chain`，exit0，[8/8通过](../../.runtime/hex-result-presentation-2026-09-16/adventureworks-chain/report.json)。10表107字段、31465订单 /38月 /10地区与独立PG核对；PG→DuckDB→表图→Dataset来源及重开→Dashboard预览 / 应用 / 撤销，真截断 / 未授权表拒绝及取消重试兼容。

模型选择为固定替身，4个真实Harness工具最终等待采用、9条查询回执、真实模型调用0。前后库PID28212、回环55432和ready不变，无恢复 / 启停 / 写库 / 改连接配置。是原进程内模块链兼容，不冒充浏览器SQL仓库链或真实模型质量。

### 浏览器

仅3001新合成项目，真实CSV导入 / DuckDB / DataRecipe HTTP；连接目录GET使用明确空目录替身，不触碰其他项目 / 外部数据库，不调用模型。实际命令 `node scripts/verify-result-presentation.mjs` 最终exit0，[7组 /10图 /9次运行报告](../../.runtime/hex-result-presentation-2026-09-16/browser-1789574392454/report.json)。页面异常 / 禁止请求均0。

| 截图 | 实际验收 |
| --- | --- |
| `01-numeric-sort-1440.png`、`02-null-last-descending-1024.png` | 第45行最小值移动到首页，2排在10之前；相同值稳定、升降序NULL均末尾 |
| [03-string-precision-1440.png](../../.runtime/hex-result-presentation-2026-09-16/browser-1789574392454/03-string-precision-1440.png) | 同屏001、9007199254740992和9007199254740993，保留文本精度及升序 |
| `04-chart-independent-1440.png`、[05-chart-independent-1024.png](../../.runtime/hex-result-presentation-2026-09-16/browser-1789574392454/05-chart-independent-1024.png) | 实际SQL聚合A=1328 / B=1845 / C=1628；图保持A/B/C，表可按值变B/C/A，SVG未被排序操作改写 |
| [06-preview-only-scope-1440.png](../../.runtime/hex-result-presentation-2026-09-16/browser-1789574392454/06-preview-only-scope-1440.png) | 1324完整 /1000预览，降序从1000而非不可见的1324开始；原保存 / 看板额度保持 |
| `07-real-sql-failure-1440.png`、[08-blocked-chart-1024.png](../../.runtime/hex-result-presentation-2026-09-16/browser-1789574392454/08-blocked-chart-1024.png) | 真实DuckDB缺字段报错，下游表图阻断，不复用上次成功结果 |
| `09-cancelled-edit-1440.png`、`10-reopened-real-chart-1024.png` | 取消编辑不改正式SQL；刷新重开后重新运行得到同值原序，不保留表格排序 |

Enter和Space激活列头后焦点保持；SQL和无queryId的DataRecipe新runId均重置排序 / 页码。排序动作期间无Notebook请求，源Dataset、项目文件 / 表清单、Notebook定义与空白正式看板不变。全部10图验收代理逐张查看，主代理另看最终03 /05 /06 /08，并曾查看上一完整成功目录的其他视图。浏览器取消只指编辑取消，不声称新增运行中取消的截图。

前三轮脚本失败分别为DOUBLE直接转文本的小数点预期、重跑复位后的三态点击次数、SVG定位误包含图例；仅修正合成SQL / 脚本定位与精确断言后全新项目完整通过，没有修改产品规则。随后为让03同屏展示两个高精度字符串与001，再完整复跑生成上述最终目录。旧失败及成功目录、合成项目全部保留，无数据删除。

## 替换方式与剩余范围

以后替换Notebook图表库主要改 `NotebookChart.tsx` 和适配契约测试；表格分页 / 排序展示在 `NotebookResultTable`，比较规则在纯 `table-preview`。Dashboard其余图表组件不在本次迁移范围。替换模型、数据库或Agent仍用已有composition / driver / HarnessModel接口，本批未改这些位置。

尚未做服务端排序 / 分页、隐藏完整结果的交互访问、导出、参数单元、自动重算、动态Cell注册或功能禁用。浏览器仅本地合成数据；不声明任意模型分析正确、多人隔离或大数据压力已验收。当前表格排序只对当前预览有意义；需要全量语义排序必须显式修改SQL / 分析步骤。

## 工作区与启用状态

分支 `feature/eds-analysis-dashboard`、HEAD `df5bbae`。前八批和用户原有修改保留，本批源码 / 测试 / 脚本均未提交；无提交 / 推送 / 切分支、依赖 / 锁文件升级或服务生命周期操作。已有未跟踪模块需与消费者一起提交，不强制加入忽略的TASK-LOG / .runtime证据。三个服务前后健康，PID / revision / 重启数未变，dev历史两次未增长；build产物不表示已发布，3000保持原版本。

任务日志本批前287767字节，SHA-256 `C730F058D94F0006115837E3F6E39961D8D175AFEA9F6424B0E0DA9AD7DB09FD`；已追加并单独核验历史前缀不变。独立收尾代码审查未发现新增阻断；未来复用表格组件仍需保留结果身份重置约定。本切片不代表完整M2 / M3 / M4 / M5或全部里程碑完成。
