import { beforeEach, describe, expect, it, vi } from "vitest";
import { dshPackageInventorySchema } from "@/core/agent-engines/plugin-inventory";
import { GET } from "./route";
const inspect = vi.hoisted(() => vi.fn());
vi.mock("@/core/agent-engines/server/dsh-driver", () => ({ inspectOfficialDshPackageInventory: inspect }));
const initial = { source: "managed-installation", complete: true, packages: [], issues: [] };
const url = "http://127.0.0.1:3001/api/settings/dsh-plugins/inventory";
beforeEach(() => { inspect.mockReset().mockResolvedValue(initial); });
describe("read-only official package inventory API", () => {
  it("returns validated no-store metadata", async () => {
    const response = await GET(new Request(url)); expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(dshPackageInventorySchema.parse(await response.json())).toEqual(initial);
    expect(inspect).toHaveBeenCalledOnce();
  });
  it.each(["https://foreign.invalid", "http://localhost:3001"])("rejects foreign origin %s before reading", async origin => {
    expect((await GET(new Request(url, { headers: { origin } }))).status).toBe(403); expect(inspect).not.toHaveBeenCalled();
  });
  it("rejects cross-site reads and query-supplied paths", async () => {
    expect((await GET(new Request(url, { headers: { "sec-fetch-site": "cross-site" } }))).status).toBe(403);
    expect((await GET(new Request(url + "?root=private"))).status).toBe(400); expect(inspect).not.toHaveBeenCalled();
  });
  it("redacts installation failures, not a false empty directory", async () => {
    inspect.mockRejectedValue(new Error("secret-fixture-directory")); const response = await GET(new Request(url));
    expect(response.status).toBe(503); expect(await response.text()).not.toContain("secret-fixture");
  });
  it("retains explicit partial failure facts", async () => {
    inspect.mockResolvedValue({ ...initial, complete: false, issues: [{ id: "@deepseek-ai/dsh-missing", code: "metadata-unavailable" }] });
    const body = dshPackageInventorySchema.parse(await (await GET(new Request(url))).json()); expect(body.complete).toBe(false); expect(body.issues).toHaveLength(1);
  });
  it("rejects unexpected fields and duplicate records", async () => {
    inspect.mockResolvedValue({ ...initial, privatePath: "sensitive-fixture" });
    expect((await GET(new Request(url))).status).toBe(503);
    inspect.mockResolvedValue({ ...initial, complete: false, issues: Array(2).fill({ id: "@deepseek-ai/dsh-missing", code: "metadata-unavailable" }) });
    expect((await GET(new Request(url))).status).toBe(503);
  });
  it("cancels before inspection and after an in-flight read", async () => {
    const controller = new AbortController(); controller.abort();
    expect((await GET(new Request(url, { signal: controller.signal }))).status).toBe(408); expect(inspect).not.toHaveBeenCalled();
    const inFlight = new AbortController(); inspect.mockImplementation(async () => { inFlight.abort(); return initial; });
    expect((await GET(new Request(url, { signal: inFlight.signal }))).status).toBe(408);
  });
});
