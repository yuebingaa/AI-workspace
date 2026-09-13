# Harness MCP 接入

AgentCanvas Harness 通过服务端 MCP Client 将外部工具接入现有的 Planner、Executor、Evidence Bus 和 Verifier。浏览器请求不能提交服务器 URL、启动命令或密钥，也不能绕过工具权限策略。

## 启用

1. 复制 `mcp.config.example.json` 为未纳入 Git 的 `mcp.config.json`。
2. 配置服务器和工具允许列表。
3. 将密钥放入独立环境变量，JSON 中只填写 `bearerTokenEnvVar` 或 `headersFromEnv` 的环境变量名。
4. 设置：

```dotenv
HARNESS_MCP_ENABLED=1
HARNESS_MCP_CONFIG_PATH=./mcp.config.json
```

托管环境也可以改用 `HARNESS_MCP_CONFIG_JSON`。它与 `HARNESS_MCP_CONFIG_PATH` 只能设置一个。

## 传输

- `http`：远程地址必须使用 HTTPS；HTTP 只允许 loopback 地址。
- `stdio`：仅适用于可信的本地或专用 Node.js 主机，并且必须显式设置 `HARNESS_MCP_ALLOW_STDIO=1`。普通无状态云函数不建议启动 STDIO MCP 进程。

## 权限策略

每个服务器可以使用 `enabledTools` 和 `disabledTools` 限定工具，并设置：

- `readOnly`：默认策略。工具必须明确声明 `readOnlyHint: true` 才会进入模型工具目录。
- `trusted`：服务器管理员对该工具进行了预授权；适用于当前尚无交互式 MCP 审批界面的场景。
- `disabled`：不向模型公开，也拒绝执行。

声明 `destructiveHint` 的工具还必须同时满足 `trusted` 和 `allowDestructive: true`。声明 `openWorldHint` 的工具需要 `allowOpenWorld: true`。所有检查会在工具发现和实际执行时重复进行。

当前版本不会把 MCP 图片、音频或二进制资源的 Base64 内容送入文本模型；Evidence Bus 只保留类型、大小和可追溯元数据。MCP 返回的文本和工具描述始终按不可信外部数据处理。
