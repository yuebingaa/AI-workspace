import type { ChangeSet } from "@/core/models";
import type { StudioRole } from "@/core/permissions";
import { appSpecSchema, changeSetSchema } from "@/core/schemas";
import { applyChangeSet, type ChangeSetExecutionState } from "./executor";

/** Confirm exactly the reviewed candidate, not a newly rebased or replaced preview. */
export function applyPreviewedChangeSet(state: ChangeSetExecutionState, changeSet: ChangeSet, role: StudioRole): ChangeSetExecutionState {
  if (!state.preview?.confirmation || state.preview.changeSetId !== changeSet.id
    || JSON.stringify(state.preview.operationIds) !== JSON.stringify(changeSet.operations.map((operation) => operation.id))) {
    throw new Error("当前预览已变化，请重新生成并检查后再确认");
  }
  if (state.preview.confirmation.baseAppSpec !== JSON.stringify(appSpecSchema.parse(state.present))
    || state.preview.confirmation.changeSet !== JSON.stringify(changeSetSchema.parse(changeSet))) {
    throw new Error("当前页面或变更内容已变化，请重新生成预览后再确认");
  }
  const applied = applyChangeSet(state, changeSet, role);
  if (JSON.stringify(applied.present) !== JSON.stringify(state.preview.appSpec)) {
    throw new Error("当前页面或变更内容已变化，请重新生成预览后再确认");
  }
  return applied;
}
