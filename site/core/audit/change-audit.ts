import type {
  ChangeSet,
  ChangeSetAuditRecord,
  ChangeSetAuditSource,
  ChangeSetAuditStatus,
} from "@/core/models";
import type { StudioRole } from "@/core/permissions";

export const MAX_CHANGESET_AUDIT_RECORDS = 100;
let auditSequence = 0;

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
): ChangeSetAuditRecord {
  return createChangeSetAuditRecordFromSummary(
    changeSet.id,
    summarizeChangeSet(changeSet),
    role,
    source,
    status,
    error,
    clock,
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
): ChangeSetAuditRecord {
  const timestamp = clock();
  return {
    id: `audit_${timestamp.getTime()}_${++auditSequence}`,
    changeSetId,
    role,
    source,
    operationSummary,
    status,
    timestamp: timestamp.toISOString(),
    ...(error ? { error } : {}),
  };
}

export function appendChangeSetAuditRecord(
  records: ChangeSetAuditRecord[],
  record: ChangeSetAuditRecord,
  limit = MAX_CHANGESET_AUDIT_RECORDS,
): ChangeSetAuditRecord[] {
  return [record, ...records].slice(0, Math.max(1, limit));
}
