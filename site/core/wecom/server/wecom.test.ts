import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { wecomCatalog, wecomCommand, parseWecomResult } from "./tools";
import { acceptsWecomRequest, createWecomSession, getWecomSession, revokeWecomSession, sessionCookieName, wecomOwnershipNamespace, authJobs } from "./session";
import { authorized, runWecom, startWecomAuth } from "./cli";
import { WecomRuntime, createRequestMcpRuntime } from "./runtime";
import { GET, POST, DELETE } from "@/app/api/settings/wecom/route";
import { harnessMcpToolSummarySchema } from "@/core/harness/mcp/contracts";
import { demoFixtureResult } from "@/fixtures/demo-product";
import { DeepSeekHarness } from "@/core/harness/deepseek-harness";
import type { HarnessModel, HarnessRequest } from "@/core/harness/contracts";
import { buildHarnessContextSelection } from "@/core/harness/context-selector";

vi.mock("./cli", () => ({ wecomBinary: () => "mock-native-cli", authorized: vi.fn(async () => true), runWecom: vi.fn(async () => '{"sheets":[{"sheet_id":"sheet1","title":"销售","data_range":"A1:B2"}]}'), startWecomAuth: vi.fn(), readWecomQr: vi.fn(async () => undefined) }));
let root: string;
const base = "http://127.0.0.1:3001";
function req(path = "/api/settings/wecom", init: RequestInit = {}) { return new Request(`${base}${path}`, { ...init, headers: { origin: base, "content-type": "application/json", ...init.headers } }); }
async function connectedRequest() {
  const created = await createWecomSession(req());
  return { ...created, request: req("/api/ai/harness", { headers: { cookie: created.cookie.split(";", 1)[0] } }) };
}
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "agentcanvas-wecom-test-")); vi.stubEnv("STUDIO_LOCAL_STATE_DIR", root); vi.stubEnv("HARNESS_MCP_ENABLED", "0"); vi.clearAllMocks(); vi.mocked(authorized).mockResolvedValue(true); });
afterEach(async () => { authJobs.clear(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

describe("企业微信只读边界", () => {
  it("只开放白名单并以独立 argv JSON 传参，拒绝任意命令和额外字段", () => {
    const args = wecomCommand("search_documents", { keywords: ['销售; $(echo x) "报价"'] });
    expect(args.slice(0, 3)).toEqual(["doc", "search", "--json"]);
    expect(JSON.parse(args[3]).keywords[0]).toBe('销售; $(echo x) "报价"');
    for (const name of ["send_message", "delete", "__proto__", "constructor"]) expect(() => wecomCommand(name, {})).toThrow();
    expect(() => wecomCommand("sheet_info", { docid: "d1", command: "cmd" })).toThrow();
    expect(() => wecomCommand("sheet_info", { docid: "../../config" })).toThrow();
    wecomCatalog().forEach((tool) => { expect(harnessMcpToolSummarySchema.safeParse(tool).success).toBe(true); expect(tool.policy).toBe("readOnly"); });
  });
  it("限制读取大小、逆序范围、分页行数，不接受 CSV 文件模式", () => {
    expect(wecomCommand("read_sheet_range", { docid: "d1", sheet_id: "s1", range: "A1:J100" })).toHaveLength(5);
    for (const range of ["A1:Z100", "B2:A1", "A0:B3", "A1", "A1:A1001"]) expect(() => wecomCommand("read_sheet_range", { docid: "d1", sheet_id: "s1", range })).toThrow();
    expect(() => wecomCommand("read_sheet_range", { docid: "d1", sheet_id: "s1", range: "A1:B2", mode: "csv" })).toThrow();
    expect(() => wecomCommand("read_smart_records", { docid: "d1", sheet_title: "销售", limit: 100 })).toThrow();
  });
  it("拒绝错误、文件路径、大结果并移除凭据字段", () => {
    for (const data of ["not json", '{"errcode":403}', '{"error":{"message":"SECRET"}}', '{"file_path":"C:/secret"}', JSON.stringify({ content: "x".repeat(25_000) })]) expect(() => parseWecomResult(data)).toThrow();
    expect(parseWecomResult('{"rows":[{"金额":123,"access_token":"SECRET"}]}')).toEqual({ rows: [{ 金额: 123 }] });
  });
  it("禁止跨站、同站跨端口和公网访问", () => {
    expect(acceptsWecomRequest(req(), true)).toBe(true);
    expect(acceptsWecomRequest(req("/", { headers: { origin: "http://evil.example" } }), true)).toBe(false);
    expect(acceptsWecomRequest(req("/", { headers: { origin: "http://127.0.0.1:3000" } }), true)).toBe(false);
    expect(acceptsWecomRequest(new Request(`${base}/`), true)).toBe(false);
    expect(acceptsWecomRequest(new Request("https://example.com/"))).toBe(false);
  });
});
describe("独立授权与网页接口", () => {
  it("凭据目录、端口 Cookie、任务缓存及会话命名空间相互隔离", async () => {
    const a = await connectedRequest(); const b = await connectedRequest();
    expect(a.cookie).toContain("HttpOnly; SameSite=Strict");
    expect(a.session.directory).not.toBe(b.session.directory);
    expect(await getWecomSession(a.request)).toEqual(a.session);
    expect(await getWecomSession(req())).toBeUndefined();
    expect(sessionCookieName(new Request("http://127.0.0.1:3000/"))).not.toBe(sessionCookieName(req()));
    expect(wecomOwnershipNamespace(a.request, "demo")).not.toBe(wecomOwnershipNamespace(b.request, "demo"));
    const disk = await readFile(join(a.session.directory, "session.json"), "utf8");
    expect(disk).not.toContain(a.cookie.split("=", 2)[1].split(";", 1)[0]);
  });
  it("GET 无副作用且未授权时智能体只看得到连接状态", async () => {
    const result = await GET(req()); expect(await result.json()).toMatchObject({ connected: false, pending: false });
    expect(startWecomAuth).not.toHaveBeenCalled();
    const runtime = await createRequestMcpRuntime(req());
    expect(runtime?.catalog().map((tool) => tool.name)).toEqual(["connection_status"]);
    expect((await runtime!.call({ serverId: "wecom", toolName: "connection_status", arguments: {} })).summary).toContain("尚未连接");
  });
  it("未同意不启动登录，明确同意后仅返回 HttpOnly 会话，二维码不能跨会话读取", async () => {
    expect((await POST(req("/api/settings/wecom", { method: "POST", body: JSON.stringify({ action: "connect", consent: false }) }))).status).toBe(400);
    expect(startWecomAuth).not.toHaveBeenCalled();
    vi.mocked(authorized).mockResolvedValue(false);
    const response = await POST(req("/api/settings/wecom", { method: "POST", body: JSON.stringify({ action: "connect", consent: true }) }));
    expect(response.status).toBe(200); expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(startWecomAuth).toHaveBeenCalledTimes(1);
    expect((await GET(req("/api/settings/wecom?qr=1"))).status).toBe(404);
    expect((await POST(req("/", { method: "POST", headers: { origin: "http://evil.example" } }))).status).toBe(403);
  });
  it("断开后即使旧 Runtime 和旧 Cookie 尚在，也不能继续读取", async () => {
    const { session, request } = await connectedRequest();
    const runtime = new WecomRuntime(request, true);
    await revokeWecomSession(session);
    await expect(runtime.call({ serverId: "wecom", toolName: "sheet_info", arguments: { docid: "d1" } })).rejects.toThrow("断开");
    expect(runWecom).not.toHaveBeenCalled();
    const response = await DELETE(request); expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });
  it("读取期间断开，已取得的数据也不会再传给模型", async () => {
    const { session, request } = await connectedRequest();
    vi.mocked(runWecom).mockImplementationOnce(async () => { await revokeWecomSession(session); return '{"rows":["PRIVATE"]}'; });
    await expect(new WecomRuntime(request, true).call({ serverId: "wecom", toolName: "sheet_info", arguments: { docid: "d1" } })).rejects.toThrow("未交给模型");
  });
});
describe("网页智能体调用链", () => {
  it("连续读取结构和单元格，将真实结构化数据交给模型并记录执行证据", async () => {
    if (!demoFixtureResult.success) throw new Error("fixture");
    const { request: httpRequest } = await connectedRequest();
    const runtime = new WecomRuntime(httpRequest, true);
    const request: HarnessRequest = { idempotencyKey: "wecom_full_test", instruction: "读取企业微信表格结构，再读取 A1:B2 并说明金额", pageId: "page_home", role: "editor", appSpec: structuredClone(demoFixtureResult.data.dataProduct.appSpec), recipes: structuredClone(demoFixtureResult.data.dataProduct.recipes), mcpTools: runtime.catalog() };
    const decision = { mode: "readOnlyTask" as const, requiresVisualVerification: false, wantsData: false, wantsEdsAnalysis: false, wantsRawWorkbook: false, wantsFields: false, wantsRecipe: false, wantsAppInspection: false, wantsExcel: false, wantsMcpTool: true, changeAction: "none" as const, changeTarget: "none" as const, componentKind: "none" as const, chartType: "auto" as const, skillIds: [], confidence: .99, rationale: "使用企业微信只读工具" };
    vi.mocked(runWecom).mockResolvedValueOnce('{"sheets":[{"sheet_id":"sheet1","data_range":"A1:B2"}]}').mockResolvedValueOnce('{"grid_data":{"金额":123}}');
    const seen: string[] = [];
    const model: HarnessModel = {
      classifyIntent: async () => ({ decision, model: "mock", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, inputChars: 1 }),
      next: async (input) => {
        seen.push(JSON.stringify(input));
        return { model: "mock", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, turn: input.iteration <= 2
          ? { type: "callTool", message: "读取企业微信", toolCallId: `wecom_${input.iteration}`, name: "callMcpTool", arguments: { serverId: "wecom", toolName: input.iteration === 1 ? "sheet_info" : "read_sheet_range", arguments: input.iteration === 1 ? { docid: "d1" } : { docid: "d1", sheet_id: "sheet1", range: "A1:B2" } } }
          : { type: "complete", message: "读取区域 A1:B2 中的金额为 123，仅代表此区域。" } };
      },
    };
    const selection = buildHarnessContextSelection(request, [], 1);
    expect(JSON.stringify(selection)).toContain("callMcpTool");
    const task = await new DeepSeekHarness().run(request, { dataRuntime: { rowsByDataSourceId: {} }, modelClient: model, mcpRuntime: runtime });
    expect(task.state, JSON.stringify({ terminationCode: task.terminationCode, events: task.events, verification: task.verification })).toBe("completed"); expect(runWecom).toHaveBeenCalledTimes(2);
    expect(seen.at(-1)).toContain("123"); expect(seen.at(-1)).toContain("grid_data");
    expect(task.evidence?.records.filter((record) => record.source === "callMcpTool").length).toBeGreaterThanOrEqual(2);
  });
});
