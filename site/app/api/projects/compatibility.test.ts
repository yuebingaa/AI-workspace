import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { GET, POST } from "./route";
import { PROJECT_HEADER, projectSessionSchema } from "@/core/projects/contracts";
import { projectState, projectUpload } from "@/core/projects/test-fixture";
import { projectByHandle } from "@/core/projects/server/store";
import { projectErrorResponse } from "@/core/projects/server/request";
import { projectCompatibilitySchema } from "@/core/projects/compatibility";
import { STUDIO_STORAGE_VERSION } from "@/core/repository/studio-repository";

const origin = "http://127.0.0.1:3001";
let root: string;
function request(body?: unknown, handle?: string, requestOrigin = origin) {
  return new Request(`${origin}/api/projects`, { method: body === undefined ? "GET" : "POST",
    headers: { origin: requestOrigin, "content-type": "application/json", ...(handle ? { [PROJECT_HEADER]: handle } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function create() {
  const response = await POST(request({ action: "create", path: join(root, "project"), name: "Synthetic compatibility" }));
  expect(response.status).toBe(200);
  return projectSessionSchema.parse(await response.json());
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agentcanvas-compatibility-api-"));
  vi.stubEnv("STUDIO_LOCAL_STATE_DIR", join(root, "private-state"));
});
afterEach(() => {
  vi.unstubAllEnvs();
  if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.startsWith(join(tmpdir(), "agentcanvas-compatibility-api-"))) throw new Error("Unsafe fixture cleanup");
  rmSync(root, { recursive: true, force: true });
});
describe("project compatibility API", () => {
  it.each(["notebook-cells", "workspace-version", "project-format"] as const)("returns bounded 409 %s diagnostics for open and load without modifying the project", async (reason) => {
    const session = await create(), store = projectByHandle(session.handle);
    const state = projectState(); store.saveState(state, 0);
    const path = join(session.path, "agentcanvas.project.json"), manifest = store.read();
    const future = reason === "project-format" ? { ...manifest, format: "agentcanvas-local-project-v2" }
      : { ...manifest, state: reason === "workspace-version" ? { ...state, version: STUDIO_STORAGE_VERSION + 1 }
        : { ...state, dataProduct: { ...state.dataProduct, notebooks: {
          privateNotebookId: { name: "private notebook title", revision: 0, cells: [{ kind: "pivot", id: "private-cell-id", title: "private cell title", payload: "private-sql-secret" }] },
        } } } };
    const bytes = JSON.stringify(future); writeFileSync(path, bytes);
    const indexPath = join(root, "private-state", "local-projects.json"), beforeIndex = readFileSync(indexPath);
    for (const response of [await GET(request(undefined, session.handle)), await POST(request({ action: "open", path: session.path }))]) {
      expect(response.status).toBe(409);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      const body = z.object({ error: z.object({ message: z.string(), compatibility: projectCompatibilitySchema }).strict() }).strict().parse(await response.json());
      expect(projectCompatibilitySchema.parse(body.error.compatibility).reason).toBe(reason);
      expect(body.error.message).toMatch(/未被本次操作修改/);
      expect(JSON.stringify(body)).not.toMatch(/privateNotebookId|private-cell-id|private notebook|private cell|private-sql-secret/);
      expect(readFileSync(path, "utf8")).toBe(bytes);
      expect(readFileSync(indexPath)).toEqual(beforeIndex);
    }
  });
  it("refuses a valid pending save against externally replaced unknown definitions then reopens after restoration", async () => {
    const session = await create(), store = projectByHandle(session.handle), table = store.putTable(await projectUpload());
    const file = store.saveOriginal("synthetic.csv", Buffer.from("category,amount\nAlpha,10"), table.dataset.datasetId);
    const state = projectState(table); store.saveState(state, 0);
    const path = join(session.path, "agentcanvas.project.json"), compatible = readFileSync(path), manifest = store.read();
    const future = { ...manifest, state: { ...state, dataProduct: { ...state.dataProduct, notebooks: {
      future: { name: "future", revision: 1, cells: [{ kind: "pivot", payload: "preserved" }] },
    } } } };
    const bytes = JSON.stringify(future); writeFileSync(path, bytes);
    for (const body of [{ action: "save", state, stateRevision: 1 }, { action: "archiveFile", fileId: file.id }]) {
      const response = await POST(request(body, session.handle));
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: { compatibility: { reason: "notebook-cells" } } });
      expect(readFileSync(path, "utf8")).toBe(bytes);
    }
    writeFileSync(path, compatible);
    const reopened = await GET(request(undefined, session.handle));
    expect(reopened.status).toBe(200);
    expect(projectSessionSchema.parse(await reopened.json()).manifest.stateRevision).toBe(1);
    expect(store.getOriginal(file.id).entry.deletedAt).toBeUndefined();
    expect(store.getTable(table.dataset.datasetId)).toEqual(table);
    expect((await POST(request({ action: "save", state, stateRevision: 1 }, session.handle))).status).toBe(200);
  });
  it("keeps local-origin checks before compatibility disclosure and does not attach metadata to generic errors", async () => {
    const session = await create(), path = join(session.path, "agentcanvas.project.json");
    writeFileSync(path, JSON.stringify({ format: "agentcanvas-local-project-v2", secret: "private" }));
    const denied = await POST(request({ action: "open", path: session.path }, undefined, "https://external.invalid"));
    expect(denied.status).toBe(403); expect(await denied.json()).not.toHaveProperty("error.compatibility");
    writeFileSync(path, "{malformed-private");
    const invalid = await GET(request(undefined, session.handle));
    expect(invalid.status).toBe(500); expect(await invalid.json()).not.toHaveProperty("error.compatibility");
    const forged = projectErrorResponse(Object.assign(new Error("private forged error"), { name: "ProjectCompatibilityError", status: 409, compatibility: { code: "project_incompatible", reason: "project-format" } }));
    expect(forged.status).toBe(500); expect(await forged.json()).not.toHaveProperty("error.compatibility");
  });
  it("preserves typed diagnostics after server module reload", async () => {
    const session = await create(), store = projectByHandle(session.handle), state = projectState();
    store.saveState(state, 0);
    writeFileSync(join(session.path, "agentcanvas.project.json"), JSON.stringify({ ...store.read(), state: { ...state, version: STUDIO_STORAGE_VERSION + 1 } }));
    vi.resetModules();
    const reloaded = await import("./route");
    const response = await reloaded.GET(request(undefined, session.handle));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { compatibility: { reason: "workspace-version" } } });
  });
});
