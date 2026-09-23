# Python 原始文件逐行输入修复 · 2026-09-23

## 范围与证据

承接“继续”，本批只修复 Notebook Python 原始文件输入框吞掉换行的问题；不新增或规划 M8 及后续阶段，不发布 3000。开工 88 项 Git 未提交状态作为基线保留。

`components/studio/notebook/NotebookCellEditor.tsx` 原实现每次输入都执行 `split(/\r?\n/u).filter(Boolean)`，再用 `join("\n")` 渲染。首个文件名后按 Enter，尾部空项立即被过滤；随后键入第二个文件名会拼到第一项上。只读提取实际处理器执行已复现；整段粘贴多行可用，不能据此认为逐行键入正常。

选定方案：由表单局部字符串保存尚未提交的文件名文本，提交时才按原规则拆分；之后仍通过唯一的 `notebookCellSchema` 校验。不 trim 文件名，不改变空行过滤、最多 3 项、禁止重复 / 路径 / 非 CSV-XLSX 的规则。表单草稿不进入正式 Notebook、Agent Context 或持久化，取消沿用原行为。文件授权和原件解析仍归服务端，不因表单输入授予访问权。

## 工作记录

- 基线 `npm run typecheck` 通过；组件 / 源码展示两个测试文件 33 项通过。基线命令另带了不存在的 `core/notebook/python.test.ts` 路径，Vitest 实际只运行上述两个匹配文件，不将其记作 Python Runtime 验证。
- `NotebookCellEditor.test.tsx` 增加 4 项 SSR 契约：两种模式逐行保留原名、可选空列表、禁用保存而允许取消；该文件 10 项通过。SSR 不验证键盘输入，真实交互另由 3001 浏览器脚本验证。
- 修前 3001 已真实逐字输入、按 Enter、再逐字输入第二个名称，确认变成单项 `first.csvsecond.csv`；没有保存错误定义或执行。修前截图已由浏览器代理及主代理实际查看。
- 生产修复仅编辑器三处：初始化 `fileNamesSource`、输入原样更新、提交时才拆分。保留上一批数字草稿保护，不更改其他单元的保存分支。新增浏览器脚本 `scripts/verify-python-files-editor-browser.mjs`，同步架构正文 / 变更记录和视觉规范，无 Schema 或服务端修改。

## 3001 真实验收

运行 `node scripts/verify-python-files-editor-browser.mjs --red` 和修复后的 `node scripts/verify-python-files-editor-browser.mjs`。一轮 RED、一轮 GREEN，无失败重跑；两个自有合成项目，不读取用户项目。目录列表为空替身，模型请求与外部网络被阻止，项目导入 / 保存、Python 状态与执行使用真实 3001 接口。

GREEN 10 组检查通过：键盘逐行输入两个名称；前 / 中 / 后空行与浏览器归一后的 CRLF 编辑保留、保存过滤；正反斜杠路径、重复、四文件、非支持扩展名、纯空格行拒绝。失败保留可修改的错误文本，已保存定义和运行次数不变；取消恢复原两项，空列表能保存为 `[]`，刷新后文件名与代码完整保留。

两个合成 CSV 分别含 10 / 20 与 7，真实 `pd.read_csv(files[...])` 后合并。保存后和刷新后两次 Python 运行均成功，逐值核对三行、合计 37；没有模型、外部数据库、页面或路由异常。刷新后的旧结果不作为当前运行，保持原行为。

修前 1 图与修后 5 图均由浏览器代理和主代理逐张实际查看：

| 场景 | 本次截图 |
| --- | --- |
| 修前 Enter 消失，1440 | [RED](../../.runtime/python-files-editor-browser-20260923/red-1790133944827/01-enter-newline-lost-1440.png) |
| 修后键盘输入两行，1440 | [两行文件名](../../.runtime/python-files-editor-browser-20260923/green-1790133995647/01-keyboard-two-lines-1440.png) |
| 两份原件真实运行，1440 | [三行结果](../../.runtime/python-files-editor-browser-20260923/green-1790133995647/02-real-two-csv-success-1440.png) |
| 重复拒绝，1024 | [错误与原结果](../../.runtime/python-files-editor-browser-20260923/green-1790133995647/03-duplicate-save-rejected-1024.png) |
| 取消后重开，1024 | [恢复原两项](../../.runtime/python-files-editor-browser-20260923/green-1790133995647/04-cancel-restores-file-names-1024.png) |
| 刷新后重开，1024 | [保存定义恢复](../../.runtime/python-files-editor-browser-20260923/green-1790133995647/05-refresh-reopened-two-files-1024.png) |

截图不单独证明按键历史、完整源码或无网络请求，这些由同次断言和请求记录核对。03 图文件框顶部被滚动裁切，05 图源码与编辑按钮未入图，不声称全部同屏。详见[逐图结论](../../.runtime/python-files-editor-browser-20260923/visual-review.md)与[实际运行报告](../../.runtime/python-files-editor-browser-20260923/green-1790133995647/report.json)。

## 检查结果

| 命令 | 结果 |
| --- | --- |
| `npx vitest run components/studio/notebook/NotebookCellEditor.test.tsx components/studio/notebook/cell-source.test.tsx core/notebook/definition.test.ts components/studio/notebook/RecipeNumberInput.test.tsx --maxWorkers=2` | 4 文件 / 97 项通过，含上一批数字保护回归 |
| `npm test -- --maxWorkers=2` | 267 文件通过 / 1 跳过；3277 项应用测试通过 / 3 既有跳过；另 26 项 Node 工具测试通过 |
| `npm run typecheck` | 基线与构建后均通过 |
| `npx eslint components/studio/notebook/NotebookCellEditor.tsx components/studio/notebook/NotebookCellEditor.test.tsx scripts/verify-python-files-editor-browser.mjs --max-warnings=0` | 通过 |
| `node --check scripts/verify-python-files-editor-browser.mjs` | 通过 |
| `npm run build` | 退出 0；保留既有大于 500 kB 分块提示 |
| `npm run docs:agent:sync` / `npm run docs:agent:check` | 正文与变更记录同步后，209 个源码文件指纹一致 |
| `git diff --check` | 通过；既有 LF / CRLF 提示不改换行策略 |

独立只读审阅未发现本批新增回归：其他字段修改不覆盖文件名文本，取消由编辑器卸载丢弃草稿，输出改名审阅接收完整校验后候选，禁用与代码模式沿用原机制。另执行两文件 59 项、两文件严格 ESLint 和 `npx tsc --noEmit --incremental false`，均通过；不与主检查相加。

日志：[定向](../../.runtime/python-files-targeted-final.log)、[全量](../../.runtime/python-files-full-tests-final.log)、[构建](../../.runtime/python-files-build-final.log)、[构建后类型](../../.runtime/python-files-typecheck-postbuild.log)。

## 状态与边界

源码 / 3001 已验收，3000 未发布。前后 `npm run site:status` 核对三站健康，supervisor 和服务 PID / worker / revision / 启动时间 / 重启数 / 稳定 release 全部未变，无服务操作。分支 `feature/eds-analysis-dashboard`、HEAD 保持，88 项原改动保留，本批新增脚本与报告后共 90 项未提交状态；没有暂存 / 提交 / 推送或分支操作。

没有实际模型费用、外部实库、XLSX 原件读取、手机或全站重验；本批只验证合成 CSV 多原件链路。已有 Python 限额、运行沙箱、原件权限、SDK 风险与构建分块警告保留。原有 Schema 错误仍以现有形式展示，未扩展成新错误文案系统。证据与两个自有合成项目保留在原忽略目录，没有清理用户数据。
