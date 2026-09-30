# 统一可视化 B1：独立计算与结果核验

日期：2026-09-29。**模块源码已实现并隔离验证；没有新增产品页面，没有接入正式 Notebook / AI / 项目保存，未发布 3000。** 本批不是完整 B+C 单图闭环。

## 实际修改

- `core/visualization/definition.ts` / `capabilities.ts`：宿主与厂商无关的 V2 定义，区分 data / encoding / presentation。一个指标、最多两个维度、柱 / 线 / 面积；旧图定义未动。
- `plan.ts`：从完整 typed DataTable 编译白名单 SQL；字段引用、真实纯日期、类型和安全数值校验。聚合前枚举 / 数值范围筛选、稳定排序、显式 Top N；rows 保持输入序、不聚合，Tooltip 不增加分组。
- `server/execute.ts` / `result.ts`：经宿主授权的完整上游＋本次引用＋查询端口，只计算一次。核对运行 / 修订 / user 或 ai 模式、输入内容 hash、行数、完整性；结果含定义 / 表格 hash、来源 ID、行数和数值模式，取消 / 过期 / 错配 / 截断拒绝。没有新增全局仓库、授权通道或缓存；hash 是一致性检查，不是签名。
- `adapters/graphic-walker.ts` / `materialized-workflow.ts`：只在适配层依赖 GW 公共接口，禁止渲染请求再做业务聚合 / 筛选 / 日期变换 / 排序 / 切片。保留主题和系列能力，不修改 `node_modules`。
- 新增 4 个测试文件、一个合成数据 fixture、一个架构边界测试；指纹守卫纳入 `core/visualization`，对应守卫自测覆盖新增目录漂移。架构主文档、提案 / 索引和视觉规范同步。

## 实测计算语义

使用现有 `executeNotebookSql` / DuckDB WASM 的真实有界子进程，不是 mock SQL；来源是明确模拟销售数据，不访问用户项目或外部数据库。

- 季度与客户类型分组，6 条明细输出 4 条结果：Q1 个人 80 / 企业 150，Q2 个人 160 / 企业 300；季度总量分别 230、460。
- 1,250 条明细各 2，输出汇总 2,500，未只计算前 100 行预览。
- sum / mean / min / max / median；COUNT(*) 计全部行，COUNT(field) 与 distinctCount 排除 NULL。实际 NULL 与文字 `NULL` 不合并。
- UTC 纯 DATE 的年 / 季 / 月 / 日；无分桶纯日期仍保持 DATE 输出。非法日期和 timestamp 明确拒绝。
- 数字范围＋含单引号的中文字段值筛选；空匹配 / 空上游得到带字段的空结果。
- 降序排名、并列维度稳定排序、NULLS LAST、显式 Top N；隐式 1,001 行截断不生成正式结果。
- 原始行保留重复分类、顺序、0、负数和 NULL；不自动转为 sum。
- 安全整数 SUM 使用 DuckDB 整数中间值；超出 JS 安全整数时拒绝，`MAX_SAFE_INTEGER + 2 - MAX_SAFE_INTEGER` 得到 2。普通小数标记 `float64`，**不承诺精确十进制金额**；decimal / bigint 文本数值指标明确拒绝。
- 当前运行 / 版本 / 权限模式 / 内容 hash / 来源 / 行数错配、展示切片、结果类型错配、查询失败、前置 / 迟到取消均不能成为成功结果。JSON 往返可核验，纯样式变化不改变计算身份；不是项目保存重开的验收。

## 浏览器与截图

脚本 `scripts/verify-visualization-v2.mjs` 使用上述真实 SQL 测试生成的 JSON，在独立 Edge 上下文拦截 **3001** 的 `__visualization-v2-gate` 试验地址；没有添加正式路由或另开服务。普通用户直接打开该地址不会出现试验页。

源结果：[formal-results.json](../../.runtime/visualization-v2-20260929/formal-results.json)。最终运行：[report.json](../../.runtime/visualization-v2-20260929/browser-1790666250734/report.json)。下列 **7 张截图已实际逐张查看**，无页面异常 / 越界请求；只有记录中的 raw 投影，无业务 aggregate。真实输出数组与 SQL 结果逐行比较，未用预置画面冒充执行。

| 场景 | 截图 | 核对 |
|---|---|---|
| 季度多系列面积 | [series](../../.runtime/visualization-v2-20260929/browser-1790666250734/series.png) | 个人 / 企业、230 → 460，与结果表一致 |
| 样式切换 | [series-warm](../../.runtime/visualization-v2-20260929/browser-1790666250734/series-warm.png) | 暖色、隐藏图例 / 网格，数值不变 |
| 原始行 / 重复分类 | [raw-order](../../.runtime/visualization-v2-20260929/browser-1790666250734/raw-order.png) | Z、A、M 轴序，重复 Z 的 3 / -2 保留；柱会重叠，未宣称已完善 |
| 筛选后结果 | [filtered](../../.runtime/visualization-v2-20260929/browser-1790666250734/filtered.png) | O'Reilly = 30 |
| 指标排名 | [rank](../../.runtime/visualization-v2-20260929/browser-1790666250734/rank.png) | Z 30、A 21、M 21，未按默认字母排序 |
| 无匹配结果 | [empty](../../.runtime/visualization-v2-20260929/browser-1790666250734/empty.png) | 空状态，不保留上一图 |
| 过期修订 | [stale](../../.runtime/visualization-v2-20260929/browser-1790666250734/stale.png) | 拒绝不一致结果，不展示成功图 |

首轮试验在排名场景发现**测试证据持有可变定义引用**：后续测试删除 Top N，导致已计算结果与保存的定义不匹配；新核验正确拒绝。已将测试证据改为深拷贝再重跑，未放宽核验。失败证据保留在 `browser-1790665963101/failure.png` / report；该失败不计通过。中间版本截图 `browser-1790666057929` 不作为最终版本唯一证据。

## 检查结果

- 定向 4 文件 / 96 项通过（定义 / 执行 / 真实 DuckDB / 架构边界，当时尚未新增 7 项 workflow 检查）。
- 最终 `npm test -- --maxWorkers=2`：**297 文件 / 3,749 项通过，1 文件 / 3 项既有实库检查跳过**；随后 26 项工具测试通过。[完整日志](../../.runtime/visualization-v2-20260929/full-tests.log)。本批新增 67 项可视化测试及 1 项架构边界测试。
- `npm run typecheck`、本批所有新增 / 改动代码与脚本的定向 ESLint、`npm run build` 通过。[构建日志](../../.runtime/visualization-v2-20260929/build.log)保留大 chunk / 插件耗时提示；未声称消除既有体积问题。已跟踪修改 diff 空白检查通过，仅 CRLF 提示。
- 架构守卫自测 1 项通过；同步 / 检查 266 个源码文件。
- `site:status` 前后 3000 / 3001 / 3198 健康，PID / workerPid / revision / 重启数不变（stable 17416 / 17248 / 0，dev 45108 / 42976 / 1，capture 17576 / 17464 / 0）。构建没有发布或重启任何站点。

## 启用边界与下一步

1. `productEnabled: false` 是能力目录状态，不是可自行打开的实验开关。本批没有替换当前 `ChartCanvas` 的浏览器计算，也没有修改 Notebook 回执 / Cell Schema / 保存版本。原 Harness、DSH、用户项目、旧图与既有未提交修改保留。
2. 接下来先验证项目版本升级、未知版本拒写与旧图兼容，再接 Notebook 完整 outputs → V2 执行 → 当前回执 → 统一图表视图 / 编辑。迁移必须保留 rows 语义、取消不写入，不能自动将旧图改为 sum。
3. 首批渲染 X 轴仅非空文本 / 纯日期，使用离散尺度；计算层可保留的空值 / 数字分类暂不进入该适配器。不做 NULL 字符串替换。季度显示桶起始 ISO 日期、字号与标签角度仍待产品层改善；没有复现 Hex 完整布局或连续时间轴。
4. 多指标、分面、timestamp / DST、精确 decimal 金额、跨页面保存、AI 共用新契约、看板快照 / 多图报告均不算完成。本批无需要修改 GW 源码才能交付的功能；上述限制仍需单独验证，不据此声称必须 fork。
5. 无依赖安装、模型调用、外部实库调用、删除文件、Git 提交 / 推送 / 合并、稳定发布或服务启停。截图页面仅用模拟数据；完整工作流与模型质量留待产品接线后验收。
