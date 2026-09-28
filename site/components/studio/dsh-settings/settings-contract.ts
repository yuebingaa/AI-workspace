import type { AgentEngineSettings } from "@/core/agent-engines/contracts";
import type { DshPluginSettings } from "@/core/agent-engines/plugin-settings";

/** Website owns configuration state; official UI only dispatches these actions. */
export interface PluginSettingsContentProps {
  status: AgentEngineSettings | null; plugins: DshPluginSettings | null;
  skills: boolean; loading: boolean; saving: boolean; disabled?: boolean;
  needsRefresh: boolean; error: string; notice: string; dirty: boolean; discard: boolean;
  onSkills(value: boolean): void; onRefresh(): void; onSave(): void; onClose(): void;
  onDiscard(): void; onKeepEditing(): void; onOpenModels?(): void;
}
