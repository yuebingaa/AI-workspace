import type { DataRow, DatasetAiAccessPolicy } from "@/core/models";
import type { OwnershipScope } from "@/core/identity/ownership";
import type { DatasetUploadResponse, UploadedDatasetDescriptor } from "./contracts";

export interface StoredDataset {
  ownership: OwnershipScope;
  descriptor: UploadedDatasetDescriptor;
  rows: DataRow[];
}

/** Existing materialized Dataset storage; not a streaming or paginated result store. */
export interface DatasetRepository {
  put(ownership: OwnershipScope, dataset: DatasetUploadResponse): Promise<StoredDataset>;
  get(ownership: OwnershipScope, datasetId: string): Promise<StoredDataset | null>;
  list(ownership: OwnershipScope): Promise<UploadedDatasetDescriptor[]>;
  setAiAccessPolicy(
    ownership: OwnershipScope,
    datasetId: string,
    policy: Extract<DatasetAiAccessPolicy, "masked" | "exclude-sensitive-samples">,
  ): Promise<UploadedDatasetDescriptor>;
  delete(ownership: OwnershipScope, datasetId: string): Promise<boolean>;
  /** Must throw synchronously before a model/tool boundary; callers do not await it. */
  assertAiAccessPolicies(
    ownership: OwnershipScope,
    expected: ReadonlyArray<{ datasetId: string; policy: DatasetAiAccessPolicy }>,
  ): void;
}

export class DatasetAiAccessPolicyConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatasetAiAccessPolicyConflictError";
  }
}

export class DatasetAiAccessRevokedError extends Error {
  constructor(readonly datasetId: string) {
    super(`上传数据集 ${datasetId} 已被删除、过期或更改 AI 数据处理方式`);
    this.name = "DatasetAiAccessRevokedError";
  }
}
