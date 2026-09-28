# EDS input / output 语义分析首例

日期：2026-09-23。开发站：`http://127.0.0.1:3001`。本次创建案例项目与模型，不改产品执行引擎，不发布 3000。

## 在网页打开

数据浏览器 → 项目文件夹 → 最近项目 → **案例 01 · EDS input-output 语义分析**。

项目保存于仓库相对目录 `outputs/semantic-input-output-2026-09-23/project/`。这是需要保留的私有本地案例，包含原始工作簿和项目状态；不要将整个目录提交 Git 或公开分享。它不是临时缓存，不要当作验收垃圾清理。

- 第一个工作界面的 Notebook：业务说明、从 input 提取事实的 Python、对照 output 的 Python。
- **AI 语义分析案例**：最终 8 个单元，包含事实 Data、各线体语义查询、结果表和柱状图、AI 新增的总计查询 / 表格，以及独立复核说明。右侧保留真实 AI 建稿和只读追问的同一会话。
- 模型：**EDS input→output 异常分析口径**，6 个维度、3 个指标，v1。

## input 和 output 是什么关系

`EDS/input.xlsx` 的两个原始工作表共有 4,651 行报警明细。`EDS/output.xlsx` 是这些报警按固定规则生成的报告，不是另一张生产投入/产出事实表，两者不做明细 JOIN。

来源说明为 `EDS/EDS飞达异常统计_程序生成规则.md`。本例读取 output 的隐藏完整异常名、线体和通道映射及日期/班次；数值计算仅使用 input，output 的缓存数值只作对照。原件保持不变。

范围为 2026-08-25 白班、14 类固定异常、10 条线体、20 个通道。以完整异常文本精确匹配，文本只做 NFKC 和两端空白处理，不合并有业务含义的内部空格。每条命中记录一行，保留来源工作表和 Excel 行号；不擅自删除重复报警，不加入 SUM/TTL 汇总行。

## 语义口径

| 标识 | 业务含义 | 来源与计算 |
| --- | --- | --- |
| `report_date` / `work_shift` | 工作日 / 班次 | `work_date` / `shift` |
| `work_area` / `line_name` | 区域 / 报表显示线体 | `area` / `line` |
| `channel_name` / `issue_name` | 通道 / 异常类型 | `channel` / `issue` |
| `alarm_count` | 异常次数 | `SUM(occurrences)`；每条事实为 1 |
| `alarm_minutes` | 累计异常分钟 | `SUM(duration_minutes)`；原始秒数 / 60，不提前舍入 |
| `alarm_seconds` | 累计异常秒数 | `SUM(duration_seconds)` |

关系为：原始 Excel → Notebook Python 筛选与映射 → 293 行事实 Dataset 快照 → 语义模型 → semanticQuery → 表格 / 图表 / AI 解释。

累计报警时长可能包含不同设备或同一设备重叠报警，不能当作净停机时间、停机率或产能损失。事实表没有零次报警行；对照固定报表时才对缺失组合补零。当前语义层是单表模型，不代表已实现多模型 join graph。

## 本次已经验证

- bundled Python 独立只读计算：293 条事实、293 次、231.7773166667 分钟；560/560 核心格、660/660 完整报告格一致，差异 0。7 类无效日期均拒绝。
- 在 3001 用现有 Python 单元实际运行同一提取和对照代码，取得相同结果；通过“保存为 Dataset”保存事实表，并保留原始工作簿，源文件与项目副本逐字节相同。
- 正常语义模型 UI 创建、预览与保存；实际运行 `Data → semanticQuery → table/chart`，10 条线体合计与事实控制值相同。
- 现有 EDS 原生分析器另作独立验证：设置原件路径后运行 `npx --no-install vitest run core/eds/server/real-workbook.acceptance.test.ts -t '只读解析原始材料' --maxWorkers=1`，1 项通过，2 项因名称筛选未运行。
- 派生结果默认 AI `pending`，本次仅通过已有 `/api/datasets/:id/consent` 接口选择 `exclude-sensitive-samples`。该事实表没有被标记的敏感字段。共享的 output 参考表随后通过现有 UI 选择“排除敏感样本”；仅作用于此案例副本，不改用户已有项目或全局权限。
- 真实 DSH / `deepseek-v4-pro` 第一轮：6 次模型、6 次工具调用，19.562 秒；`cellSearch ×3 → editNotebookCells → runNotebookCells → submitNotebookDraft` 全部成功。保留原有 5 单元，新增指定模型 v1 的总计语义查询与表格，7 单元试运行通过；经过正常 UI 采用并重跑。未用 SQL / Python 替代语义查询；执行器将语义定义编译为本地数据配方，不是数据库 SQL。
- 第一轮仅返回“草稿已生成”的交付语，没有数值解释。因此在同一会话独立追问“请根据现有结果给出一个分析结论。”：5 次模型、4 次工具调用，12.505 秒；`cellSearch → runNotebookCells → cellSearch ×2` 全部成功，读取本轮有效输出，完成只读回答，不编辑或提交草稿。总计、10 条线体数值及前三条线体 184 / 293 ≈ 62.80% 均与独立重算一致。解释偏差见下方，不能把 `verification: passed` 当作逐句业务审查。
- 通过现有 UI 另加“案例复核：AI 结论的适用边界”说明，明确不是原始对话回答。最终 8 单元重新执行全部成功。新浏览器上下文重开项目后，模型完整定义、全部单元定义、采用草稿 ID 均保持，重新运行仍为 293 次 / 231.7773166667 分钟 / 13906.639 秒；同一任务 ID 下的成功回答逐字保存。页面和意外写入守卫错误为 0。
- 本次实际消耗模型的任务共 2 个，合计 11 次模型、10 次工具调用；没有自动收费重试。Token / 账单金额未完整核账，不能报为零费用。

最终驱动命令在 `site/` 执行：`node scripts/create-eds-semantic-case.mjs prepare`、`model`、显式 `--ai 3`、`adopt`、`--explain`、`review`、`verify`。收费前两次服务端请求 403 与一次浏览器守卫拦截另计失败，不计为真实模型成功。`node --check scripts/create-eds-semantic-case.mjs`、`npx --no-install eslint --max-warnings 0 scripts/create-eds-semantic-case.mjs`、`git diff --check` 通过；Git 保留原有换行提示。

## 实际截图与可见范围

以下均为本次 3001 实际操作截图，主代理已逐张查看；不是设计稿或用 DOM 断言代替截图。

| 场景 | 结论 / 可见范围 | 本次截图 |
| --- | --- | --- |
| 原件提取和对照 | Python 计算的计数、时长和核对数量；最后一列位于横向视口外，完整差异 0 另由同次回执断言 | [原件对照](../../.runtime/eds-semantic-case-20260923/1790137878141-01-reconciliation.png) |
| 模型创建预览 | UI 业务维度、三项指标与预览；模型名称在上方滚动区域 | [语义模型](../../.runtime/eds-semantic-case-20260923/1790138289044-02-semantic-model.png) |
| 分组图表 | 实际语义查询生成的 10 条线体柱状图 / 表格 | [各线体图表](../../.runtime/eds-semantic-case-20260923/1790138374283-03-semantic-chart.png) |
| 草稿真实执行 | 检索、编辑、7 单元运行、提交与验证成功，采用前待确认 | [建稿工具链](../../.runtime/eds-semantic-case-20260923/1790139216649-05-real-ai-trace.png) |
| 只读追问 | 同会话重新运行和读取有效结果，无编辑 / 提交 | [追问工具链](../../.runtime/eds-semantic-case-20260923/1790139375920-05-real-ai-trace.png) |
| 保存后重开 | 正式总计表 293 / 231.7773 / 13906.639，末位浮点误差未提前舍入 | [重开结果](../../.runtime/eds-semantic-case-20260923/1790139640853-07-reopened-case.png) |
| 保存后 AI 回答 | 总体数值和部分线体；完整长答案不在单屏，另有下半段 | [回答上半段](../../.runtime/eds-semantic-case-20260923/1790139640853-10-reopened-ai-totals.png)、[结论与口径](../../.runtime/eds-semantic-case-20260923/1790139640853-08-reopened-ai-conclusion.png) |
| 独立复核 | 保留真实原回答，额外说明两处过度解释与口径边界 | [案例复核备注](../../.runtime/eds-semantic-case-20260923/1790139617697-09-independent-review-note.png) |

模型第一次建稿后的总计截图定位曾误选侧栏 article，实际显示 Notebook 首屏；不将那些截图称为总计表验收。最终使用明确表格单元定位。未为取消场景发起额外任务，本次没有取消验收。

## 保留的限制与问题

- 模型绑定持久 Dataset 快照。更换文件、日期或规则后，应重跑提取、重新保存，再明确绑定新 Dataset；不是自动刷新关系。
- 当前模型指标 key 全部与原始字段同名、导致源字段选择和最终输出选择完全相同时，预览会报“语义完全重复的配方步骤”。本例使用独立业务标识规避，未修改底层校验或虚报问题已修复。
- Python 结果可出现 `pending` 但无敏感字段，此时数据详情没有确认按钮。本次使用相同正常授权 API 完成，仅限自建案例；未绕过服务端策略。这个 UI 缺口仍保留。
- 共享目录中的参考表会进入 Notebook sourceIds，服务端预检会核对全部来源，即便当前语义模型只使用事实表。故 output 未授权时返回 403。本次用现有 UI 确认该副本的排除敏感样本策略；未修改整文档预检规则。
- output 的首行是报表标题而非关系表字段，普通导入的 output 数据表仅用于保留原件，不作为 AI 指标来源。真正事实表由有明确字段和类型的 Notebook 结果生成。
- AI 追问中“报警少，表现明显优于其他线体”缺少开机时长、产量和采集覆盖依据；“每次短时 / 单次更长”应限定为平均每条报警时长（A5FSL06 约 31.83 秒、A5FSL01 约 59.24 秒），不能推断每次报警或真实故障时长。本次通过独立复核单元说明，没有改写原始回答或再次收费美化答案。
- 当前成功回答格式化不支持 Markdown 表格，AI 列出的十行仍以竖线文本显示；正式 Notebook 表格和图表正常。此次没有借案例建设修改产品渲染。
- 3000 未发布；未测试外部数据库、Excel 桌面应用重算或完整产品回归。没有产品源码变更，不运行无关全量构建 / 类型检查。

## 执行记录位置

专用驱动：`site/scripts/create-eds-semantic-case.mjs`，只操作该案例项目；真实模型入口为显式 `--ai` / `--explain`，真实发送前独占标记禁止同一收费步骤自动重试。`adopt` 从已保存真实回执继续 UI 采用，不重发模型。辅助代码也已保存在项目 Notebook，不依赖浏览器缓存；脚本 prepare 的本机辅助 Python 位于本次 `.runtime` 目录，脚本不是可脱离这些材料的通用导入器。

本地证据：`site/.runtime/eds-semantic-case-20260923/`，包含分阶段回执和截图。准备过程中发生的驱动定位、提示层、multipart 断言错误保留为失败记录，不计为产品验收通过；没有删改原件。真实 AI 前的首次请求被驱动“只能有一个 sourceId”断言拦截，未发送到服务端；项目共享目录实际包含三个已登记 Dataset，后续检查改为验证目标模型、选中事实来源及其包含关系。

另有两次 output 未授权的 403 请求，尚未进入模型；授权后第一次真实建稿成功，驱动在展开多层 summary 时定位不唯一，修复为首层后从原回执继续采用，没有重复收费。真实回执分别为 `real-public-task.json` / `real-explanation-task.json`，最后重开验收为 `report-verify-1790139640853.json`。

本次使用电子表格技能的只读检查流程，重点核对明细粒度、日期、重复报警、汇总层级和精度。无 Excel 文件编辑 / 导出；没有产品执行架构或视觉样式修改，不将其他会话的并行功能改动计入本案例。

分支仍为 `feature/eds-analysis-dashboard`，原有及并行未提交内容保留。本次仅新增此报告、专用驱动，追加任务日志并保留本地项目 / 证据；无暂存、提交、推送、删除或服务启停。三站均健康，supervisor / 服务 PID、worker、revision、启动时间、重启数与开场一致；3000 未发布。
