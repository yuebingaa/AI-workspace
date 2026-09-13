import { readFile, stat } from "node:fs/promises";
import { isIP } from "node:net";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { StudioValidationError } from "@/core/schemas";
import { sanitizeHarnessText } from "../security";
import {
  harnessMcpConfigSchema,
  type HarnessMcpCall,
  type HarnessMcpCallResult,
  type HarnessMcpConfig,
  type HarnessMcpRuntime,
  type HarnessMcpServerConfig,
  type HarnessMcpToolPolicy,
  type HarnessMcpToolSummary,
} from "./contracts";

const MAX_MCP_CONFIG_BYTES = 64 * 1024;
const MAX_MCP_TOOLS = 128;
const MAX_MCP_TOOL_DESCRIPTION = 360;
const MAX_MCP_SCHEMA_CHARS = 12_000;

interface McpConnection {
  server: HarnessMcpServerConfig;
  client: Client;
  tools: Map<string, HarnessMcpToolSummary>;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/gu, "").toLocaleLowerCase("en-US");
  if (normalized === "localhost" || normalized === "::1") return true;
  if (isIP(normalized) === 4) return normalized.startsWith("127.");
  return false;
}

export function validateHarnessMcpHttpUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.username || url.password) throw new Error("MCP URL 不允许内嵌账号或密码。");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHostname(url.hostname))) {
    throw new Error("远程 MCP 必须使用 HTTPS；HTTP 仅允许 localhost/127.0.0.0/8/::1。");
  }
  return url;
}

function requiredEnvironmentValue(environment: NodeJS.ProcessEnv, name: string, serverId: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`MCP ${serverId} 缺少环境变量 ${name}。`);
  return value;
}

function httpHeaders(server: HarnessMcpServerConfig, environment: NodeJS.ProcessEnv): Headers {
  const headers = new Headers();
  if (server.transport.type !== "http") return headers;
  if (server.transport.bearerTokenEnvVar) {
    headers.set("authorization", `Bearer ${requiredEnvironmentValue(environment, server.transport.bearerTokenEnvVar, server.id)}`);
  }
  for (const [header, envName] of Object.entries(server.transport.headersFromEnv ?? {})) {
    if (/^(?:connection|content-length|host|transfer-encoding)$/iu.test(header)) {
      throw new Error(`MCP ${server.id} 不允许配置受保护的 HTTP Header：${header}。`);
    }
    headers.set(header, requiredEnvironmentValue(environment, envName, server.id));
  }
  return headers;
}

function stdioEnvironment(server: HarnessMcpServerConfig, environment: NodeJS.ProcessEnv): Record<string, string> {
  const inherited = getDefaultEnvironment();
  if (server.transport.type !== "stdio") return inherited;
  for (const name of server.transport.envVars ?? []) inherited[name] = requiredEnvironmentValue(environment, name, server.id);
  return inherited;
}

export function resolveHarnessMcpToolPolicy(server: HarnessMcpServerConfig, tool: Tool): HarnessMcpToolPolicy {
  if (server.disabledTools?.includes(tool.name)) return "disabled";
  if (server.enabledTools && !server.enabledTools.includes(tool.name)) return "disabled";
  const policy = server.toolPolicies[tool.name] ?? server.defaultPolicy;
  if (policy === "disabled") return policy;
  if (tool.annotations?.destructiveHint && !(policy === "trusted" && server.allowDestructive)) return "disabled";
  if (tool.annotations?.openWorldHint && !server.allowOpenWorld) return "disabled";
  if (policy === "readOnly" && tool.annotations?.readOnlyHint !== true) return "disabled";
  return policy;
}

function compactJsonSchema(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { type: "object", additionalProperties: false };
  const serialized = JSON.stringify(value);
  if (serialized.length > MAX_MCP_SCHEMA_CHARS) {
    throw new Error("MCP 工具参数 Schema 超过安全大小限制。");
  }
  return structuredClone(value as Record<string, unknown>);
}

function toolSummary(server: HarnessMcpServerConfig, tool: Tool): HarnessMcpToolSummary | undefined {
  const policy = resolveHarnessMcpToolPolicy(server, tool);
  if (policy === "disabled") return undefined;
  return {
    serverId: server.id,
    name: tool.name,
    description: sanitizeHarnessText(tool.description ?? `${server.id} 提供的 MCP 工具`).slice(0, MAX_MCP_TOOL_DESCRIPTION),
    inputSchema: compactJsonSchema(tool.inputSchema),
    annotations: {
      ...(tool.annotations?.readOnlyHint !== undefined ? { readOnlyHint: tool.annotations.readOnlyHint } : {}),
      ...(tool.annotations?.destructiveHint !== undefined ? { destructiveHint: tool.annotations.destructiveHint } : {}),
      ...(tool.annotations?.idempotentHint !== undefined ? { idempotentHint: tool.annotations.idempotentHint } : {}),
      ...(tool.annotations?.openWorldHint !== undefined ? { openWorldHint: tool.annotations.openWorldHint } : {}),
    },
    policy,
  };
}

function compactContent(result: CallToolResult): unknown[] {
  return result.content.slice(0, 24).map((item) => {
    if (item.type === "text") return { type: "text", text: sanitizeHarnessText(item.text).slice(0, 2_000) };
    if (item.type === "image" || item.type === "audio") {
      return { type: item.type, mimeType: item.mimeType, bytesOmitted: true, encodedLength: item.data.length };
    }
    if (item.type === "resource_link") {
      return {
        type: item.type,
        name: sanitizeHarnessText(item.name).slice(0, 160),
        uri: sanitizeHarnessText(item.uri).slice(0, 1_000),
        ...(item.description ? { description: sanitizeHarnessText(item.description).slice(0, 360) } : {}),
        ...(item.mimeType ? { mimeType: item.mimeType } : {}),
      };
    }
    if (item.type === "resource") {
      const resource = item.resource;
      return "text" in resource
        ? { type: item.type, uri: sanitizeHarnessText(resource.uri).slice(0, 1_000), text: sanitizeHarnessText(resource.text).slice(0, 2_000) }
        : { type: item.type, uri: sanitizeHarnessText(resource.uri).slice(0, 1_000), bytesOmitted: true, encodedLength: resource.blob.length };
    }
    return { type: "unsupported", omitted: true };
  });
}

async function createTransport(
  server: HarnessMcpServerConfig,
  environment: NodeJS.ProcessEnv,
): Promise<Transport> {
  if (server.transport.type === "http") {
    return new StreamableHTTPClientTransport(validateHarnessMcpHttpUrl(server.transport.url), {
      requestInit: { headers: httpHeaders(server, environment) },
    });
  }
  if (environment.HARNESS_MCP_ALLOW_STDIO !== "1") {
    throw new Error(`MCP ${server.id} 使用 STDIO，但 HARNESS_MCP_ALLOW_STDIO 未启用。`);
  }
  return new StdioClientTransport({
    command: server.transport.command,
    args: server.transport.args ?? [],
    ...(server.transport.cwd ? { cwd: resolve(server.transport.cwd) } : {}),
    env: stdioEnvironment(server, environment),
    stderr: "pipe",
    maxBufferSize: 4 * 1024 * 1024,
  });
}

async function connectServer(
  server: HarnessMcpServerConfig,
  environment: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<McpConnection> {
  const client = new Client({ name: "agentcanvas-harness", version: "0.1.0" });
  const transport = await createTransport(server, environment);
  try {
    await client.connect(transport, { timeout: server.startupTimeoutMs, signal });
    const listed = await client.listTools({}, { timeout: server.startupTimeoutMs, signal });
    const tools = new Map<string, HarnessMcpToolSummary>();
    for (const tool of listed.tools.slice(0, MAX_MCP_TOOLS)) {
      const summary = toolSummary(server, tool);
      if (summary) tools.set(summary.name, summary);
    }
    return { server, client, tools };
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }
}

export class AgentCanvasMcpRuntime implements HarnessMcpRuntime {
  private constructor(
    private readonly connections: Map<string, McpConnection>,
    private readonly connectionDiagnostics: Array<{ serverId: string; status: "connected" | "unavailable"; message: string }>,
  ) {}

  static async connect(config: HarnessMcpConfig, environment: NodeJS.ProcessEnv = process.env, signal?: AbortSignal) {
    const connections = new Map<string, McpConnection>();
    const diagnostics: Array<{ serverId: string; status: "connected" | "unavailable"; message: string }> = [];
    for (const server of config.servers.filter((candidate) => candidate.enabled)) {
      try {
        const connection = await connectServer(server, environment, signal);
        connections.set(server.id, connection);
        diagnostics.push({ serverId: server.id, status: "connected", message: `${connection.tools.size} 个工具可用` });
      } catch (error) {
        const message = sanitizeHarnessText(error, "MCP 服务器连接失败。");
        diagnostics.push({ serverId: server.id, status: "unavailable", message });
        if (server.required) {
          await Promise.all([...connections.values()].map((connection) => connection.client.close().catch(() => undefined)));
          throw new StudioValidationError("Harness MCP 初始化失败", [`必需服务器 ${server.id} 不可用：${message}`]);
        }
      }
    }
    return new AgentCanvasMcpRuntime(connections, diagnostics);
  }

  catalog(): HarnessMcpToolSummary[] {
    return [...this.connections.values()].flatMap((connection) => [...connection.tools.values()].map((tool) => structuredClone(tool)));
  }

  diagnostics() {
    return this.connectionDiagnostics.map((item) => ({ ...item }));
  }

  async call(input: HarnessMcpCall, signal?: AbortSignal): Promise<HarnessMcpCallResult> {
    const connection = this.connections.get(input.serverId);
    if (!connection) throw new StudioValidationError("Harness MCP 工具校验失败", [`MCP 服务器不可用：${input.serverId}`]);
    const tool = connection.tools.get(input.toolName);
    if (!tool) throw new StudioValidationError("Harness MCP 工具权限校验失败", [`MCP 工具未获准或不存在：${input.serverId}/${input.toolName}`]);
    const result = await connection.client.callTool({ name: input.toolName, arguments: input.arguments }, undefined, {
      timeout: connection.server.toolTimeoutMs,
      signal,
    });
    if ("isError" in result && result.isError) {
      const text = "content" in result && Array.isArray(result.content)
        ? result.content.flatMap((item) => item.type === "text" ? [item.text] : []).join("；")
        : "MCP 工具返回失败状态。";
      throw new StudioValidationError("Harness MCP 工具执行失败", [sanitizeHarnessText(text)]);
    }
    const callResult = result as CallToolResult;
    return {
      summary: `MCP ${input.serverId}/${input.toolName} 已执行并返回结构化结果。`,
      data: {
        serverId: input.serverId,
        toolName: input.toolName,
        policy: tool.policy,
        content: compactContent(callResult),
        ...(callResult.structuredContent ? { structuredContent: callResult.structuredContent } : {}),
      },
    };
  }

  async close(): Promise<void> {
    await Promise.all([...this.connections.values()].map((connection) => connection.client.close().catch(() => undefined)));
    this.connections.clear();
  }
}

async function parseConfigFile(path: string): Promise<unknown> {
  const absolutePath = resolve(path);
  const metadata = await stat(absolutePath);
  if (!metadata.isFile() || metadata.size > MAX_MCP_CONFIG_BYTES) throw new Error("Harness MCP 配置文件不存在或超过 64KB。 ");
  return JSON.parse(await readFile(absolutePath, "utf8")) as unknown;
}

export async function loadHarnessMcpConfig(environment: NodeJS.ProcessEnv = process.env): Promise<HarnessMcpConfig | undefined> {
  if (environment.HARNESS_MCP_ENABLED !== "1") return undefined;
  const inline = environment.HARNESS_MCP_CONFIG_JSON?.trim();
  const path = environment.HARNESS_MCP_CONFIG_PATH?.trim();
  if (inline && path) throw new Error("HARNESS_MCP_CONFIG_JSON 与 HARNESS_MCP_CONFIG_PATH 只能配置一个。");
  if (!inline && !path) throw new Error("启用 Harness MCP 后必须提供配置 JSON 或配置文件路径。");
  if (inline && new TextEncoder().encode(inline).byteLength > MAX_MCP_CONFIG_BYTES) throw new Error("Harness MCP 内联配置超过 64KB。");
  const raw = inline ? JSON.parse(inline) as unknown : await parseConfigFile(path!);
  const parsed = harnessMcpConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 8).map((issue) => `${issue.path.map(String).join(".") || "$"}:${issue.message}`);
    throw new StudioValidationError("Harness MCP 配置校验失败", issues);
  }
  return parsed.data;
}

export async function createHarnessMcpRuntimeFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
  signal?: AbortSignal,
): Promise<AgentCanvasMcpRuntime | undefined> {
  const config = await loadHarnessMcpConfig(environment);
  return config ? AgentCanvasMcpRuntime.connect(config, environment, signal) : undefined;
}
