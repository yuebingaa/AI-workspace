# Notebook Python Runtime

2026-09-16：源码已接入，开发站 `http://127.0.0.1:3001` 可用；稳定站需另行发布。Python 计算本身不调用模型 API，Agent 自动编写代码仍使用现有模型配置。

在 Notebook 点击“Python”，填写输出表名和代码，保存后运行。环境预置 `pd`（pandas）、`np`（NumPy），输出必须是 `pandas.DataFrame`：

```python
result = pd.DataFrame({'station': ['EDS', 'Coat'], 'minutes': [3, 0.5]})
print(result.shape)
```

输出表名填写 `result`。下游 SQL 勾选该 Python 单元后可直接 `SELECT * FROM result`；另一个 Python 单元勾选它后直接使用 `result` DataFrame。图表、表格和保存 Dataset 复用已有流程。每次 Notebook 运行建立新环境并重算依赖，普通局部变量不作为跨单元接口；需要共享的数据明确放进输出 DataFrame。`pd`、`np`、`files` 为保留变量名。

读取 Excel 时，在“原始文件”中填写完整文件名，然后使用：

```python
sheets = pd.read_excel(files['input.xlsx'], sheet_name=None)
result = pd.concat(
    [frame.assign(sheet=name) for name, frame in sheets.items()],
    ignore_index=True,
)
```

人工运行可以读取本次导入的 Excel 原件或当前本地项目中未归档的 CSV / XLSX 原件。临时 CSV 可先通过 Data 单元转为输入 DataFrame。文件名不唯一时需要重新上传目标原件。Agent Python 仅获得当前请求附带的工作簿，不自动挂载项目目录；缺失原件会提示重新导入。原始文件按名称和 SHA-256 进入下游来源记录，不复制进模型上下文。原件不自动脱敏；导入表仍在运行前应用已有敏感字段规则，人工原件分析保存的 Dataset 会重新要求确认 AI 使用。

Agent 可调用 `getKernelPackagesInfo` 查询环境、`createPythonCell` 创建或更新单元。工作流为 CellSearch → 修改 → `runNotebookCells` 实际试运行 → `submitNotebookDraft` 交用户采用。失败不提交成功证据；代码、输入或版本变化后旧运行失效。

## 安装和迁移

在 `site` 目录执行 `npm run python:setup`，本机安装 Edge / Chrome / Chromium；可用 `NOTEBOOK_PYTHON_BROWSER` 指定浏览器路径。下载清单固定版本与摘要；完成安装后计算离线运行。`vendor/python` 为生成资源，不进入 Git，构建与发布会复制它；搬迁源码后需重新安装资源，搬迁完整产物仍需目标机有浏览器。

当前固定 Pyodide 314.0.7 / CPython 3.14.2、pandas 3.0.2、NumPy 2.4.6、openpyxl 3.1.5；完整依赖见 `scripts/python-runtime-lock.json`。状态接口 `GET /api/notebook/python` 检查资源完整性和浏览器路径，不代表已完成计算；实际运行是进一步验证。不要直接在此沙箱中运行 `pip` 或 `uv pip` 安装依赖。

## 当前边界

- 每次运行独立浏览器沙箱与 WebAssembly Python，不挂载主机磁盘，不传入服务端 API Key；加载固定资源后阻止网络、WebSocket 和动态包下载。
- 最多两个并发 Python 会话；每个单元计算 10 秒、Notebook 总运行 30 秒，超时或取消只关闭本次创建的执行进程。
- 最多 3 个 CSV / XLSX 文件，上传单文件 10 MiB、请求 16 MiB；表格和文件转成执行消息后的总输入也限制为 16 MiB，因此接近上传上限时可能需要缩小文件。
- 输出最多 50,000 行、30 列、16 MiB，必须是标量列。预览最多 1,000 行，运行内下游 SQL / Python 使用完整输出；保存 Dataset 继续受既有完整结果与 1,000 行限制。stdout / stderr 各最多保留 2,000 字。
- 超出 JavaScript 安全范围的 Python 整数转为字符串保留精度；已在 pandas 浮点转换中丢失的精度不能恢复。日期转 ISO 文本，NaN / NaT / infinity 转空值。
- 尚无持久 Jupyter 内核、任意原生扩展 / 用户安装包、后台作业、跨次变量缓存、文件导出或 Python 原生图形展示。图表使用现有 Notebook 图表单元。当前是本机单用户实现，未做多租户部署验收。

实现和验证以 [Agent 架构维护入口](architecture/agent-architecture.md) 为准。运行机制参考 [Pyodide 包加载文档](https://pyodide.org/en/stable/usage/loading-packages.html) 和 [Playwright BrowserContext](https://playwright.dev/docs/api/class-browsercontext)，所述版本、限制与验收由本项目代码确定。
