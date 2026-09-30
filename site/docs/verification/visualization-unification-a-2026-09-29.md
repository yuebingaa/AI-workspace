# 统一可视化 A 批：说明阅读与 Graphic Walker 适配门槛

日期：2026-09-29。源码 / 3001 生效，**未发布 3000；V2 图表定义与正式计算链尚未实现**。沿用旧图读取与当前编辑器，不自动迁移用户项目、不扩展看板或 AI 聊天。

## 1. 实际修改

- `NotebookRichText.tsx` 与局部 CSS 复用固定版本 `react-markdown@10.1.0` / `remark-gfm@4.0.1`（MIT），不自研 Markdown 解析器。有限标题、列表、引用、代码、GFM 表格与安全外链；禁用图片、raw HTML 和外部嵌入。接口依据[react-markdown 官方说明](https://github.com/remarkjs/react-markdown)和[remark-gfm 官方说明](https://github.com/remarkjs/remark-gfm)。只新增这两个直接依赖，GW / styled-components 是本轮前已有的工作树修改。
- `text-references.ts` 输出 markdown / literal 片段；保留原 `renderNotebookText` 字符串行为。`execution.ts` 将可信边界放入可选 `textParts`，`contracts.ts` 检查 success、无 table / resultRef、总长和拼接一致性。数据值在模板解析之后才替换到文本节点，不能生成链接、HTML、新标题、表格行列或属性。
- `NotebookTextResult` 保留未运行、失效、失败与上游阻断提示；旧回执无片段时仍纯文本。静态旧大括号不求值。`live-progress.ts` 对超过原 2000 字符展示前缀的文本去除排版片段，避免误把截断模板或数据当 Markdown。
- `NotebookTextEditor` 补充支持范围说明；不改保存 / 运行 / 权限 / 确认机制。
- 架构目录新增索引，对 9 月 11 日 `current-system-architecture.*` 加历史标识；提案补充精确金额 / 大整数转换、逐组合适配门槛、V2 首次落盘兼容门槛和 B+C 最小范围。没有搬动或删除历史文档。

## 2. 实际浏览器与截图

所有验收在隔离 Edge 上进行；使用网站管理器已有 3001，不起额外服务器。测试只新建 `.runtime` 下模拟项目，禁止读取用户项目和调用模型 / 真实数据库。可选 Leaflet CSS 外链由测试拦截，不将此写作产品已经零外联。

### 正式 Notebook 页面

运行 `node scripts/verify-notebook-rich-text.mjs`，真实本地项目读写与 Notebook 参数执行。最终[机器报告](../../.runtime/visualization-unification-20260929/notebook-1790664496289/report.json)通过，3 次运行（2 次成功、1 次预期失败），8 张截图全部实际查看：

| 页面 / 场景 | 截图 | 结论 |
|---|---|---|
| 有引用说明，未运行 | [01](../../.runtime/visualization-unification-20260929/notebook-1790664496289/01-awaiting-run.png) | 显示待运行，不伪造结论 |
| 真实参数值 → Markdown 说明 | [02](../../.runtime/visualization-unification-20260929/notebook-1790664496289/02-rich-success.png) | 标题 / 圆点列表 / 表格排版正常；恶意标记值保留在单一表格单元 |
| 编辑后取消 | [03](../../.runtime/visualization-unification-20260929/notebook-1790664496289/03-cancel-preserves-result.png) | 整个保存定义不变，原结果保留 |
| 引用字段变更 | [04](../../.runtime/visualization-unification-20260929/notebook-1790664496289/04-stale-hidden.png) | 明确失效，不显示旧结论 |
| 不存在的引用字段 | [05](../../.runtime/visualization-unification-20260929/notebook-1790664496289/05-failed-reference.png) | 真实执行失败，错误与状态清楚 |
| 刷新重开、重新运行 | [06](../../.runtime/visualization-unification-20260929/notebook-1790664496289/06-reopened-success.png) | 模板 / 引用恢复，新运行恢复排版 |
| 1024 px + 聊天侧栏 | [07](../../.runtime/visualization-unification-20260929/notebook-1790664496289/07-narrow.png) | 无整页横向溢出，表格可读 |
| 无引用旧正文 | [08](../../.runtime/visualization-unification-20260929/notebook-1790664496289/08-static-markdown.png) | 保存后直接阅读；未知大括号原样保留 |

首次截图 `notebook-1790664345239` 发现列表圆点被全局 reset 隐藏、表格字号继承过小；修复局部 CSS 后重新执行并查看上述 8 张。不把旧截图冒充修正后结果。

### GW 隔离适配试验（不是正式产品页面）

`scripts/fixtures/graphic-walker-materialized.tsx` + `scripts/verify-graphic-walker-materialized.mjs` 通过 Vite 打包独立试验；仅当前 Playwright context 在 3001 隔离地址响应夹具，产品路由未新增、服务未重启。[最终报告](../../.runtime/visualization-unification-20260929/adapter-1790664411923/report.json)记录真实 computation 请求、输入 / 输出与 SVG；6 张图全部实际查看。

| 场景 | 实测结果 | 截图 |
|---|---|---|
| 多系列堆叠面积 | 4 行物化结果不再业务聚合，Q1 合计 230、Q2 合计 460，保留企业 / 个人 | [series](../../.runtime/visualization-unification-20260929/adapter-1790664411923/series.png) |
| 水平渠道 × 垂直地区 + 多系列 | 16 行保持数值，4 个面板内各保留两系列；默认自动尺寸偏窄 | [facets](../../.runtime/visualization-unification-20260929/adapter-1790664411923/facets.png) |
| 按指标降序排名 | Z=30 → M=21 → A=12；需设置 canonical X 分类轴 sort | [rank](../../.runtime/visualization-unification-20260929/adapter-1790664411923/rank.png) |
| 保留输入序 | Z → A → M；使用公开 `scales.column.domain` | [input-order](../../.runtime/visualization-unification-20260929/adapter-1790664411923/input-order.png) |
| 重复分类 | 同一分类仍有 10 / 20 两个点，不被合计成 30 | [duplicate](../../.runtime/visualization-unification-20260929/adapter-1790664411923/duplicate.png) |
| UTC 日期 / 空值 / 零 / 负值 | 4 行保留，NULL 不转零；曲线在空值处断开，负值正常；零值为孤立线端，不产生可见点标记 | [dates-null](../../.runtime/visualization-unification-20260929/adapter-1790664411923/dates-null.png) |

公共接口通过已安装 0.5.2 的 `src/interfaces.ts`、`renderer/pureRenderer.tsx`、`models/terse.ts` 与 `vis/spec/encode.ts` 核对；未编辑 node_modules，未假设未安装 API。官方来源为 [Graphic Walker 仓库](https://github.com/Kanaries/graphic-walker)。

明确发现：`TerseSpec.sort` 赋到最后一个 Y measure，并不保证当前纵向柱图的分类轴按值排序；`sort: none` 本身仍采用字典序。试验改用已公开 canonical 分类轴 sort / scales.domain 后通过。只修正了试验适配写法，**没有冒称正式旧图编辑器已经具备这些新增排序能力**。

失败尝试保留：`adapter-1790664025251` 缺少 Vite lib 的 production 环境常量；`adapter-1790664180577` 假设存在独立 CSS 文件而加载失败；`adapter-1790664198346` 真实复现 TerseSpec 排名未生效；后两次分别验证修正和增加双向多系列分面。最终脚本只在确有 CSS 产物时引用。试验数值 / 行数和禁止 aggregate 工作流断言均通过；这不是 V2 服务端计算、金额精度或迁移等价证明。

## 3. 检查结果

- 5 个说明 / 引用 / 执行定向文件 **108 项通过**；包括安全文本、模板片段、旧回执、失效与截断进度。
- 最终 TypeScript 检查、13 个改动代码文件的定向 ESLint、生产构建通过；架构正文 / 变更记录更新后同步和检查 **259 文件**一致；diff 空白检查通过（仅 CRLF 提示）。
- `npm test -- --maxWorkers=2`：**293 文件通过、1 文件跳过；3681 项通过、3 项跳过**，随后 **26 项 Node 工具测试通过**。离线 Harness 基线是 scripted/mock，不代表真实模型质量；跳过项不计作通过。
- 依赖安装使用 `pnpm install --ignore-scripts`；保留已有 deprecated 提示与 apache-arrow 的 `arrow2csv.EXE` shim ENOENT 警告。未使用该 CLI，本次图表 computation 与 Notebook 浏览器测试通过；未声称修复该 CLI。
- 构建仍提示部分 chunk 超过 500 kB 和插件耗时；未做打包拆分或便携包 / Release 验收。未调用收费模型，因为本批验证的是确定性显示、执行回执和适配接口，不是 AI 分析质量。
- `npm run site:status` 前后 3000 / 3001 / 3198 均健康，PID、revision 和重启数保持不变；本次无服务启停 / 发布 / Git 提交 / 推送 / 合并。保留工作树已有修改，未删除用户数据或历史记录。

## 4. 仍未完成 / 下一步

本批是 A 的独立可交付部分，不是整个统一图表方案完成。下一步按 B+C 小范围实现 V2 契约、正式结果计算与单图 Notebook 保存恢复，然后再让 DSH / Harness 使用同一新建约定。首次落盘前必须验证旧客户端 / 未知版本不会丢数据。

仍需单独验证：分面正式尺寸适配、DST / 周起点 / 日期分桶、decimal / 大整数绘图、迁移 count / NULL 等价、结果 hash / 权限 / 取消 / 超时、新型图表结果表一致性。看板快照、动态 App、多度量与联合 Tooltip 未实现。不需要为了本批已验证组合修改 GW 源码，不能据此承诺所有后续组合都无需适配。
