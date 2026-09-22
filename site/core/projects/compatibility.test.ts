import { describe, expect, it } from "vitest";
import { NOTEBOOK_CELL_KINDS } from "@/core/notebook/cell-catalog";
import { STUDIO_STORAGE_VERSION } from "@/core/repository/studio-repository";
import { PROJECT_FORMAT } from "./contracts";
import { detectProjectCompatibility, projectCompatibilityFromError, projectCompatibilityMessage, projectCompatibilitySchema } from "./compatibility";

const supported = { projectFormat: PROJECT_FORMAT, workspaceVersion: STUDIO_STORAGE_VERSION };
function manifest(cells: unknown[] = []) {
  return { format: PROJECT_FORMAT, state: { version: STUDIO_STORAGE_VERSION, dataProduct: { notebooks: { synthetic: { cells } } } } };
}
describe("bounded project compatibility diagnostics", () => {
  it("recognizes foreign AgentCanvas formats but not unrelated or malformed inputs", () => {
    expect(detectProjectCompatibility({ format: "agentcanvas-local-project-v2" }, supported)).toEqual({ code: "project_incompatible", reason: "project-format" });
    for (const value of [null, [], {}, { format: "another-product-v2" }, { format: "agentcanvas-local-project-v2\nprivate" }, { format: "agentcanvas-local-project-v9999999999" }]) {
      expect(detectProjectCompatibility(value, supported)).toBeNull();
    }
  });
  it("identifies newer safe integer workspace versions and leaves supported migrations unchanged", () => {
    for (let version = 0; version <= STUDIO_STORAGE_VERSION; version += 1) {
      expect(detectProjectCompatibility({ format: PROJECT_FORMAT, state: { version } }, supported)).toBeNull();
    }
    const issue = detectProjectCompatibility({ format: PROJECT_FORMAT, state: { version: STUDIO_STORAGE_VERSION + 1 } }, supported);
    expect(issue).toEqual({ code: "project_incompatible", reason: "workspace-version", detectedVersion: STUDIO_STORAGE_VERSION + 1, supportedVersion: STUDIO_STORAGE_VERSION });
    for (const version of ["7", 7.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(detectProjectCompatibility({ format: PROJECT_FORMAT, state: { version } }, supported)).toBeNull();
    }
  });
  it("does not disguise malformed known kinds or disabled Python as compatibility", () => {
    expect(detectProjectCompatibility(manifest(NOTEBOOK_CELL_KINDS.map((kind) => ({ kind }))), supported)).toBeNull();
    expect(detectProjectCompatibility(manifest([{}, { kind: null }, { kind: "" }, { kind: 42 }, { kind: "python", code: 123 }]), supported)).toBeNull();
  });
  it("returns one-based positions without titles, IDs, code or nested contents", () => {
    const value = manifest([{ kind: "data" }, { kind: "pivot", title: "private title", code: "secret", id: "private-id", payload: { text: "not a kind" } }]);
    const before = structuredClone(value), issue = detectProjectCompatibility(value, supported);
    expect(issue).toEqual({ code: "project_incompatible", reason: "notebook-cells", cells: [{ notebookIndex: 1, cellIndex: 2, kind: "pivot" }], total: 1, omitted: 0 });
    expect(projectCompatibilitySchema.safeParse(issue).success).toBe(true);
    expect(JSON.stringify(issue)).not.toMatch(/private|secret|payload/);
    expect(value).toEqual(before);
  });
  it("limits displayed positions while counting all unsupported cells within document bounds", () => {
    const value = { format: PROJECT_FORMAT, state: { version: STUDIO_STORAGE_VERSION, dataProduct: {
      notebooks: Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`n${index}`, { cells: Array.from({ length: 30 }, () => ({ kind: "pivot" })) }])),
    } } };
    const issue = detectProjectCompatibility(value, supported);
    expect(issue).toMatchObject({ reason: "notebook-cells", total: 900, omitted: 895 });
    expect(issue?.reason === "notebook-cells" && issue.cells).toHaveLength(5);
    expect(projectCompatibilitySchema.safeParse(issue).success).toBe(true);
    expect(JSON.stringify(issue).length).toBeLessThan(600);
  });
  it("does not expose non-tag values and does not recursively inspect arbitrary payload", () => {
    const issue = detectProjectCompatibility(manifest([{ kind: "<script>private</script>" }, { kind: "异常\nsecret" }, { kind: "X".repeat(81) }, { kind: "text", payload: { kind: "pivot" } }]), supported);
    expect(issue).toEqual({ code: "project_incompatible", reason: "notebook-cells", cells: [1, 2, 3].map((cellIndex) => ({ notebookIndex: 1, cellIndex })), total: 3, omitted: 0 });
    expect(projectCompatibilityMessage(issue!)).not.toMatch(/script|private|secret|XXXX/);
  });
  it("leaves out-of-bound or structurally malformed catalogs to strict schema validation", () => {
    expect(detectProjectCompatibility(manifest(Array.from({ length: 31 }, () => ({ kind: "pivot" }))), supported)).toBeNull();
    expect(detectProjectCompatibility({ format: PROJECT_FORMAT, state: { dataProduct: { notebooks: [] } } }, supported)).toBeNull();
    expect(detectProjectCompatibility({ format: PROJECT_FORMAT, state: { dataProduct: { notebooks: Object.fromEntries(Array.from({ length: 31 }, (_, i) => [i, { cells: [{ kind: "pivot" }] }])) } } }, supported)).toBeNull();
  });
  it("validates error metadata independently from error names or messages", () => {
    const compatibility = detectProjectCompatibility(manifest([{ kind: "pivot" }]), supported)!;
    expect(projectCompatibilityFromError(Object.assign(new Error("untrusted text"), { compatibility }))).toEqual(compatibility);
    for (const error of [new Error("project_incompatible"), null, { compatibility: { ...compatibility, extra: "private" } }, { compatibility: { ...compatibility, total: 4 } }, { compatibility: { code: "project_incompatible", reason: "workspace-version", supportedVersion: 6, detectedVersion: 5 } }]) {
      expect(projectCompatibilityFromError(error)).toBeNull();
    }
  });
  it("generates bounded actionable messages without suggesting deletion or automatic migration", () => {
    for (const value of [manifest([{ kind: "pivot" }]), { format: "agentcanvas-local-project-v2" }, { format: PROJECT_FORMAT, state: { version: STUDIO_STORAGE_VERSION + 1 } }]) {
      const issue = detectProjectCompatibility(value, supported)!;
      expect(projectCompatibilityMessage(issue)).toMatch(/已拒绝本次读取或保存/);
      expect(projectCompatibilityMessage(issue)).toMatch(/未被本次操作修改/);
      expect(projectCompatibilityMessage(issue)).toMatch(/兼容版本|完整项目备份/);
      expect(projectCompatibilityMessage(issue).length).toBeLessThan(1_000);
    }
  });
});
