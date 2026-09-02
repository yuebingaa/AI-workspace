import type { DataRow, DatasetAiAccessPolicy } from "@/core/models";
import { ownershipNamespace, type OwnershipScope } from "@/core/identity/ownership";
import { StudioValidationError } from "@/core/schemas";
import {
  CSV_UPLOAD_LIMITS,
  datasetUploadResponseSchema,
  uploadedDatasetDescriptorSchema,
  type DatasetUploadResponse,
  type UploadedDatasetDescriptor,
} from "../contracts";

export interface StoredDataset {
  ownership: OwnershipScope;
  descriptor: UploadedDatasetDescriptor;
  rows: DataRow[];
}

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
}

export interface MemoryDatasetRepositoryOptions {
  maxDatasets?: number;
  now?: () => Date;
}

export class MemoryDatasetRepository implements DatasetRepository {
  private readonly datasets = new Map<string, StoredDataset>();
  private readonly maxDatasets: number;
  private readonly now: () => Date;

  constructor(options: MemoryDatasetRepositoryOptions = {}) {
    this.maxDatasets = options.maxDatasets ?? CSV_UPLOAD_LIMITS.maxDatasets;
    this.now = options.now ?? (() => new Date());
  }

  private purgeExpired(): void {
    const now = this.now().getTime();
    for (const [id, dataset] of this.datasets) {
      if (Date.parse(dataset.descriptor.expiresAt) <= now) this.datasets.delete(id);
    }
  }

  private key(ownership: OwnershipScope, datasetId: string): string {
    return `${ownershipNamespace(ownership)}:${datasetId}`;
  }

  async put(ownership: OwnershipScope, dataset: DatasetUploadResponse): Promise<StoredDataset> {
    this.purgeExpired();
    const parsed = datasetUploadResponseSchema.parse(dataset);
    const key = this.key(ownership, parsed.dataset.datasetId);
    if (!this.datasets.has(key) && this.datasets.size >= this.maxDatasets) {
      throw new StudioValidationError("上传数据集数量已达上限", [`当前最多保存 ${this.maxDatasets} 个临时数据集，请先删除不再使用的数据集`]);
    }
    const stored = {
      ownership: { tenantId: ownership.tenantId, ownerId: ownership.ownerId },
      descriptor: structuredClone(parsed.dataset),
      rows: structuredClone(parsed.rows),
    };
    this.datasets.set(key, stored);
    return structuredClone(stored);
  }

  async get(ownership: OwnershipScope, datasetId: string): Promise<StoredDataset | null> {
    this.purgeExpired();
    const stored = this.datasets.get(this.key(ownership, datasetId));
    return stored ? structuredClone(stored) : null;
  }

  async list(ownership: OwnershipScope): Promise<UploadedDatasetDescriptor[]> {
    this.purgeExpired();
    return [...this.datasets.values()]
      .filter((dataset) => dataset.ownership.tenantId === ownership.tenantId && dataset.ownership.ownerId === ownership.ownerId)
      .map((dataset) => structuredClone(dataset.descriptor))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async setAiAccessPolicy(
    ownership: OwnershipScope,
    datasetId: string,
    policy: Extract<DatasetAiAccessPolicy, "masked" | "exclude-sensitive-samples">,
  ): Promise<UploadedDatasetDescriptor> {
    this.purgeExpired();
    const stored = this.datasets.get(this.key(ownership, datasetId));
    if (!stored) throw new StudioValidationError("上传数据集不存在或已过期", [`无法更新数据集：${datasetId}`]);
    const descriptor = uploadedDatasetDescriptorSchema.parse({
      ...stored.descriptor,
      aiAccessPolicy: policy,
      source: { ...stored.descriptor.source, aiAccessPolicy: policy },
    });
    stored.descriptor = descriptor;
    return structuredClone(descriptor);
  }

  async delete(ownership: OwnershipScope, datasetId: string): Promise<boolean> {
    this.purgeExpired();
    return this.datasets.delete(this.key(ownership, datasetId));
  }

  clear(): void {
    this.datasets.clear();
  }
}

const globalRepository = globalThis as typeof globalThis & { __studioDatasetRepository?: MemoryDatasetRepository };
export const datasetRepository = globalRepository.__studioDatasetRepository ??= new MemoryDatasetRepository();
