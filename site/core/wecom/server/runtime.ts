import type { HarnessMcpRuntime, HarnessMcpCall, HarnessMcpToolSummary } from "@/core/harness/mcp/contracts";
import { createHarnessMcpRuntimeFromEnvironment } from "@/core/harness/mcp/runtime";
import { acceptsWecomRequest, getWecomSession, WECOM_SERVER_ID } from "./session";
import { authorized, runWecom } from "./cli";
import { wecomCatalog, wecomCommand, parseWecomResult, wecomTools } from "./tools";

const statusTool: HarnessMcpToolSummary = {
  serverId: WECOM_SERVER_ID, name: "connection_status", description: "检查本机网页的企业微信连接。未连接时请用户点击 AI 助手右上角“企业微信”扫码并同意数据交给 AI 分析，不能声称已读取企业数据。",
  inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false }, policy: "readOnly",
};

export class WecomRuntime implements HarnessMcpRuntime {
  constructor(private request: Request, private connected: boolean) {}
  catalog() { return [statusTool, ...(this.connected ? wecomCatalog() : [])]; }
  diagnostics(): ReturnType<HarnessMcpRuntime["diagnostics"]> {
    return [{ serverId: WECOM_SERVER_ID, status: this.connected ? "connected" : "unavailable", message: this.connected ? "企业微信已连接（只读）" : "请在网页连接企业微信" }];
  }
  async call(input: HarnessMcpCall, signal?: AbortSignal) {
    if (input.serverId !== WECOM_SERVER_ID) throw new Error("企业微信连接标识无效。");
    if (input.toolName === "connection_status") {
      if (Object.keys(input.arguments).length) throw new Error("连接状态不接受参数。");
      const current = await getWecomSession(this.request);
      const connected = Boolean(current && await authorized(current).catch(() => false));
      return { summary: connected ? "企业微信已连接（只读）" : "尚未连接企业微信，请点击右上角企业微信按钮扫码授权。", data: { connected, readOnly: true, availableTools: connected ? Object.keys(wecomTools) : [] } };
    }
    const args = wecomCommand(input.toolName, input.arguments);
    // Re-read consent on EVERY call. A stale model catalog must not survive disconnect.
    const session = await getWecomSession(this.request);
    if (!session || !this.connected) throw new Error("企业微信授权已断开，请在网页重新连接。");
    const output = await runWecom(session, args, signal);
    if (!await getWecomSession(this.request)) throw new Error("企业微信授权已断开，读取结果未交给模型。");
    return { summary: `企业微信只读工具 ${input.toolName} 已返回结果（以实际区域/分页为准）`, data: { serverId: WECOM_SERVER_ID, toolName: input.toolName, policy: "readOnly", structuredContent: { untrustedExternalData: true, result: parseWecomResult(output) } } };
  }
  async close() {}
}

export async function createRequestMcpRuntime(request: Request, signal?: AbortSignal): Promise<HarnessMcpRuntime | undefined> {
  const external = await createHarnessMcpRuntimeFromEnvironment(process.env, signal);
  if (!acceptsWecomRequest(request)) return external;
  const session = await getWecomSession(request);
  const connected = Boolean(session && await authorized(session).catch(() => false));
  const wecom = new WecomRuntime(request, connected);
  return {
    catalog: () => [...(external?.catalog().filter((tool) => tool.serverId !== WECOM_SERVER_ID) ?? []), ...wecom.catalog()],
    diagnostics: () => [...(external?.diagnostics() ?? []), ...wecom.diagnostics()],
    call: (input, callSignal) => input.serverId === WECOM_SERVER_ID ? wecom.call(input, callSignal)
      : external ? external.call(input, callSignal) : Promise.reject(new Error("外部工具未连接。")),
    close: async () => { await external?.close(); },
  };
}
