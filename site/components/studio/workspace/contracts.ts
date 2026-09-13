import type { Dispatch, RefObject, SetStateAction } from "react";
import type { AiPlanMetadata } from "@/core/ai/contracts";
import type { ChangeSetExecutionState } from "@/core/changesets";
import type { EdsWorkspaceSnapshot } from "@/core/eds";
import type { HarnessTaskSummary } from "@/core/harness/contracts";
import type { AssistantConversationTurn } from "@/core/harness/conversation";
import type { AiChangeSetAuditMetadata, ChangeSet, ChangeSetAuditRecord, ChangeSetAuditSource, ChangeSetAuditStatus, DataProduct, LocalDataRuntime, QueryExecutionRecord } from "@/core/models";
import type { StudioSaveResult } from "@/core/repository";
import type { CanvasMode } from "../DataProductCanvas";

export type StateSetter<T> = Dispatch<SetStateAction<T>>;

// Existing document/persistence boundary, not another store or wire format.
export interface WorkspaceSnapshot {
  execution: ChangeSetExecutionState;
  dataProduct: DataProduct;
  dataRuntime: LocalDataRuntime;
  activeDataSourceId: string;
  auditRecords: ChangeSetAuditRecord[];
  queryRecords: QueryExecutionRecord[];
  harnessTasks: HarnessTaskSummary[];
  assistantConversation: AssistantConversationTurn[];
  edsWorkspace: EdsWorkspaceSnapshot | null;
}
export type WorkspaceSnapshotRef = RefObject<WorkspaceSnapshot>;
export type PersistWorkspace = (
  execution?: ChangeSetExecutionState,
  auditRecords?: ChangeSetAuditRecord[],
  queryRecords?: QueryExecutionRecord[],
  dataProduct?: DataProduct,
  harnessTasks?: HarnessTaskSummary[],
  edsWorkspace?: EdsWorkspaceSnapshot | null,
  assistantConversation?: AssistantConversationTurn[],
) => StudioSaveResult;

export interface WorkspaceFeedback {
  setValidationError: StateSetter<string | null>;
  setSaveLabel: StateSetter<string>;
}
export interface WorkspacePreviewBindings {
  execution: ChangeSetExecutionState;
  setExecution: StateSetter<ChangeSetExecutionState>;
  setPendingPuckChangeSet: StateSetter<ChangeSet | null>;
  setPendingChangeSource: StateSetter<ChangeSetAuditSource | null>;
  setCanvasMode: StateSetter<CanvasMode>;
  clearPuckDraft(): void;
  setPuckSessionKey: StateSetter<number>;
  auditCurrentPreviewCancellation(): void;
  addAudit(
    changeSet: ChangeSet, source: ChangeSetAuditSource, status: ChangeSetAuditStatus,
    error?: string, metadata?: AiPlanMetadata | AiChangeSetAuditMetadata | null,
  ): ChangeSetAuditRecord;
}
