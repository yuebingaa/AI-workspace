import { configuredSnapshotAdapter, type SnapshotAdapter } from "@/core/persistence/server/json-file-snapshot";
import { defaultDshPluginDocument, dshPluginDocumentSchema, dshPluginUpdateSchema,
  type DshPluginDocument } from "../plugin-settings";

export class DshPluginSettingsError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

/** Every access reloads: HMR and another process cannot silently overwrite a newer revision. */
export class DshPluginSettingsStore {
  constructor(private readonly adapter?: Pick<SnapshotAdapter<DshPluginDocument>, "load" | "save">) {}
  read() { return this.adapter?.load() ?? defaultDshPluginDocument(); }
  get persistence() { return this.adapter ? "json-file" as const : "unconfigured" as const; }
  save(raw: unknown, activeTasks: number): DshPluginDocument {
    const input = dshPluginUpdateSchema.parse(raw);
    if (!this.adapter) throw new DshPluginSettingsError("本部署未配置持久化目录，无法保存插件设置。", 503);
    if (activeTasks > 0) throw new DshPluginSettingsError("有任务正在执行，请完成或取消后保存插件设置。", 409);
    const current = this.read();
    if (current.revision !== input.revision) throw new DshPluginSettingsError("插件设置已更新，请刷新后重新修改。", 409);
    if (current.config.skills === input.config.skills) return current;
    const next = dshPluginDocumentSchema.parse({ ...current, revision: current.revision + 1, config: input.config });
    this.adapter.save(next);
    return next;
  }
}

export function configuredDshPluginSettings() {
  return new DshPluginSettingsStore(configuredSnapshotAdapter("dsh-plugin-settings.json", dshPluginDocumentSchema, 4096));
}
