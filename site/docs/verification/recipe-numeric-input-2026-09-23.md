# 配方数字输入与保存保护 · 2026-09-23

## 本批范围

继续维护已实现的 Notebook，不新增或规划 M8 及后续阶段。只修复数字筛选、计算常量及限制行数的表单输入；不改领域 Schema、DataRecipe 执行、API、持久化格式、模型或数据库实现。

原 `RecipeStepsEditor.tsx` 在输入事件中直接 `Number(event.target.value)`，清空后变为 `0`。独立只读执行原组件事件及原 Schema 确认：筛选 5 → 空、乘法常量 5 → 空均被转换为合法 0；限制行数也变为 0，但由 `min(1)` 拒绝，不能称为成功误保存。原 `NotebookParameterEditor` 已有空数字保护，不重复改动。

先前候选“逗号列名开编辑后损坏”已否定：本项目 table / chart 字段 Schema 和导入规范化仅允许既有 ASCII 标识，不为不成立的候选增加新输入语法。

## 实施边界

- 小型 UI 数字组件保留原始字符串，仅完整、有限且满足该控件范围的数字进入表单配方草稿；空值不补零，不生成 NaN / Infinity。
- 保存与表单 → 规则代码转换必须检查无效数字草稿，不能静默借用上一个合法值。显式取消、切换字段类型或删除步骤仍沿用原交互。
- 保留数值 0、负数、小数、科学计数；配方仍为有限浮点，不借此引入精确十进制或参数单元的 MAX_SAFE 限制。行数仍为 1–10,000 整数。
- 本批修改前 81 项既有 Git 状态保留；只在 3001 验证，不发布或操作 3000，不提交 / 推送或启停服务。

## 验证记录

基线 `npm run typecheck` 与原三个组件测试文件 60 项通过。新增 `RecipeNumberInput.test.tsx` 并扩展 `NotebookCellEditor.test.tsx`：接线前 49 项中 3 项预期失败；补充范围边界并接线后两文件 55 项、相关四文件 111 项通过，共新增 51 项。覆盖空 / 部分数字、有限数值范围、指数、零 / 负数 / 小数、整数上下界、非数字输入不受影响、禁用状态与父编辑器接线。单测是纯函数 / SSR，不以它冒充浏览器连续输入。

新增 `scripts/verify-recipe-numeric-input-browser.mjs`，独立创建本轮合成 CSV 项目，经真实页面、项目保存和 Notebook 本地执行。修前 RED 已实际复现：2.5 清空立即成为 0，保存后结果从 2 行变为 3 行，误包含 zero；2 张截图由浏览器代理和主代理实际查看。修前输入图底部按钮在滚动区外，保存成功由后续结果图和真实定义断言证明，不冒称所有控件同屏可见。

## 最终检查

| 实际命令 | 结果 |
| --- | --- |
| `npx vitest run components/studio/notebook/RecipeNumberInput.test.tsx components/studio/notebook/NotebookCellEditor.test.tsx components/studio/notebook/NotebookParameterEditor.test.tsx components/studio/notebook/cell-source.test.tsx --maxWorkers=2` | 4 文件 / 111 项通过 |
| `npm test -- --maxWorkers=2` | 267 文件通过 / 1 跳过；3273 项通过 / 3 既有跳过；另 26 项 Node 工具单测全部通过 |
| `npm run typecheck` | 基线、修改后及构建后通过 |
| `npx eslint`（三生产文件、两测试文件及新浏览器脚本）`--max-warnings=0` | 通过 |
| `node --check scripts/verify-recipe-numeric-input-browser.mjs` | 通过 |
| `npm run build` | 退出 0；保留既有大于 500 kB 分块警告 |
| `npm run docs:agent:sync` / `npm run docs:agent:check` | 架构正文 / 变更记录已维护，209 个源码文件指纹一致 |

独立审阅另运行两测试文件 55 项、`npx tsc --noEmit --pretty false` 和严格 ESLint，均通过；生产 diff 未发现未处理回归。不通过新增依赖、关闭检查或修改领域约束来通过测试。[全量日志](../../.runtime/recipe-numeric-full-tests-final.log)、[构建日志](../../.runtime/recipe-numeric-build-final.log)、[类型日志](../../.runtime/recipe-numeric-typecheck-postbuild.log)、[定向日志](../../.runtime/recipe-numeric-targeted-working.log)。

## 3001 实际验收与截图

最终运行 `node scripts/verify-recipe-numeric-input-browser.mjs`：7 组检查、8 次真实本地 Notebook 运行通过，页面 / 路由异常及 AI 请求均为 0。真实 CSV 导入、Data → Transform、定义保存及刷新重开，不替换配方执行结果。合成项目与用户项目隔离，连接目录为空替身，不连接真实外部数据库。

空值、原生未完成指数 `1e`、单独负号，左右常量空值，行数空 / 0 / 负 / 小数 / 超界：原生保存、直接派发 submit、转规则代码均拒绝，正式定义及运行次数保持。修正为合法 0、-5、2.5、1e1 后能保存运行；1e1 在 JSON 中保存为数字 10。常量 -2.5 和 0 经表单 / 代码往返保真；最终筛选 2.5 → 乘 -2.5 → 限制 1 行，结果 adjusted=-6.25。无效草稿跟随步骤重排，删除或改类型解除阻塞；数字筛选改文本 / 布尔沿用原有类型值。取消仍保留完整已保存定义，刷新后代码与定义逐值一致，重新运行仍为 -6.25。

下列修前 2 图与最终修后 7 图均由浏览器代理及主代理逐张实际查看；不是设计稿或仅 DOM 断言。UI 保持既有暖白样式，错误说明和保存 / 取消入口可读。

| 场景 | 实际截图 |
| --- | --- |
| 修前清空变 0 / 误存后增加 zero 行 | [输入](../../.runtime/recipe-numeric-input-2026-09-23/red-1790132857509/01-cleared-filter-became-zero-1440.png)、[错误结果](../../.runtime/recipe-numeric-input-2026-09-23/red-1790132857509/02-unintended-zero-saved-and-run-1440.png) |
| 修后空数字拒绝保存 / 转代码，1440 | [01](../../.runtime/recipe-numeric-input-2026-09-23/green-1790133130377/01-empty-filter-blocked-1440.png) |
| 未完成指数与明确提示，1024 | [02](../../.runtime/recipe-numeric-input-2026-09-23/green-1790133130377/02-incomplete-exponent-blocked-1024.png) |
| 取消保留原两行结果，1024 | [03](../../.runtime/recipe-numeric-input-2026-09-23/green-1790133130377/03-cancel-preserves-saved-result-1024.png) |
| 修正小数后真实运行成功，1440 | [04](../../.runtime/recipe-numeric-input-2026-09-23/green-1790133130377/04-corrected-decimal-real-success-1440.png) |
| 空计算常量拒绝，1440 | [05](../../.runtime/recipe-numeric-input-2026-09-23/green-1790133130377/05-empty-calculation-constant-blocked-1440.png) |
| 超界行数拒绝，1024 | [06](../../.runtime/recipe-numeric-input-2026-09-23/green-1790133130377/06-invalid-limit-blocked-1024.png) |
| 重开规则代码，1024 | [07](../../.runtime/recipe-numeric-input-2026-09-23/green-1790133130377/07-refresh-reopened-rule-code-1024.png) |

完整[机器报告](../../.runtime/recipe-numeric-input-2026-09-23/green-1790133130377/report.json)及[逐图说明与分轮记录](../../.runtime/recipe-numeric-input-2026-09-23/visual-review.md)。07 仅显示长代码开头，后三项数值由完整 JSON 相等 / 逐字段断言证明，不称为全源码同屏。保存次数与无隐式执行由同次断言证明；截图本身不证明无网络请求。取消的是当前编辑，不是撤销原先已新增的默认单元。

各轮共 6 个自有合成项目、18 次本地运行，均保留：修前准备 3 次脚本问题分别为新项目尚无 state、条件选择框的隐式标签含选项文本导致精确定位失败、验收 helper 误把 notebooks 对象当数组；修正脚本后红灯 2 次运行真实复现。首轮绿灯 7 次、补充指数与类型切换后的最终绿灯 8 次通过。失败轮 4 图及中间绿灯 7 图也由浏览器代理查看，不计为主代理复看的最终 9 图；未因准备脚本失败改产品行为或弱化断言。

## 工作区与未验证项

分支仍为 `feature/eds-analysis-dashboard`，原有 81 项改动保留，本批增加三项已跟踪文件修改和四个新文件，收尾 88 项未提交状态；没有 Git 暂存 / 提交 / 推送、分支切换或删除。新增组件属于 Notebook UI，无服务端 SDK / 凭据导入；配方执行器与公共数据类型未改动。

源码 / 3001 已验收，3000 未发布。前后 `npm run site:status` 比较三站健康，PID / worker、revision、启动时间、重启数、稳定 release 及 supervisor 均未变。合成项目和截图保留在本机既有忽略目录，没有清理用户数据。

没有真实模型费用或外部实库重验，没有验收手机、全部浏览器和其他所有表单。配方仍使用浮点数，不承诺精确金额 / 大整数；既有 SDK 风险和大分块警告没有在本批解决。不新增功能阶段，未规划 M8 或后续里程碑。
