import { describe, expect, it } from "vitest";
import { defaultDshPluginDocument, type DshPluginSettings } from "@/core/agent-engines/plugin-settings";
import { buildDshPluginCatalog } from "@/core/agent-engines/server/plugin-catalog";
import { projectSettingsInventory, readSettingsCommand, settingsCommandSchema } from "./settings-projection";
import { dshPackageInventorySchema } from "@/core/agent-engines/plugin-inventory";
import { settingsFrameSnapshot } from "@/components/studio/dsh-settings/OfficialSettingsFrame";
import type { PluginSettingsContentProps } from "@/components/studio/dsh-settings/settings-contract";
const plugins: DshPluginSettings = { document: defaultDshPluginDocument(), persistence: "json-file", activeTasks: 0,
  plugins: buildDshPluginCatalog(defaultDshPluginDocument(), { "dsh-skill": { installed: true }, "dsh-tool-skill": { installed: true } }) };
const initial = { source: "managed-installation" as const, complete: true, issues: [], packages: [
  { id: "@deepseek-ai/dsh-unmapped", version: "0.1.7-rc.2", category: "runtime" as const, description: "Example", dependencies: [] },
] };
const props: PluginSettingsContentProps = { plugins, status: null, skills: false, loading: false, saving: false, needsRefresh: false,
  dirty: false, discard: false, error: "", notice: "", onSkills() {}, onClose() {}, onSave() {}, onRefresh() {}, onDiscard() {}, onKeepEditing() {} };
describe("official settings projection", () => {
  it("projects real counts without claiming installed packages are active Host fibers", () => {
    const value = projectSettingsInventory(initial, plugins);
    expect(value.entries).toHaveLength(1); expect(value.entries[0]).toMatchObject({ enabled: false, fiberPhase: null });
    expect(value.entries[0].meta.description).toContain("仅确认安装"); expect(value.managementAvailable).toBe(false);
    expect(value.agentPresets[0].rows).toHaveLength(plugins.plugins.length);
    expect(value.agentPresets[0].rows.find(row => row.entryId === "dsh-tool-skill")?.enabled).toBe(false);
    expect(value.agentPresets[0].rows.find(row => row.entryId === "agentcanvas-notebook")).toMatchObject({ enabled: "conditional", fiberPhase: null });
  });
  it("keeps versions/dependencies and partial errors explicit, rejects invalid metadata before projection", () => {
    const incomplete = { ...initial, complete: false, issues: [{ id: "@deepseek-ai/dsh-broken", code: "metadata-unavailable" as const }] };
    const value = projectSettingsInventory(incomplete, plugins);
    expect(value.agentPresets[0].broken).toContain("1 项"); expect(value.entries[0].meta.description).toContain("0.1.7-rc.2");
    expect(dshPackageInventorySchema.safeParse({ ...initial, privatePath: "secret" }).success).toBe(false);
    expect(dshPackageInventorySchema.safeParse({ ...initial, packages: [...initial.packages, ...initial.packages] }).success).toBe(false);
  });
  it("version mismatch cannot project configured", () => {
    const configured = { ...plugins, plugins: [{ ...plugins.plugins[0], id: "dsh-unmapped", origin: "official" as const,
      version: "0.1.8", state: "configured" as const }] };
    expect(projectSettingsInventory(initial, configured).entries[0].enabled).toBe(false);
  });
  it.each([{ loading: true }, { saving: true }, { needsRefresh: true }, { disabled: true },
    { plugins: { ...plugins, activeTasks: 1 } }, { plugins: { ...plugins, persistence: "unconfigured" as const } }])(
    "locks parent actions in unsafe state %j", override => {
      expect(settingsFrameSnapshot({ ...props, ...override })).toMatchObject({ locked: true, canConfigure: false });
    });
  it("only exposes necessary public state, not callbacks, credentials, or full installation", () => {
    const value = settingsFrameSnapshot(props);
    expect(value).not.toHaveProperty("plugins"); expect(value).not.toHaveProperty("onSave");
    expect(JSON.stringify(value)).not.toContain("@deepseek-ai");
  });
  it("rejects unknown actions, paths, arbitrary mutations and duplicate fields", () => {
    for (const value of [{ type: "execute", command: "anything" }, { type: "save", path: "secret" },
      { type: "skills", skills: "true" }, { type: "inventory", requestId: "not-a-uuid" }]) {
      expect(settingsCommandSchema.safeParse(value).success).toBe(false);
    }
    expect(readSettingsCommand({ source: null, origin: "outside", data: {} } as MessageEvent, null, "local", "nonce")).toBeUndefined();
  });
});
