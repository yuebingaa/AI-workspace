import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROJECT_HEADER } from "@/core/projects/contracts";
import { LocalProjectStore, openProject, projectByHandle } from "@/core/projects/server/store";
import { projectState, projectUpload } from "@/core/projects/test-fixture";
import { INITIAL_WORKSPACE_PAGE_ID } from "@/core/workspaces";
import type { NotebookCell } from "../definition";
import { readNotebookRequest, resolveNotebookPythonFiles } from "./python-files";

const prefix = "agentcanvas-notebook-file-archive-", origin = "http://127.0.0.1:3001";
let testRoot: string;
beforeEach(() => {
  testRoot = mkdtempSync(join(tmpdir(), prefix));
  vi.stubEnv("STUDIO_LOCAL_STATE_DIR", join(testRoot, "state"));
});
afterEach(() => {
  vi.unstubAllEnvs();
  if (dirname(resolve(testRoot)) !== resolve(tmpdir()) || !testRoot.startsWith(join(tmpdir(), prefix))) throw new Error("Unsafe fixture cleanup");
  rmSync(testRoot, { recursive: true, force: true });
});

function python(fileNames = ["sales.csv"]): Extract<NotebookCell, { kind: "python" }> {
  return { id: "python", kind: "python", title: "Read original", inputCellIds: [], fileNames,
    outputName: "python_rows", code: 'python_rows = pd.read_csv(files["sales.csv"])' };
}
function request(handle: string, body?: FormData) {
  return new Request(`${origin}/api/notebook/run`, { method: "POST", headers: { origin, [PROJECT_HEADER]: handle }, body });
}
async function setup() {
  const session = openProject(join(testRoot, "project"), "Notebook file fixture"), store = projectByHandle(session.handle);
  const uploaded = store.putTable(await projectUpload()), bytes = Buffer.from("category,amount\nAlpha,10\nBeta,20\nAlpha,5");
  const file = store.saveOriginal("sales.csv", bytes, uploaded.dataset.datasetId), state = projectState(uploaded);
  const cells: NotebookCell[] = [python(),
    { id: "summary", kind: "sql", title: "Python downstream", inputCellIds: ["python"], outputName: "summary_rows", sql: "SELECT SUM(amount) AS amount FROM python_rows" },
    { id: "data", kind: "data", title: "Independent imported table", sourceDataSourceId: uploaded.dataset.datasetId, outputName: "data_rows" },
    { id: "table", kind: "table", title: "Independent table result", inputCellId: "data", columns: ["category", "amount"] },
  ];
  state.dataProduct.notebooks = { [INITIAL_WORKSPACE_PAGE_ID]: { name: "Saved file analysis", revision: 1, cells } };
  store.saveState(state, 0);
  return { session, store, uploaded, bytes, file, cells };
}

describe("Notebook file resolver and recoverable original archival", () => {
  it("omits an archived explicit Python input, preserving its definitions, imported table and exact restorable bytes", async () => {
    const { session, store, uploaded, bytes, file, cells } = await setup(), before = store.read();
    expect(resolveNotebookPythonFiles(request(session.handle), cells, [])).toEqual([{ name: file.name, bytes }]);
    store.archiveOriginal(file.id);
    const reopened = new LocalProjectStore(session.path), archived = reopened.read();
    expect(archived.files[0]).toMatchObject({ ...file, deletedAt: expect.any(String) });
    expect(archived.tables).toEqual(before.tables);
    expect(archived.state).toEqual(before.state);
    expect(archived.stateRevision).toBe(before.stateRevision);
    expect(reopened.getTable(uploaded.dataset.datasetId)).toEqual(uploaded);
    expect(resolveNotebookPythonFiles(request(session.handle), cells, [])).toEqual([]);
    expect(() => reopened.getOriginal(file.id)).toThrow("不存在");
    expect(readFileSync(join(session.path, "files", file.file))).toEqual(bytes);

    reopened.restoreOriginal(file.id);
    const restored = new LocalProjectStore(session.path), after = restored.read();
    expect(after.files).toEqual(before.files);
    expect(after.tables).toEqual(before.tables);
    expect(after.state).toEqual(before.state);
    expect(after.stateRevision).toBe(before.stateRevision);
    expect(restored.getOriginal(file.id)).toEqual({ entry: file, bytes });
    expect(resolveNotebookPythonFiles(request(session.handle), cells, [])).toEqual([{ name: file.name, bytes }]);
  });

  it("rejects multiple active project originals with the same exact name without modifying the project", async () => {
    const { session, store, uploaded, file, cells } = await setup();
    const second = store.saveOriginal(file.name, Buffer.from("category,amount\nSecond,200"), uploaded.dataset.datasetId);
    expect(second.id).not.toBe(file.id);
    const before = readFileSync(join(session.path, "agentcanvas.project.json"));
    expect(() => resolveNotebookPythonFiles(request(session.handle), cells, [])).toThrow("多个同名原件");
    expect(readFileSync(join(session.path, "agentcanvas.project.json"))).toEqual(before);
    store.archiveOriginal(second.id);
    expect(resolveNotebookPythonFiles(request(session.handle), cells, [])).toEqual([{ name: file.name, bytes: store.getOriginal(file.id).bytes }]);
  });

  it("prefers a parsed multipart upload even when stored same-name originals are ambiguous", async () => {
    const { session, store, uploaded, file, cells } = await setup();
    store.saveOriginal(file.name, Buffer.from("category,amount\nSecond,200"), uploaded.dataset.datasetId);
    const before = store.read(), supplied = "category,amount\nRequest,300";
    const form = new FormData();
    form.append("payload", JSON.stringify({ document: before.state!.dataProduct.notebooks![INITIAL_WORKSPACE_PAGE_ID] }));
    form.append("file", new File([supplied], file.name, { type: "text/csv" }));
    form.append("file", new File(["value\n999"], "unrequested.csv", { type: "text/csv" }));
    const incoming = request(session.handle, form), parsed = await readNotebookRequest(incoming);
    expect(parsed.files).toHaveLength(2);
    const resolved = resolveNotebookPythonFiles(incoming, cells, parsed.files);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].name).toBe(file.name);
    expect(Buffer.from(resolved[0].bytes).toString("utf8")).toBe(supplied);
    expect(store.read()).toEqual(before);
  });

  it("allows explicit multipart input after archival without silently restoring the archived original", async () => {
    const { session, store, file, cells } = await setup();
    store.archiveOriginal(file.id);
    const before = store.read(), supplied = "category,amount\nTemporary,400", form = new FormData();
    form.append("payload", JSON.stringify({ document: before.state!.dataProduct.notebooks![INITIAL_WORKSPACE_PAGE_ID] }));
    form.append("file", new File([supplied], file.name, { type: "text/csv" }));
    const incoming = request(session.handle, form), parsed = await readNotebookRequest(incoming);
    const resolved = resolveNotebookPythonFiles(incoming, cells, parsed.files);
    expect(resolved).toHaveLength(1);
    expect(Buffer.from(resolved[0].bytes).toString("utf8")).toBe(supplied);
    expect(store.read()).toEqual(before);
    expect(resolveNotebookPythonFiles(request(session.handle), cells, [])).toEqual([]);
  });

  it("keeps name resolution scoped to the requested project, including after its original is archived", async () => {
    const { session, store, file, cells, bytes } = await setup();
    const otherSession = openProject(join(testRoot, "other-project"), "Other synthetic project"), otherStore = projectByHandle(otherSession.handle);
    const otherUpload = otherStore.putTable(await projectUpload()), otherBytes = Buffer.from("category,amount\nOther,500");
    otherStore.saveOriginal(file.name, otherBytes, otherUpload.dataset.datasetId);
    const otherBefore = otherStore.read();
    expect(resolveNotebookPythonFiles(request(session.handle), cells, [])).toEqual([{ name: file.name, bytes }]);
    expect(resolveNotebookPythonFiles(request(otherSession.handle), cells, [])).toEqual([{ name: file.name, bytes: otherBytes }]);
    store.archiveOriginal(file.id);
    expect(resolveNotebookPythonFiles(request(session.handle), cells, [])).toEqual([]);
    expect(otherStore.read()).toEqual(otherBefore);
  });

  it("matches project file names case-sensitively and resolves duplicate declared inputs only once", async () => {
    const { session, file, bytes } = await setup();
    expect(resolveNotebookPythonFiles(request(session.handle), [python(["Sales.csv"])], [])).toEqual([]);
    expect(resolveNotebookPythonFiles(request(session.handle), [python([file.name, file.name])], [])).toEqual([{ name: file.name, bytes }]);
  });
});
