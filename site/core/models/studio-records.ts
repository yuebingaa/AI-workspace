export type QueryExecutionStatus = "success" | "failure";
export type QueryComponentKind = "metric" | "chart" | "table";

export interface QueryExecutionRecord {
  id: string;
  componentId: string;
  pageId: string;
  componentKind: QueryComponentKind;
  dataSourceId: string;
  bindingSummary: string;
  planSummary: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  inputRowCount: number;
  outputRowCount: number;
  status: QueryExecutionStatus;
  error?: string;
}

export type ChangeSetAuditSource = "ai" | "puck" | "manual";
export type ChangeSetAuditStatus = "previewed" | "applied" | "cancelled" | "undone" | "failed";

export interface ChangeSetAuditRecord {
  id: string;
  changeSetId: string;
  role: "viewer" | "editor" | "admin";
  source: ChangeSetAuditSource;
  operationSummary: string;
  status: ChangeSetAuditStatus;
  timestamp: string;
  error?: string;
}

export interface FieldAnalysis {
  field: string;
  label: string;
  type: "string" | "number" | "date" | "boolean";
  nullCount: number;
  nullRatio: number;
  uniqueCount: number;
  minimum?: number;
  maximum?: number;
  average?: number;
  samples: Array<string | number | boolean>;
}
