import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "./route";
import { GET as getOriginal } from "./files/route";
import { GET as getDataset } from "../datasets/[datasetId]/route";
import { PROJECT_HEADER, projectSessionSchema } from "@/core/projects/contracts";
import { projectByHandle } from "@/core/projects/server/store";
import { projectUpload } from "@/core/projects/test-fixture";

const origin = "http://127.0.0.1:3001", prefix = "agentcanvas-file-api-";
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), prefix));
  vi.stubEnv("STUDIO_LOCAL_STATE_DIR", join(root, "state"));
});
afterEach(() => {
  vi.unstubAllEnvs();
  if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.startsWith(join(tmpdir(), prefix))) throw new Error("Unsafe fixture cleanup");
  rmSync(root, { recursive: true, force: true });
});
function request(path: string, handle?: string, body?: unknown, requestOrigin = origin) {
  return new Request(`${origin}${path}`, { method: body === undefined ? "GET" : "POST",
    headers: { origin: requestOrigin, ...(handle ? { [PROJECT_HEADER]: handle } : {}), "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function setup(name = "synthetic") {
  const response = await POST(request("/api/projects", undefined, { action: "create", path: join(root, name), name }));
  expect(response.status).toBe(200);
  const session = projectSessionSchema.parse(await response.json()), store = projectByHandle(session.handle);
  const uploaded = store.putTable(await projectUpload());
  return { session, store, uploaded, entry: store.read().tables[0] };
}
async function expectDiagnostic(response: Response, location: string) {
  expect(response.status).toBe(409);
  expect(response.headers.get("cache-control")).toContain("no-store");
  const text = await response.text();
  expect(text).toContain(location); expect(text).not.toContain(root.replaceAll("\\", "\\\\"));
  expect(text).not.toContain("private-synthetic-payload");
}

describe("project resource diagnostics via existing HTTP routes", () => {
  it("returns an actionable conflict for missing table bytes, not an expired Dataset 404", async () => {
    const { session, store, uploaded, entry } = await setup();
    const path = join(session.path, "tables", entry.file), before = store.read();
    renameSync(path, join(root, "table-backup.json"));
    await expectDiagnostic(await getDataset(request(`/api/datasets/${uploaded.dataset.datasetId}`, session.handle)), `tables/${entry.file}`);
    const catalog = await GET(request("/api/projects", session.handle));
    expect(catalog.status).toBe(200);
    expect(projectSessionSchema.parse(await catalog.json()).manifest).toEqual(before);
    renameSync(join(root, "table-backup.json"), path);
    expect((await getDataset(request(`/api/datasets/${uploaded.dataset.datasetId}`, session.handle))).status).toBe(200);
  });

  it("returns the original's relative location while the derived table remains readable", async () => {
    const { session, store, uploaded } = await setup();
    const file = store.saveOriginal("synthetic.csv", Buffer.from("category,amount\nAlpha,10"), uploaded.dataset.datasetId);
    const before = store.read();
    renameSync(join(session.path, "files", file.file), join(root, "original-backup.csv"));
    await expectDiagnostic(await getOriginal(request(`/api/projects/files?id=${file.id}`, session.handle)), `files/${file.file}`);
    expect((await getDataset(request(`/api/datasets/${uploaded.dataset.datasetId}`, session.handle))).status).toBe(200);
    expect(store.read()).toEqual(before);
  });

  it.each(["missing", "changed"] as const)("restore POST leaves the %s resource archived until real bytes are recovered", async (fault) => {
    const { session, store, uploaded, entry } = await setup();
    const id = uploaded.dataset.datasetId, path = join(session.path, "tables", entry.file), bytes = readFileSync(path);
    store.deleteTable(id);
    const before = store.read(), savedManifest = readFileSync(join(session.path, "agentcanvas.project.json"));
    if (fault === "missing") renameSync(path, join(root, "table-backup.json"));
    else writeFileSync(path, "private-synthetic-payload");
    const body = { action: "restoreTable", datasetId: id };
    await expectDiagnostic(await POST(request("/api/projects", session.handle, body)), `tables/${entry.file}`);
    expect(store.read()).toEqual(before);
    expect(readFileSync(join(session.path, "agentcanvas.project.json"))).toEqual(savedManifest);
    if (fault === "missing") renameSync(join(root, "table-backup.json"), path);
    else writeFileSync(path, bytes);
    const recovered = await POST(request("/api/projects", session.handle, body));
    expect(recovered.status).toBe(200);
    expect(projectSessionSchema.parse(await recovered.json()).manifest.tables[0].deletedAt).toBeUndefined();
    expect(store.getTable(id)).toEqual(uploaded);
  });

  it("does not disclose file locations to another project or an external origin", async () => {
    const a = await setup("a"), b = await setup("b"), id = a.uploaded.dataset.datasetId;
    renameSync(join(a.session.path, "tables", a.entry.file), join(root, "table-backup.json"));
    for (const [handle, requestOrigin, status] of [[b.session.handle, origin, 404], [a.session.handle, "https://external.invalid", 403]] as const) {
      const response = await getDataset(request(`/api/datasets/${id}`, handle, undefined, requestOrigin));
      expect(response.status).toBe(status); expect(await response.text()).not.toContain(a.entry.file);
    }
  });

  it("retains diagnostic error semantics after a development module reload", async () => {
    const { session, store, uploaded, entry } = await setup();
    store.deleteTable(uploaded.dataset.datasetId);
    const before = store.read();
    renameSync(join(session.path, "tables", entry.file), join(root, "table-backup.json"));
    vi.resetModules();
    const reloaded = await import("./route");
    await expectDiagnostic(await reloaded.POST(request("/api/projects", session.handle,
      { action: "restoreTable", datasetId: uploaded.dataset.datasetId })), `tables/${entry.file}`);
    expect(store.read()).toEqual(before);
  });
});
