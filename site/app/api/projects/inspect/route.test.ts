import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { LocalProjectStore, openProject } from "@/core/projects/server/store";
import { projectState } from "@/core/projects/test-fixture";
import { PROJECT_INSPECTION_LIMITS, projectInspectionSchema } from "@/core/projects/inspection";
import { STUDIO_STORAGE_VERSION } from "@/core/repository/studio-repository";
import { POST as projectPost } from "../route";
import { POST } from "./route";

let root: string, store: LocalProjectStore;
const origin = "http://127.0.0.1:3001";
function request(body: unknown, headers: Record<string, string> = {}) {
  return new Request(`${origin}/api/projects/inspect`, { method: "POST", headers: { origin, "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
}
function installUnknown() {
  const manifest = store.read(), state = projectState();
  const value = { ...manifest, state: { ...state, dataProduct: { ...state.dataProduct, notebooks: {
    page: { name: "Preview notebook", revision: 3, cells: [
      { id: "known", kind: "text", title: "Plain source", markdown: "<script>plain text only</script>" },
      { id: "future", kind: "pivot", title: "Unknown step", payload: "opaque private content" },
    ] },
  } } } };
  writeFileSync(join(store.root, "agentcanvas.project.json"), JSON.stringify(value));
  return value;
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agentcanvas-inspection-api-"));
  vi.stubEnv("STUDIO_LOCAL_STATE_DIR", join(root, "private-state"));
  store = LocalProjectStore.create(join(root, "project"), "Inspection fixture");
});
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.startsWith(join(tmpdir(), "agentcanvas-inspection-api-"))) throw new Error("Unsafe fixture cleanup");
  rmSync(root, { recursive: true, force: true });
});
describe("standalone project inspection API", () => {
  it("previews an unregistered unknown-cell project without issuing a handle, revealing opaque content or modifying files", async () => {
    installUnknown();
    const path = join(store.root, "agentcanvas.project.json"), before = readFileSync(path);
    const response = await POST(request({ path: store.root }));
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("private, no-store");
    const result = projectInspectionSchema.parse(await response.json());
    expect(result.unknownCellCount).toBe(1); expect(result.notebooks[0].cells[1].support).toBe("unknown");
    expect(JSON.stringify(result)).not.toMatch(/opaque private content|handle|dataProduct|agentcanvas.project.json/);
    expect(JSON.stringify(result)).not.toContain(store.root);
    expect(readFileSync(path)).toEqual(before);
    expect(existsSync(join(root, "private-state"))).toBe(false);
    expect(readdirSync(store.root).sort()).toEqual(["agentcanvas.project.json", "files", "tables"]);
    const open = await projectPost(new Request(`${origin}/api/projects`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ action: "open", path: store.root }) }));
    expect(open.status).toBe(409); expect(existsSync(join(root, "private-state", "local-projects.json"))).toBe(false);
    expect(readFileSync(path)).toEqual(before);
  });
  it("allows normal projects without requiring a registry and does not modify an existing registry on later inspection", async () => {
    expect((await POST(request({ path: store.root }))).status).toBe(200);
    expect(existsSync(join(root, "private-state"))).toBe(false);
    const session = openProject(store.root), indexPath = join(root, "private-state", "local-projects.json"), beforeIndex = readFileSync(indexPath);
    installUnknown();
    const response = await POST(request({ path: store.root }, { "x-agentcanvas-project": session.handle }));
    expect(response.status).toBe(200); expect(readFileSync(indexPath)).toEqual(beforeIndex);
    expect(projectInspectionSchema.parse(await response.json())).not.toHaveProperty("handle");
  });
  it.each(["known-cell", "future-version", "future-format", "json"] as const)("refuses %s contents without leaking payloads or writing", async (reason) => {
    const value = installUnknown(), path = join(store.root, "agentcanvas.project.json");
    const invalid = reason === "future-version" ? { ...value, state: { ...value.state, version: STUDIO_STORAGE_VERSION + 1 } }
      : reason === "future-format" ? { ...value, format: "agentcanvas-local-project-v2" }
        : { ...value, state: { ...value.state, dataProduct: { ...value.state.dataProduct, notebooks: { page: {
          name: "Bad known", revision: 0, cells: [...value.state.dataProduct.notebooks.page.cells, { id: "bad", kind: "python", code: "private invalid code" }],
        } } } } };
    writeFileSync(path, reason === "json" ? "{private invalid json" : JSON.stringify(invalid));
    const before = readFileSync(path), response = await POST(request({ path: store.root }));
    expect(response.status).toBe(reason === "json" ? 500 : 409);
    const result: unknown = await response.json();
    expect(JSON.stringify(result)).not.toMatch(/opaque private content|private invalid|dataProduct|payload/);
    expect(JSON.stringify(result)).not.toContain(store.root);
    expect(readFileSync(path)).toEqual(before); expect(existsSync(join(root, "private-state"))).toBe(false);
  });
  it("applies same-origin, content-type, strict-body and size checks before reading project metadata", async () => {
    installUnknown(); const inspect = vi.spyOn(LocalProjectStore.prototype, "inspect");
    expect((await POST(request({ path: store.root }, { origin: "https://external.invalid" }))).status).toBe(403);
    expect((await POST(request({ path: store.root }, { "content-type": "text/plain" }))).status).toBe(415);
    expect((await POST(request({ path: store.root, handle: "forged" }))).status).toBe(400);
    expect((await POST(request({ path: store.root, padding: "x".repeat(PROJECT_INSPECTION_LIMITS.requestBytes) }))).status).toBe(413);
    expect(inspect).not.toHaveBeenCalled();
  });
});
