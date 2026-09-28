import { z } from "zod";
import type { DshPackageInventory } from "@/core/agent-engines/plugin-inventory";
import type { DshPluginSettings } from "@/core/agent-engines/plugin-settings";

export const DSH_SETTINGS_CHANNEL = "agentcanvas-dsh-settings";
export const settingsCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.enum(["ready", "mounted", "close", "refresh", "save", "models", "discard", "keep"]) }).strict(),
  z.object({ type: z.literal("skills"), skills: z.boolean() }).strict(),
  z.object({ type: z.literal("inventory"), requestId: z.string().uuid() }).strict(),
]);
export function readSettingsCommand(event: MessageEvent, source: Window | null | undefined, origin: string, nonce: string) {
  if (!source || event.source !== source || event.origin !== origin) return;
  const envelope = z.object({ channel: z.literal(DSH_SETTINGS_CHANNEL), nonce: z.literal(nonce) }).passthrough().safeParse(event.data);
  if (!envelope.success) return;
  const value: Record<string, unknown> = { ...envelope.data }; delete value.channel; delete value.nonce;
  const command = settingsCommandSchema.safeParse(value);
  return command.success ? command.data : undefined;
}

/** Map public metadata into the official renderer. Labels explicitly describe
 * configuration/install projection, never claim these are live Host fibers. */
export function projectSettingsInventory(inventory: DshPackageInventory, plugins: DshPluginSettings) {
  const states = { configured: "网站已配置", conditional: "按任务提供", disabled: "未启用", "not-integrated": "未接入", unavailable: "组件缺失" };
  const stateOf = (id: string) => plugins.plugins.find(row => row.origin === "official" && row.id === (id === "dsh-skill" ? "dsh-tool-skill" : id));
  return {
    managementAvailable: false,
    entries: inventory.packages.map(item => {
      const annotation = stateOf(item.id.slice("@deepseek-ai/".length));
      const matches = !annotation?.version || annotation.version === item.version;
      const description = matches && annotation ? `${states[annotation.state]}：${annotation.reason}`
        : "仅确认安装；网站接入及运行状态未确认，不代表未使用。";
      return { entryId: item.id, moduleName: item.id, enabled: Boolean(matches && annotation?.state === "configured"), fiberPhase: null,
        meta: { title: annotation?.name ?? item.id.replace("@deepseek-ai/dsh-", ""),
          description: `${description}\n${item.description}\n版本：${item.version}\n依赖：${item.dependencies.join(", ") || "未声明 DSH 依赖"}` } };
    }),
    agentPresets: [{ id: "website-current", name: "当前网站配置", isDefault: true,
      ...(inventory.complete ? {} : { broken: `${inventory.issues.length} 项元数据未能读取；安装目录不完整，请刷新重试。` }),
      rows: plugins.plugins.map(item => ({ entryId: item.id, moduleName: item.origin === "official" ? `@deepseek-ai/${item.id}` : item.id,
        enabled: item.state === "configured" ? true : item.state === "conditional" ? "conditional" : false, fiberPhase: null,
        meta: { title: item.name, description: `${states[item.state]}：${item.reason}\n${item.description}\n${item.tools.join(", ")}` } })),
    }],
  };
}
