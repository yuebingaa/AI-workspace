# Notebook 预览缺值与 CSV 一致性 · 2026-09-23

## 本批范围与基线

继续维护既有功能，不新增或规划 M8 及后续阶段，不发布 3000。开工保留 90 项已有 Git 改动。表单错误 JSON 文案只是候选，本批不处理；选定更直接的数据展示问题后不扩展范围。

`core/notebook/table-preview.ts` 排序与 `components/studio/notebook/NotebookResultTable.tsx` 内容 / title 均直接读取 `row[field.name]`。`DataTable` 契约允许 `toString`、`constructor`、`__proto__` 等名称，也允许某行缺少所声明字段；缺失时读取到对象继承的函数或对象，错误显示为数据并参与排序。已有 CSV 序列化使用 `Object.hasOwn`，同一缺值导出为空，因此预览与导出不一致。

只读加载实际 Schema、排序与 React SSR 已复现：合法缺值行显示内置函数或 `[object Object]`，且在升序时排在真正文本值之前。此项属于继承属性被误作数据，不声称发生了原型污染或远程代码执行。

选定修改仅限表格预览：共用自有字段读取函数，缺失值依旧按 NULL 显示并稳定排在升降序最后；合法自有特殊字段和值保留。CSV、安全前缀、Schema、运行 / 查询、结果引用与持久化协议不变。浏览器使用明确合成回执验证稀疏结果，不冒称真实 SQL / Python 会生成这种数据。

基线 `npm run typecheck` 通过；预览、组件、CSV 三测试文件 90 项通过。新增 16 项回归后，两个预览文件 47 项中 11 失败 / 36 通过，证明原实现不能满足缺值显示 / 排序契约。7 项排序和 4 项 SSR 失败；`__proto__` 降序个例碰巧得到相同顺序，不伪称全部新用例都失败。实际命令为 `npx vitest run core/notebook/table-preview.test.ts components/studio/notebook/NotebookResultTable.test.tsx --maxWorkers=2`，日志保留在[修前结果](../../.runtime/preview-own-tests-red.log)。

独立完整 `notebookRunSchema.parse` 合成成功回执确认：四种特殊字段缺值都可通过客户端原校验，`NotebookPanel` 将回执表传入真实结果组件，因此不是只能用非法组件参数触发。另一方面，原 Schema 的 record 克隆会剔除自有 `__proto__`，该上游行为未修改；纯预览 / SSR 可证明自有 `__proto__` 保留，浏览器经 Schema 的这类字段只验证缺值正确显示，不声称全链保真。其余三种自有特殊字段可正常经过 Schema。

## 实际实现

- `core/notebook/table-preview.ts` 新增纯 `notebookPreviewValue`，只读 `Object.hasOwn` 的字段；既有比较器和稳定排序保持，缺失字段按 undefined / NULL 路径处理。
- `components/studio/notebook/NotebookResultTable.tsx` 的正文与 title 使用同一读取函数，空文本 / 0 / false 不被误当空值。
- 两个对应测试文件增加 16 项回归；新增 `scripts/verify-preview-own-values-browser.mjs`，维护架构正文 / 变更记录与视觉规范。没有新目录层、依赖、服务端适配或 API。
- 独立只读复核通过，两预览文件 47 项全绿、四文件严格 ESLint 通过，原 11 个失败均被修复；冻结输入对象验证无变更。独立检查与下表范围有重叠，不重复累计。

## 验证结果

| 实际命令 | 结果 |
| --- | --- |
| `npx vitest run core/notebook/table-preview.test.ts components/studio/notebook/NotebookResultTable.test.tsx core/exports/table-csv.test.ts --maxWorkers=2` | 3 文件 / 106 项通过 |
| `npm test -- --maxWorkers=2` | 267 文件通过 / 1 跳过；3293 项应用测试通过 / 3 既有跳过；另 26 项 Node 工具测试通过 |
| `npm run typecheck` | 基线和构建后均通过 |
| `npx eslint core/notebook/table-preview.ts core/notebook/table-preview.test.ts components/studio/notebook/NotebookResultTable.tsx components/studio/notebook/NotebookResultTable.test.tsx scripts/verify-preview-own-values-browser.mjs --max-warnings=0` | 通过 |
| `node --check scripts/verify-preview-own-values-browser.mjs` | 通过 |
| `npm run build` | 退出 0，保留既有大于 500 kB 分块提示 |
| `npm run docs:agent:sync` / `npm run docs:agent:check` | 已维护正文 / 变更记录，209 个源码文件指纹一致 |
| `git diff --check` | 通过，既有 LF / CRLF 提示保留 |

日志：[定向测试](../../.runtime/preview-own-targeted-final.log)、[全量测试](../../.runtime/preview-own-full-tests-final.log)、[构建](../../.runtime/preview-own-build-final.log)、[构建后类型](../../.runtime/preview-own-typecheck-postbuild.log)。

## 3001 浏览器与下载验收

运行 `node scripts/verify-preview-own-values-browser.mjs --red` 与修复后的无参数命令。独立浏览器 / 临时 localStorage，合法参数单元经真实页面建立；运行接口为明确替身，返回 25 行稀疏表，经原 Schema、缓存和结果组件展示。页面说明此为合成回执、没有真实参数 / SQL / Python 计算。所有 API 都被明确替换或阻断，没有真实项目读写、模型 / 数据库请求。

RED 一组确认内置函数 / 对象显示为数据。GREEN 五组通过：四种特殊字段缺值及 title 为 NULL；其余三种自有字段保留；四种特殊列升 / 降 / 原序往返和 20 + 5 行分页；缺值与显式 null 稳定排在末尾。纯函数 / SSR 另覆盖自有 `__proto__`、0、false、空文本，但不冒称经过浏览器 Schema 的自有 `__proto__` 已保真。

实际下载两份 CSV，各含全部 25 行而非当前页 5 行；逐字节核对 BOM、引号、CRLF、字段 / 行顺序和空值。公式样文本 `=1+1` 在页面按文本显示，CSV 保留原有单引号保护；没有启动电子表格软件，不能证明所有外部软件绝对安全。注入浏览器 object URL 分配失败后，预览保持、错误与重试入口可用，重试下载成功，不重新运行或请求数据。

修前 1 图与修后 5 图均由浏览器代理及主代理实际查看：

| 场景 | 截图 |
| --- | --- |
| 修前继承内容被显示为数据，1440 | [错误预览](../../.runtime/preview-own-values-2026-09-23/red-1790136041846/01-missing-fields-inherit-prototype-1440.png) |
| 修后缺值 NULL、自有文本保留，1440 | [正确预览](../../.runtime/preview-own-values-2026-09-23/green-1790136125424/01-missing-fields-null-own-values-1440.png) |
| 升序第二页空值置后，1440 | [升序](../../.runtime/preview-own-values-2026-09-23/green-1790136125424/02-ascending-null-last-page-1440.png) |
| 降序第二页空值置后，1024 | [降序](../../.runtime/preview-own-values-2026-09-23/green-1790136125424/03-descending-null-last-page-1024.png) |
| 当前预览 25 行导出成功，1024 | [成功提示](../../.runtime/preview-own-values-2026-09-23/green-1790136125424/04-csv-all-preview-success-1024.png) |
| 注入下载失败、保留预览可重试，1024 | [失败提示](../../.runtime/preview-own-values-2026-09-23/green-1790136125424/05-csv-failure-retryable-1024.png) |

首屏图片仅显示表格内部前 9 行，20 行分页与 25 行下载由同次完整断言证明，不以图片代替数据检查。浏览器[机器报告](../../.runtime/preview-own-values-2026-09-23/green-1790136125424/report.json)与[逐图记录](../../.runtime/preview-own-values-2026-09-23/visual-review.md)。

两次 RED 准备脚本失败已保留：首次 SQL 单元没有输入不满足原 Schema，改用合法参数单元；第二次改输出名触发现有确认，最终不改默认输出名。前两轮均未发运行请求，不把脚本错误归为产品故障。随后 RED 与 GREEN 各一次合成回执，GREEN 首轮通过；页面异常和意外 API / 网络请求为 0。没有为验收放宽生产 Schema 或确认机制。

## 状态与保留项

源码 / 3001 已验收，3000 未发布。分支 `feature/eds-analysis-dashboard`、HEAD 保持，90 项原修改保留，加上本批两生产文件、两测试文件、脚本和报告，共 96 项未提交状态；没有暂存 / 提交 / 推送或分支操作。截图、下载文件与运行日志留在已有忽略目录，没有删除用户数据。

前后 `npm run site:status` 比较三站健康；supervisor、服务 PID / worker / revision / 启动时间 / 重启数 / 稳定 release 全部未变。没有启停、重启或更新运行配置。开工状态日志以候选问题命名为 `notebook-editor-errors-service-before.log`，最终范围改为预览缺值后，使用 `preview-own-service-after.log` 比较，未替换开工基线。

此为预览层一致性修复，无真实模型、SQL / Python、外部数据库、用户项目、手机或全站重验。未改图表读取、原件导入或其他数据处理链，不宣称全项目所有属性读取都已审计。原 Schema 对自有 `__proto__` 的克隆行为、既有 SDK 风险与构建体积警告仍保留。

收尾发现其他任务已在统一日志追加 AI 验证接口诊断记录，已原样保留；其模型 / 配置验证不属于本批，也未作为本批功能验收证据。
