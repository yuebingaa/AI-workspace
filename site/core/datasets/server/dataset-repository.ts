import type { DataRow, DatasetAiAccessPolicy } from "@/core/models";
import { StudioValidationError } from "@/core/schemas";
import {
  CSV_UPLOAD_LIMITS,
  datasetUploadResponseSchema,
  uploadedDatasetDescriptorSchema,
  type DatasetUploadResponse,
  type UploadedDatasetDescriptor,
} from "../contracts";

export interface StoredDataset {
  descriptor: UploadedDatasetDescriptor;
  rows: DataRow[];
}

export interface DatasetRepository {
  put(dataset: DatasetUploadResponse): StoredDataset;
  get(datasetId: string): StoredDataset | null;
  list(): UploadedDatasetDescriptor[];
  setAiAccessPolicy(datasetId: string, policy: Extract<DatasetAiAccessPolicy, "masked" | "exclude-sensitive-samples">): UploadedDatasetDescriptor;
  delete(datasetId: string): boolean;
  clear(): void;
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

  put(dataset: DatasetUploadResponse): StoredDataset {
    this.purgeExpired();
    const parsed = datasetUploadResponseSchema.parse(dataset);
    if (!this.datasets.has(parsed.dataset.datasetId) && this.datasets.size >= this.maxDatasets) {
      throw new StudioValidationError("上传数据集数量已达上限", [`当前最多保存 ${this.maxDatasets} 个临时数据集，请先删除不再使用的数据集`]);
    }
    const stored = { descriptor: structuredClone(parsed.dataset), rows: structuredClone(parsed.rows) };
    this.datasets.set(parsed.dataset.datasetId, stored);
    return { descriptor: structuredClone(stored.descriptor), rows: structuredClone(stored.rows) };
  }

  get(datasetId: string): StoredDataset | null {
    this.purgeExpired();
    const stored = this.datasets.get(datasetId);
    return stored ? { descriptor: structuredClone(stored.descriptor), rows: structuredClone(stored.rows) } : null;
  }

  list(): UploadedDatasetDescriptor[] {
    this.purgeExpired();
    return [...this.datasets.values()]
      .map((dataset) => structuredClone(dataset.descriptor))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  setAiAccessPolicy(datasetId: string, policy: Extract<DatasetAiAccessPolicy, "masked" | "exclude-sensitive-samples">): UploadedDatasetDescriptor {
    this.purgeExpired();
    const stored = this.datasets.get(datasetId);
    if (!stored) throw new StudioValidationError("上传数据集不存在或已过期", [`无法更新数据集：${datasetId}`]);
    const descriptor = uploadedDatasetDescriptorSchema.parse({
      ...stored.descriptor,
      aiAccessPolicy: policy,
      source: { ...stored.descriptor.source, aiAccessPolicy: policy },
    });
    stored.descriptor = descriptor;
    return structuredClone(descriptor);
  }

  delete(datasetId: string): boolean {
    this.purgeExpired();
    return this.datasets.delete(datasetId);
  }

  clear(): void {
    this.datasets.clear();
  }
}

const globalRepository = globalThis as typeof globalThis & { __studioDatasetRepository?: MemoryDatasetRepository };
export const datasetRepository = globalRepository.__studioDatasetRepository ??= new MemoryDatasetRepository();
