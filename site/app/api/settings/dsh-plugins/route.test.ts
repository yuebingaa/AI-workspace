import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultDshPluginDocument, dshPluginSettingsSchema } from "@/core/agent-engines/plugin-settings";
import { DshPluginSettingsStore } from "@/core/agent-engines/server/plugin-settings";
import { GET, PATCH } from "./route";
const deps = vi.hoisted(() => ({ inspect: vi.fn(), store: vi.fn(), active: 0 }));
vi.mock("@/core/agent-engines/server/dsh-driver", () => ({ inspectOfficialDshPluginPackages: deps.inspect }));
vi.mock("@/core/agent-engines/server/selection", () => ({ agentEngineSelection: { status: () => ({ activeTasks: deps.active }) } }));
vi.mock("@/core/agent-engines/server/plugin-settings", async importOriginal => ({
  ...await importOriginal<typeof import("@/core/agent-engines/server/plugin-settings")>(), configuredDshPluginSettings: deps.store,
}));
const url = "http://127.0.0.1:3001/api/settings/dsh-plugins";
const origin = "http://127.0.0.1:3001";
let saved = defaultDshPluginDocument();
beforeEach(() => {
  saved = defaultDshPluginDocument(); deps.active = 0;
  deps.inspect.mockReset().mockResolvedValue({ "dsh-skill": { installed: true }, "dsh-tool-skill": { installed: true } });
  deps.store.mockReset().mockImplementation(() => new DshPluginSettingsStore({ load: () => saved, save: next => { saved = next; } }));
});
afterEach(() => vi.restoreAllMocks());
function patch(body: unknown, options: RequestInit = {}) {
  return new Request(url, { method: "PATCH", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body), ...options });
}
describe("DSH plugin settings API", () => {
  it("returns strict no-store metadata without credentials or configuration paths", async () => {
    const response = await GET(new Request(url));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const body = dshPluginSettingsSchema.parse(await response.json());
    expect(body.document).toEqual(saved);
    expect(JSON.stringify(body)).not.toMatch(/apiKey|brokerToken|manifestPath/);
  });
  it("saves config and reloads it, rejecting a stale second writer", async () => {
    expect((await PATCH(patch({ revision: 0, config: { skills: true } }))).status).toBe(200);
    expect(dshPluginSettingsSchema.parse(await (await GET(new Request(url))).json()).document.config.skills).toBe(true);
    expect((await PATCH(patch({ revision: 0, config: { skills: false } }))).status).toBe(409);
    expect(saved.config.skills).toBe(true);
  });
  it.each(["https://untrusted.invalid", "http://localhost:3001"])("rejects foreign origin %s before inspection or writing", async foreign => {
    expect((await PATCH(patch({ revision: 0, config: { skills: true } }, { headers: { origin: foreign, "content-type": "application/json" } }))).status).toBe(403);
    expect(deps.inspect).not.toHaveBeenCalled(); expect(saved.revision).toBe(0);
  });
  it("rejects cross-site GET and missing mutation provenance", async () => {
    expect((await GET(new Request(url, { headers: { "sec-fetch-site": "cross-site" } }))).status).toBe(403);
    expect((await PATCH(patch({}, { headers: { "content-type": "application/json" } }))).status).toBe(403);
  });
  it.each([{ revision: 0, config: { skills: true, shell: true } }, { revision: -1, config: { skills: false } }, { revision: 0, config: { skills: "yes" } }])("rejects invalid input %j", async body => {
    expect((await PATCH(patch(body))).status).toBe(400); expect(saved.revision).toBe(0);
  });
  it("rejects wrong content type, malformed or excessive body", async () => {
    expect((await PATCH(patch({}, { headers: { origin, "content-type": "text/plain" } }))).status).toBe(415);
    expect((await PATCH(patch({}, { body: "not JSON" }))).status).toBe(400);
    expect((await PATCH(patch({}, { body: "x".repeat(2100) }))).status).toBe(413);
  });
  it("blocks in-flight tasks and unavailable dependency without a write", async () => {
    deps.active = 1;
    expect((await PATCH(patch({ revision: 0, config: { skills: true } }))).status).toBe(409);
    deps.active = 0; deps.inspect.mockResolvedValue({ "dsh-tool-skill": { installed: true } });
    expect((await PATCH(patch({ revision: 0, config: { skills: true } }))).status).toBe(409);
    expect(saved.revision).toBe(0);
  });
  it("allows disabling a missing plugin but does not invent persistence", async () => {
    saved = { ...saved, config: { skills: true } }; deps.inspect.mockResolvedValue({});
    expect((await PATCH(patch({ revision: 0, config: { skills: false } }))).status).toBe(200);
    deps.store.mockReturnValue(new DshPluginSettingsStore());
    expect((await PATCH(patch({ revision: 0, config: { skills: false } }))).status).toBe(503);
  });
  it("redacts internal failures and rejects cancellation after dependency lookup", async () => {
    deps.inspect.mockRejectedValue(new Error("secret-synthetic-path"));
    const response = await GET(new Request(url));
    expect(response.status).toBe(500); expect(await response.text()).not.toContain("secret-synthetic-path");
    const controller = new AbortController();
    deps.inspect.mockImplementation(async () => { controller.abort(); return {}; });
    expect((await PATCH(patch({ revision: 0, config: { skills: false } }, { signal: controller.signal }))).status).toBe(408);
    expect(saved.revision).toBe(0);
  });
});
