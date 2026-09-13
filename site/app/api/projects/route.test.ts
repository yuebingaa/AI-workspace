import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { GET, POST } from "./route";
import { POST as upload, GET as listDatasets } from "../datasets/route";
import { GET as getDataset, DELETE as deleteDataset } from "../datasets/[datasetId]/route";
import { POST as saveOriginal, GET as readOriginal } from "./files/route";
import { PROJECT_HEADER, PROJECT_LIMITS, type ProjectSession } from "@/core/projects/contracts";
import { projectState } from "@/core/projects/test-fixture";
import { datasetUploadResponseSchema } from "@/core/datasets/contracts";

let root: string;
const origin = "http://127.0.0.1:3001";
function request(body?: unknown, handle?: string, extra: Record<string, string> = {}) {
  return new Request(`${origin}/api/projects`, { method: body === undefined ? "GET" : "POST",
    headers: { origin, "content-type": "application/json", ...(handle ? { [PROJECT_HEADER]: handle } : {}), ...extra },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function create(name = "project") {
  const response = await POST(request({ action: "create", path: join(root, name), name }));
  expect(response.status).toBe(200); return await response.json() as ProjectSession;
}
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "agentcanvas-project-api-")); vi.stubEnv("STUDIO_LOCAL_STATE_DIR", join(root, "private-state")); });
afterEach(() => {
  vi.unstubAllEnvs();
  if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.startsWith(join(tmpdir(), "agentcanvas-project-api-"))) throw new Error("Unsafe fixture cleanup");
  rmSync(root, { recursive: true, force: true });
});
describe("local project API scope", () => {
  it("requires loopback and same-origin writes before accessing the filesystem", async () => {
    expect((await POST(request({ action: "create", path: join(root, "blocked"), name: "blocked" }, undefined, { origin: "https://external.invalid" }))).status).toBe(403);
    expect((await GET(new Request("https://external.invalid/api/projects"))).status).toBe(403);
    expect((await POST(new Request(`${origin}/api/projects`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }))).status).toBe(403);
    expect((await GET(request(undefined, "not-a-uuid"))).status).toBe(400);
  });
  it("creates, opens, lists and revision-checks project definitions", async () => {
    const project = await create();
    expect(await (await GET(request())).json()).toMatchObject({ projects: [{ handle: project.handle }] });
    expect((await POST(request({ action: "save", state: projectState(), stateRevision: 0 }, project.handle))).status).toBe(200);
    expect((await POST(request({ action: "save", state: projectState(), stateRevision: 0 }, project.handle))).status).toBe(409);
    expect(await (await POST(request({ action: "open", path: project.path }))).json()).toMatchObject({ handle: project.handle, manifest: { stateRevision: 1 } });
  });
  it("bounds malformed and oversized requests and cancels stalled original uploads", async () => {
    expect((await POST(new Request(`${origin}/api/projects`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: "{" }))).status).toBe(400);
    expect((await POST(request({}, undefined, { "content-length": String(PROJECT_LIMITS.manifestBytes + 1) }))).status).toBe(413);
    const project = await create(); const abort = new AbortController(), cancel = vi.fn(() => new Promise<void>(() => {}));
    const response = saveOriginal(new Request(`${origin}/api/projects/files`, { method: "POST", headers: { origin, [PROJECT_HEADER]: project.handle, "x-file-name": "test.csv" },
      body: new ReadableStream({ cancel }), signal: abort.signal, duplex: "half" } as RequestInit & { duplex: "half" }));
    abort.abort(); expect((await response).status).toBe(408); expect(cancel).toHaveBeenCalledTimes(1);
    expect((await (await GET(request(undefined, project.handle))).json() as ProjectSession).manifest.files).toHaveLength(0);
  });
  it("routes imports and original bytes only into the selected project", async () => {
    const a = await create("a"), b = await create("b");
    const csv = "category,amount\nAlpha,10\nBeta,20";
    const response = await upload(new Request(`${origin}/api/datasets`, { method: "POST", headers: { origin, [PROJECT_HEADER]: a.handle, "content-type": "text/csv", "x-file-name": "synthetic.csv" }, body: csv }));
    expect(response.status).toBe(201);
    const payload = datasetUploadResponseSchema.parse(await response.json()); const id = payload.dataset.datasetId;
    expect(payload.dataset.storageMode).toBe("project"); expect(payload.dataset.expiresAt).toBeUndefined();
    expect(await (await listDatasets(request(undefined, b.handle))).json()).toEqual({ datasets: [] });
    const dataRequest = (handle: string, method = "GET") => new Request(`${origin}/api/datasets/${id}`, { method, headers: { origin, [PROJECT_HEADER]: handle } });
    expect((await getDataset(dataRequest(a.handle))).status).toBe(200);
    expect((await getDataset(dataRequest(b.handle))).status).toBe(404);
    const original = await saveOriginal(new Request(`${origin}/api/projects/files`, { method: "POST", headers: { origin, [PROJECT_HEADER]: a.handle, "x-file-name": "synthetic.csv", "x-dataset-id": id }, body: csv }));
    expect(original.status).toBe(201);
    const manifest = await (await GET(request(undefined, a.handle))).json() as ProjectSession;
    const fileId = manifest.manifest.files[0].id;
    expect(await (await readOriginal(new Request(`${origin}/api/projects/files?id=${fileId}`, { headers: { [PROJECT_HEADER]: a.handle } }))).text()).toBe(csv);
    expect((await readOriginal(new Request(`${origin}/api/projects/files?id=${fileId}`, { headers: { [PROJECT_HEADER]: b.handle } }))).status).toBe(404);
    expect((await deleteDataset(dataRequest(a.handle, "DELETE"))).status).toBe(204);
    expect((await getDataset(dataRequest(a.handle))).status).toBe(404);
    expect((await POST(request({ action: "restoreTable", datasetId: id }, a.handle))).status).toBe(200);
    expect((await getDataset(dataRequest(a.handle))).status).toBe(200);
  });
});
