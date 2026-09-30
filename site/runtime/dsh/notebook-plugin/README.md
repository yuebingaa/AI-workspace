# AgentCanvas Notebook tools for DSH

首个可移植插件切片。目录可单独复制，使用 DSH 的 `name / inject / apply`
插件接口；不导入网站、React、旧 Harness、模型客户端或数据库驱动，不安装另一份
DSH。当前验证版本为 DSH **0.1.7-rc.2 / Cordis 4.0.4 / Node 24**。
`private: true` 防止误发 npm；尚未在外部 DSH 应用或其他版本验收。

## 范围

- Notebook：`cellSearch`、`editNotebookCells`、`runNotebookCells`、`submitNotebookDraft`。
- 按需来源能力：`getKernelPackagesInfo`、`inspectEdsRawWorkbook`、`readEdsRawRows`、`inspectConnectionSchema`。
- 仅注册宿主本次提供的目录；不自动补齐工具，不接管整个 DSH 的工具白名单。
- 工具名称、描述、参数 Schema 和结果保持宿主契约。失败继续抛出，取消信号和
  调用 ID 原样传递，已取消的迟到成功结果不会交付。

这是**业务工具的 DSH 接入插件**，不是独立的数据分析服务器。SQL / Python 引擎、
Notebook 业务校验、原件读取、数据权限、试运行回执和草稿存储仍由宿主实现。
提交草稿不等于保存正式 Notebook；不包含界面、密钥、会话或项目数据。

## 接入另一宿主

先安装并初始化宿主自己的 DSH `tools` 服务，再从可信代码提供两个端口：

```js
import * as notebookPlugin from './notebook-plugin/index.mjs';

await ctx.plugin(notebookPlugin, {
  // 仅提供当前任务已授权的工具描述，不向模型泄漏服务端凭据。
  catalog: hostNotebook.catalog(),
  execute: async ({ name, args, callId, signal }) => {
    signal.throwIfAborted();
    hostNotebook.authorizeCurrentAccess();
    // 宿主负责严格参数校验、幂等/并发、数据访问与真正执行。
    // 可以是同进程服务，也可以是已有的受认证工具通信桥。
    const result = await hostNotebook.execute({ name, args, callId, signal });
    signal.throwIfAborted();
    hostNotebook.authorizeCurrentAccess();
    return result; // JSON 对象；原网站为 { summary, data }
  },
});
```

`hostNotebook` 是目标应用应提供的接口，不是本包附带的服务。完整 TypeScript
契约见 `index.d.mts`。目录在插件加载时固定；权限变化由宿主逐次检查，工具组合
变化应卸载/重新组装插件。宿主须遵守 DSH 的插件作用域和生命周期，不能把同一
全局工具实例无隔离地用于多个用户。插件本身不是安全沙箱。

配置包含可信执行函数，**不能直接把 JSON/YAML 或模型输出当作执行配置**。
另一应用的薄入口应导入本插件并注入它自己的服务，不通过浏览器选择任意模块。
不提供终端、任意文件访问、安装开关、模型参数或收费调用。

## 本网站接线与验证

`../controlled-plugin.mjs` 负责模型配置、任务 profile、认证和安全诊断；它通过
`ctx.plugin()` 挂载本插件，并把执行委派给现有任务 broker。业务逻辑没有复制，
旧 Harness 仍复用原业务服务。原 `policy.mjs` 继续约束网站的工具组合。

从 `site/` 运行：

```text
node --test runtime/dsh/notebook-plugin.test.mjs runtime/dsh/driver.test.mjs
node scripts/verify-dsh-embedding.mjs
```

单测包含目录校验、取消/错误传递、实例隔离，以及仅复制本目录后在真实 DSH
工具服务上加载、调用、卸载的离线验证。SDK 驱动测试覆盖原四工具、只读、可选
来源工具、空对话和 Skill 并存。离线验证不等于真实模型质量或第三方宿主接入验收。

后续可以沿用此方式拆出 Dataset / 语义模型 / 看板能力；本批不扩大工具目录，
不新增业务插件开关，也不修改现有界面。
