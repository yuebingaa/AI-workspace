import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentEngineSettingsSchema } from "@/core/agent-engines/contracts";
import { agentEngineSelection } from "@/core/agent-engines/server/selection";
import { GET, PATCH } from "./route";

const inspection = vi.hoisted(() => vi.fn());
vi.mock("@/core/agent-engines/server/dsh-driver", () => ({ inspectOfficialDshRuntime: inspection }));
vi.mock("@/core/agent-engines/server/selection", async importOriginal => {
  const actual = await importOriginal<typeof import("@/core/agent-engines/server/selection")>();
  return { ...actual, agentEngineSelection: new actual.AgentEngineSelection() };
});

const url = "http://127.0.0.1:3001/api/settings/agent-engine";
const available = { available: true, version: "0.1.6-alpha.2" };
function current() { return agentEngineSelection.status(available); }
function patch(body: unknown, headers: Record<string, string> = {}) {
  return new Request(url, { method: "PATCH", headers: { "content-type": "application/json", origin: "http://127.0.0.1:3001", ...headers }, body: JSON.stringify(body) });
}
function streamRequest(body: ReadableStream<Uint8Array>, signal?: AbortSignal) {
  const init: RequestInit & { duplex: "half" } = { method: "PATCH", duplex: "half", body, signal,
    headers: { "content-type": "application/json", origin: "http://127.0.0.1:3001" } };
  return new Request(url, init);
}

beforeEach(() => {
  const state = current();
  expect(state.activeTasks).toBe(0);
  agentEngineSelection.select({ engine: "harness", revision: state.revision }, available);
  inspection.mockReset().mockResolvedValue(available);
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("No model or external request is permitted"); }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe("执行引擎设置 API", () => {
  it("本机无 Origin GET 返回严格 DTO、四工具及禁缓存头，不调用模型", async () => {
    const response = await GET(new Request(url));
    const data = agentEngineSettingsSchema.parse(await response.json());
    expect(response.status).toBe(200);
    expect(data).toMatchObject({ engine: "harness", activeTasks: 0, persistence: "process-memory", dsh: available });
    expect(data.plugins.flatMap(plugin => plugin.tools)).toEqual(["cellSearch", "editNotebookCells", "runNotebookCells", "submitNotebookDraft",
      "inspectEdsRawWorkbook", "readEdsRawRows", "getKernelPackagesInfo", "inspectConnectionSchema"]);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(inspection).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each<{ target: string; headers: Record<string, string> }>([
    { target: "https://attacker.invalid/api/settings/agent-engine", headers: {} },
    { target: url, headers: { origin: "https://attacker.invalid" } },
    { target: url, headers: { "sec-fetch-site": "cross-site" } },
    { target: url, headers: { "sec-fetch-site": "same-site" } },
  ])("拒绝非本机或跨源 GET：$target $headers", async ({ target, headers }) => {
    const response = await GET(new Request(target, { headers }));
    expect(response.status).toBe(403);
    expect(inspection).not.toHaveBeenCalled();
  });

  it("PATCH 显式切换、revision 递增；重复相同选择不递增", async () => {
    const previous = current();
    const response = await PATCH(patch({ engine: "dsh", revision: previous.revision }));
    expect(response.status).toBe(200);
    const selected = agentEngineSettingsSchema.parse(await response.json());
    expect(selected).toMatchObject({ engine: "dsh", revision: previous.revision + 1 });
    expect((await PATCH(patch({ engine: "dsh", revision: selected.revision }))).status).toBe(200);
    expect(current().revision).toBe(selected.revision);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("无 Origin 的写入须有 same-origin Fetch Metadata", async () => {
    const body = JSON.stringify({ engine: "dsh", revision: current().revision });
    const absent = await PATCH(new Request(url, { method: "PATCH", headers: { "content-type": "application/json" }, body }));
    expect(absent.status).toBe(403);
    expect(inspection).not.toHaveBeenCalled();
    const allowed = await PATCH(new Request(url, { method: "PATCH", headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" }, body }));
    expect(allowed.status).toBe(200);
  });

  it.each<Record<string, string>>([
    { origin: "http://localhost:3001" },
    { origin: "http://127.0.0.1:3000" },
    { origin: "null" },
    { "sec-fetch-site": "cross-site" },
  ])("拒绝跨源 PATCH：$headers", async headers => {
    const response = await PATCH(patch({ engine: "dsh", revision: current().revision }, headers));
    expect(response.status).toBe(403);
    expect(current().engine).toBe("harness");
    expect(inspection).not.toHaveBeenCalled();
  });

  it.each([
    { engine: "unknown", revision: 0 }, { engine: "dsh" }, { engine: "dsh", revision: -1 },
    { engine: "dsh", revision: 1.5 }, { engine: "dsh", revision: "0" },
    { engine: "dsh", revision: 0, apiKey: "synthetic-secret-not-accepted" },
  ])("严格拒绝非法或越界输入 $engine/$revision", async input => {
    const response = await PATCH(patch(input));
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain("synthetic-secret");
    expect(inspection).not.toHaveBeenCalled();
  });

  it("拒绝错误 Content-Type 和损坏 JSON，不探测或修改引擎", async () => {
    expect((await PATCH(patch({}, { "content-type": "text/plain" }))).status).toBe(415);
    const invalid = await PATCH(new Request(url, { method: "PATCH", headers: { "content-type": "application/json", origin: "http://127.0.0.1:3001" }, body: "{private" }));
    expect(invalid.status).toBe(400);
    expect(await invalid.text()).not.toContain("private");
    expect(inspection).not.toHaveBeenCalled();
  });

  it("409 保护过期 revision 和运行中任务，保持当前引擎", async () => {
    const before = current();
    const stale = await PATCH(patch({ engine: "dsh", revision: before.revision + 1 }));
    expect(stale.status).toBe(409);
    expect(await stale.text()).toContain("已变化");
    const lease = agentEngineSelection.acquire();
    try {
      const active = await GET(new Request(url));
      expect(await active.json()).toMatchObject({ activeTasks: 1 });
      const busy = await PATCH(patch({ engine: "dsh", revision: before.revision }));
      expect(busy.status).toBe(409);
      expect(await busy.text()).toContain("任务正在执行");
      expect(current().engine).toBe("harness");
      expect(current().revision).toBe(before.revision);
    } finally { lease.release(); }
  });

  it("DSH 不可用时拒绝切入，但允许从 DSH 返回原版", async () => {
    const before = current();
    inspection.mockResolvedValue({ available: false, version: available.version, reason: "尚未安装" });
    const unavailable = await PATCH(patch({ engine: "dsh", revision: before.revision }));
    expect(unavailable.status).toBe(409);
    expect(current().engine).toBe("harness");
    agentEngineSelection.select({ engine: "dsh", revision: before.revision }, available);
    const fallback = await PATCH(patch({ engine: "harness", revision: current().revision }));
    expect(fallback.status).toBe(200);
    expect(await fallback.json()).toMatchObject({ engine: "harness", dsh: { available: false, reason: "尚未安装" } });
  });

  it("按实际 UTF-8 字节拒绝超过 2 KiB 的请求", async () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ engine: "dsh", revision: current().revision, extra: "字".repeat(800) }));
    const response = await PATCH(streamRequest(new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } })));
    expect(response.status).toBe(413);
    expect(inspection).not.toHaveBeenCalled();
    expect(current().engine).toBe("harness");
  });

  it("5 秒读取超时取消请求体，不修改引擎", async () => {
    vi.useFakeTimers();
    const cancelled = vi.fn();
    const pending = PATCH(streamRequest(new ReadableStream({ cancel: cancelled })));
    await vi.advanceTimersByTimeAsync(5_001);
    const response = await pending;
    expect(response.status).toBe(408);
    expect(cancelled).toHaveBeenCalled();
    expect(inspection).not.toHaveBeenCalled();
    expect(current().engine).toBe("harness");
  });

  it("读取取消或探测后取消都不会应用选择", async () => {
    const aborted = new AbortController(); aborted.abort();
    const response = await PATCH(streamRequest(new ReadableStream(), aborted.signal));
    expect(response.status).toBe(408);
    expect(inspection).not.toHaveBeenCalled();
    expect((await GET(new Request(url, { signal: aborted.signal }))).status).toBe(408);
    const controller = new AbortController();
    inspection.mockImplementationOnce(async () => { controller.abort(); return available; });
    const request = patch({ engine: "dsh", revision: current().revision });
    const late = await PATCH(new Request(request, { signal: controller.signal }));
    expect(late.status).toBe(408);
    expect(current().engine).toBe("harness");
  });

  it("隐藏未知检查异常中的路径和密钥；错误响应仍禁止缓存", async () => {
    inspection.mockRejectedValue(new Error("C:\\private\\synthetic-config sk-not-a-real-secret"));
    for (const response of [await GET(new Request(url)), await PATCH(patch({ engine: "dsh", revision: current().revision }))]) {
      expect(response.status).toBe(500);
      const body = await response.text();
      expect(body).not.toContain("private");
      expect(body).not.toContain("sk-not-a-real-secret");
      expect(body).toContain("请稍后刷新重试");
      expect(response.headers.get("cache-control")).toContain("no-store");
    }
    expect(current().engine).toBe("harness");
  });
});
