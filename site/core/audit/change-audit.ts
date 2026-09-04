import type {
  ChangeSet,
  AiChangeSetAuditMetadata,
  ChangeSetAuditRecord,
  ChangeSetAuditSource,
  ChangeSetAuditStatus,
} from "@/core/models";
import type { StudioRole } from "@/core/permissions";
import { toProjectIsoDateTime } from "@/core/time/project-iso";

export const MAX_CHANGESET_AUDIT_RECORDS = 100;
let auditSequence = 0;

function readAuditTimestamp(clock: () => Date): { milliseconds: number; serialized: string } {
  let timestamp: Date;
  try {
    timestamp = clock();
  } catch {
    throw new Error("ChangeSet 审计时钟必须返回有效 Date。");
  }
  const serialized = toProjectIsoDateTime(timestamp);
  if (!serialized) {
    throw new Error("ChangeSet 审计时钟必须返回有效 Date。");
  }
  return { milliseconds: timestamp.getTime(), serialized };
}

export function summarizeChangeSet(changeSet: ChangeSet): string {
  return changeSet.operations.map((operation) => operation.label).join("、");
}

export function createChangeSetAuditRecord(
  changeSet: ChangeSet,
  role: StudioRole,
  source: ChangeSetAuditSource,
  status: ChangeSetAuditStatus,
  error?: string,
  clock: () => Date = () => new Date(),
  ai?: AiChangeSetAuditMetadata,
): ChangeSetAuditRecord {
  return createChangeSetAuditRecordFromSummary(
    changeSet.id,
    summarizeChangeSet(changeSet),
    role,
    source,
    status,
    error,
    clock,
    ai,
  );
}

export function createChangeSetAuditRecordFromSummary(
  changeSetId: string,
  operationSummary: string,
  role: StudioRole,
  source: ChangeSetAuditSource,
  status: ChangeSetAuditStatus,
  error?: string,
  clock: () => Date = () => new Date(),
  ai?: AiChangeSetAuditMetadata,
): ChangeSetAuditRecord {
  const timestamp = readAuditTimestamp(clock);
  return {
    id: `audit_${timestamp.milliseconds}_${++auditSequence}`,
    changeSetId,
    role,
    source,
    operationSummary,
    status,
    timestamp: timestamp.serialized,
    ...(error ? { error } : {}),
    ...(ai ? { ai } : {}),
  };
}

export function appendChangeSetAuditRecord(
  records: ChangeSetAuditRecord[],
  record: ChangeSetAuditRecord,
  limit = MAX_CHANGESET_AUDIT_RECORDS,
): ChangeSetAuditRecord[] {
  return [record, ...records].slice(0, Math.max(1, limit));
}
