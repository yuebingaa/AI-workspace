import { z } from "zod";
import type { DataRow, DatasetAiAccessPolicy } from "@/core/models";
import { ownershipNamespace, type OwnershipScope } from "@/core/identity/ownership";
import { configuredSnapshotAdapter, type SnapshotAdapter } from "@/core/persistence/server/json-file-snapshot";
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
  persistence?: SnapshotAdapter<DatasetRepositorySnapshot>;
}

interface DatasetRepositorySnapshot {
  version: 1;
  datasets: Array<{ ownership: OwnershipScope; payload: DatasetUploadResponse }>;
}

const datasetRepositorySnapshotSchema: z.ZodType<DatasetRepositorySnapshot> = z.object({
  version: z.literal(1),
  datasets: z.array(z.object({
    ownership: z.object({ tenantId: z.string().min(1), ownerId: z.string().min(1) }).strict(),
    payload: datasetUploadResponseSchema,
  }).strict()).max(CSV_UPLOAD_LIMITS.maxDatasets),
}).strict().superRefine((snapshot, context) => {
  const keys = snapshot.datasets.map(({ ownership, payload }) => (
    `${ownershipNamespace(ownership)}:${payload.dataset.datasetId}`
  ));
  if (new Set(keys).size !== keys.length) {
    context.addIssue({ code: "custom", path: ["datasets"], message: "数据集快照包含重复的所有权与标识" });
  }
});

export interface DatasetRepositoryHealth {
  mode: "memory" | "json-file";
  persistenceHealthy: boolean;
  lastPersistenceErrorAt: string | null;
  count: number;
  capacity: number;
  utilization: number;
  warning: string | null;
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

export class MemoryDatasetRepository implements DatasetRepository {
  private readonly datasets = new Map<string, StoredDataset>();
  private readonly maxDatasets: number;
  private readonly now: () => Date;
  private readonly persistence?: SnapshotAdapter<DatasetRepositorySnapshot>;
  private lastPersistenceErrorAt: string | null = null;

  constructor(options: MemoryDatasetRepositoryOptions = {}) {
    this.maxDatasets = options.maxDatasets ?? CSV_UPLOAD_LIMITS.maxDatasets;
    if (!Number.isSafeInteger(this.maxDatasets) || this.maxDatasets < 1 || this.maxDatasets > CSV_UPLOAD_LIMITS.maxDatasets) {
      throw new Error(`数据集容量必须是 1–${CSV_UPLOAD_LIMITS.maxDatasets} 的整数`);
    }
    this.now = options.now ?? (() => new Date());
    this.persistence = options.persistence;
    const loadedSnapshot = this.persistence?.load();
    const snapshot = loadedSnapshot ? datasetRepositorySnapshotSchema.parse(loadedSnapshot) : null;
    snapshot?.datasets.forEach(({ ownership, payload }) => {
      const parsed = datasetUploadResponseSchema.parse(payload);
      this.datasets.set(this.key(ownership, parsed.dataset.datasetId), {
        ownership: structuredClone(ownership),
        descriptor: structuredClone(parsed.dataset),
        rows: structuredClone(parsed.rows),
      });
    });
    this.purgeAndPersist(this.currentTime());
  }

  private withoutExpired(operationTime: number): Map<string, StoredDataset> {
    const next = new Map(this.datasets);
    for (const [id, dataset] of this.datasets) {
      if (Date.parse(dataset.descriptor.expiresAt) <= operationTime) next.delete(id);
    }
    return next;
  }

  private key(ownership: OwnershipScope, datasetId: string): string {
    return `${ownershipNamespace(ownership)}:${datasetId}`;
  }

  private persist(datasets: Map<string, StoredDataset>): void {
    this.persistence?.save({
      version: 1,
      datasets: [...datasets.values()].map((stored) => ({
        ownership: structuredClone(stored.ownership),
        payload: { dataset: structuredClone(stored.descriptor), rows: structuredClone(stored.rows) },
      })),
    });
  }

  private commit(datasets: Map<string, StoredDataset>, operationTime = this.currentTime()): void {
    try {
      this.persist(datasets);
      this.lastPersistenceErrorAt = null;
    } catch (error) {
      if (this.persistence) this.lastPersistenceErrorAt = new Date(operationTime).toISOString();
      throw error;
    }
    this.datasets.clear();
    datasets.forEach((dataset, key) => this.datasets.set(key, dataset));
  }

  private purgeAndPersist(operationTime: number): void {
    const next = this.withoutExpired(operationTime);
    if (next.size !== this.datasets.size) this.commit(next, operationTime);
  }

  private currentTime(): number {
    const current = this.now();
    const value = current instanceof Date ? current.getTime() : Number.NaN;
    if (!Number.isSafeInteger(value)) throw new Error("数据集仓库时钟必须返回有效 Date");
    return value;
  }

  async put(ownership: OwnershipScope, dataset: DatasetUploadResponse): Promise<StoredDataset> {
    const operationTime = this.currentTime();
    this.purgeAndPersist(operationTime);
    const parsed = datasetUploadResponseSchema.parse(dataset);
    const key = this.key(ownership, parsed.dataset.datasetId);
    if (this.datasets.has(key)) {
      throw new StudioValidationError("上传数据集标识冲突", ["拒绝覆盖当前所有者已有的临时数据集"]);
    }
    if (this.datasets.size >= this.maxDatasets) {
      throw new StudioValidationError("上传数据集数量已达上限", [`当前最多保存 ${this.maxDatasets} 个临时数据集，请先删除不再使用的数据集`]);
    }
    const stored = {
      ownership: { tenantId: ownership.tenantId, ownerId: ownership.ownerId },
      descriptor: structuredClone(parsed.dataset),
      rows: structuredClone(parsed.rows),
    };
    const next = new Map(this.datasets);
    next.set(key, stored);
    this.commit(next, operationTime);
    return structuredClone(stored);
  }

  async get(ownership: OwnershipScope, datasetId: string): Promise<StoredDataset | null> {
    this.purgeAndPersist(this.currentTime());
    const stored = this.datasets.get(this.key(ownership, datasetId));
    return stored ? structuredClone(stored) : null;
  }

  async list(ownership: OwnershipScope): Promise<UploadedDatasetDescriptor[]> {
    this.purgeAndPersist(this.currentTime());
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
    const operationTime = this.currentTime();
    this.purgeAndPersist(operationTime);
    const stored = this.datasets.get(this.key(ownership, datasetId));
    if (!stored) throw new StudioValidationError("上传数据集不存在或已过期", [`无法更新数据集：${datasetId}`]);
    const currentPolicy = stored.descriptor.aiAccessPolicy;
    if (stored.descriptor.sensitiveFields.length === 0 || currentPolicy === "not-required") {
      throw new DatasetAiAccessPolicyConflictError("此数据集没有需要确认的敏感字段");
    }
    if (currentPolicy !== "pending") {
      if (currentPolicy === policy) return structuredClone(stored.descriptor);
      throw new DatasetAiAccessPolicyConflictError("敏感字段处理方式已经确认，不能由重放请求改写");
    }
    const descriptor = uploadedDatasetDescriptorSchema.parse({
      ...stored.descriptor,
      aiAccessPolicy: policy,
      source: { ...stored.descriptor.source, aiAccessPolicy: policy },
    });
    const next = new Map(this.datasets);
    next.set(this.key(ownership, datasetId), { ...stored, descriptor });
    this.commit(next, operationTime);
    return structuredClone(descriptor);
  }

  assertAiAccessPolicies(
    ownership: OwnershipScope,
    expected: ReadonlyArray<{ datasetId: string; policy: DatasetAiAccessPolicy }>,
  ): void {
    this.purgeAndPersist(this.currentTime());
    for (const item of expected) {
      const stored = this.datasets.get(this.key(ownership, item.datasetId));
      if (!stored || stored.descriptor.aiAccessPolicy !== item.policy || item.policy === "pending") {
        throw new DatasetAiAccessRevokedError(item.datasetId);
      }
    }
  }

  async delete(ownership: OwnershipScope, datasetId: string): Promise<boolean> {
    const operationTime = this.currentTime();
    this.purgeAndPersist(operationTime);
    const key = this.key(ownership, datasetId);
    if (!this.datasets.has(key)) return false;
    const next = new Map(this.datasets);
    next.delete(key);
    this.commit(next, operationTime);
    return true;
  }

  clear(): void {
    this.commit(new Map());
  }

  health(): DatasetRepositoryHealth {
    const operationTime = this.currentTime();
    try { this.purgeAndPersist(operationTime); } catch { /* health remains readable and reports the recorded persistence failure */ }
    const count = this.withoutExpired(operationTime).size;
    const utilization = this.maxDatasets === 0 ? 1 : count / this.maxDatasets;
    const persistenceHealthy = this.lastPersistenceErrorAt === null;
    return {
      mode: this.persistence ? "json-file" : "memory",
      persistenceHealthy,
      lastPersistenceErrorAt: this.lastPersistenceErrorAt,
      count,
      capacity: this.maxDatasets,
      utilization,
      warning: !persistenceHealthy
        ? "数据集本地持久化最近一次写入失败"
        : utilization >= 0.8 ? `数据集容量已使用 ${Math.round(utilization * 100)}%` : null,
    };
  }
}

const globalRepository = globalThis as typeof globalThis & { __studioDatasetRepository?: MemoryDatasetRepository };
export let datasetRepositoryStartupError: string | null = null;
function createDatasetRepository() {
  try {
    return new MemoryDatasetRepository({
      persistence: configuredSnapshotAdapter("datasets.json", datasetRepositorySnapshotSchema, 128 * 1024 * 1024),
    });
  } catch (error) {
    datasetRepositoryStartupError = error instanceof Error ? error.message : "数据集持久化初始化失败";
    return new MemoryDatasetRepository();
  }
}
export const datasetRepository = globalRepository.__studioDatasetRepository ??= createDatasetRepository();
