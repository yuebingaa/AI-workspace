import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonFileSnapshotAdapter } from "@/core/persistence/server/json-file-snapshot";
import { defaultDshPluginDocument, dshPluginDocumentSchema } from "../plugin-settings";
import { DshPluginSettingsStore } from "./plugin-settings";
import { buildDshPluginCatalog } from "./plugin-catalog";

const roots: string[] = [];
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "dsh-plugin-settings-")); roots.push(root);
  const create = () => new DshPluginSettingsStore(new JsonFileSnapshotAdapter({ rootDirectory: root,
    fileName: "plugins.json", schema: dshPluginDocumentSchema, maxBytes: 4096 }));
  return { create, file: join(root, "plugins.json") };
}
describe("DSH plugin configuration", () => {
  it("defaults to the existing minimal capabilities without writing a file", () => {
    const store = new DshPluginSettingsStore();
    expect(store.read()).toEqual(defaultDshPluginDocument());
    expect(store.persistence).toBe("unconfigured");
    expect(() => store.save({ revision: 0, config: { skills: true } }, 0)).toThrow("持久化");
  });
  it("persists across new instances, advances revision only on change and disables again", () => {
    const { create } = fixture();
    const first = create().save({ revision: 0, config: { skills: true } }, 0);
    expect(first).toMatchObject({ revision: 1, config: { skills: true } });
    expect(create().read()).toEqual(first);
    expect(create().save({ revision: 1, config: { skills: true } }, 0)).toEqual(first);
    expect(create().save({ revision: 1, config: { skills: false } }, 0)).toMatchObject({ revision: 2, config: { skills: false } });
  });
  it("refuses stale revision or active tasks without changing the saved bytes", () => {
    const { create, file } = fixture(); create().save({ revision: 0, config: { skills: true } }, 0);
    const bytes = readFileSync(file);
    expect(() => create().save({ revision: 0, config: { skills: false } }, 0)).toThrow("已更新");
    expect(() => create().save({ revision: 1, config: { skills: false } }, 1)).toThrow("正在执行");
    expect(readFileSync(file)).toEqual(bytes);
  });
  it.each([{ skills: "true" }, { skills: true, shell: true }, { terminal: true }])("rejects arbitrary config %j", config => {
    const { create } = fixture();
    expect(() => create().save({ revision: 0, config }, 0)).toThrow();
    expect(create().read()).toEqual(defaultDshPluginDocument());
  });
  it("does not replace corrupt persistence with defaults", () => {
    const { create, file } = fixture(); writeFileSync(file, "corrupt fixture", "utf8");
    expect(() => create().read()).toThrow();
    expect(() => create().save({ revision: 0, config: { skills: true } }, 0)).toThrow();
    expect(readFileSync(file, "utf8")).toBe("corrupt fixture");
  });
  it("save failure is not represented as committed in a cached state", () => {
    const store = new DshPluginSettingsStore({ load: () => defaultDshPluginDocument(), save() { throw new Error("disk fixture"); } });
    expect(() => store.save({ revision: 0, config: { skills: true } }, 0)).toThrow("disk fixture");
    expect(store.read().config.skills).toBe(false);
  });
});
describe("plugin integration catalog", () => {
  it("separates installed packages from configured, conditional and unsupported capabilities", () => {
    const packages = Object.fromEntries(["dsh-skill", "dsh-tool-skill", "dsh-agent-loop", "dsh-compaction-basic", "dsh-tool-pwsh"]
      .map(id => [id, { installed: true, version: "0.1.7-rc.2" }]));
    const catalog = buildDshPluginCatalog(defaultDshPluginDocument(), packages);
    expect(catalog.find(p => p.id === "dsh-tool-skill")).toMatchObject({ configurable: true, state: "disabled" });
    expect(catalog.find(p => p.id === "dsh-compaction-basic")).toMatchObject({ configurable: false, state: "not-integrated" });
    expect(catalog.find(p => p.id === "dsh-tool-pwsh")).toMatchObject({ configurable: false, state: "disabled" });
    expect(catalog.find(p => p.id === "dsh-tool-fs")).toMatchObject({ configurable: false, state: "unavailable" });
    expect(catalog.find(p => p.id === "agentcanvas-notebook")?.state).toBe("conditional");
    expect(buildDshPluginCatalog({ ...defaultDshPluginDocument(), config: { skills: true } }, packages)[0].state).toBe("configured");
  });
  it("cannot configure Skill when the registry dependency is missing", () => {
    const row = buildDshPluginCatalog(defaultDshPluginDocument(), { "dsh-tool-skill": { installed: true } })[0];
    expect(row).toMatchObject({ state: "unavailable", configurable: false });
  });
});
