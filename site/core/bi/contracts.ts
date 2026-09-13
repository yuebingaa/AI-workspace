import type { DataRow, DataSourceField } from "@/core/models/data-binding";

export const BI_SYNC_LIMITS = {
  maxRows: 50_000,
  maxColumns: 100,
  maxCellChars: 20_000,
  maxCells: 2_000_000,
} as const;

export interface BiConnectionCheck {
  ok: true;
  checkedAt: string;
  serviceName: string;
  latencyMs?: number;
}

export interface BiPullRequest {
  externalDatasetId: string;
  previousVersion: string | null;
  signal?: AbortSignal;
}

export interface BiSnapshotPull {
  status: "snapshot";
  version: string;
  observedAt: string;
  datasetName: string;
  fields: DataSourceField[];
  rows: DataRow[];
  qualityScore?: number;
}

export interface BiDeltaPull {
  status: "delta";
  baseVersion: string;
  version: string;
  observedAt: string;
  primaryKey: string;
  upserts: DataRow[];
  deletedKeys: Array<string | number>;
}

export interface BiNotModifiedPull {
  status: "not-modified";
  checkedAt: string;
}

export type BiPullResult = BiSnapshotPull | BiDeltaPull | BiNotModifiedPull;

export interface BiConnector {
  readonly kind: string;
  testConnection(signal?: AbortSignal): Promise<BiConnectionCheck>;
  pullDataset(request: BiPullRequest): Promise<BiPullResult>;
}
