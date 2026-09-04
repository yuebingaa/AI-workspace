import { randomUUID } from "node:crypto";
import { z } from "zod";
import { sameOwnership, type OwnershipScope } from "@/core/identity/ownership";
import { configuredSnapshotAdapter, type SnapshotAdapter } from "@/core/persistence/server/json-file-snapshot";
import { EXCEL_EXPORT_TTL_MS, excelExportArtifactSchema, type ExcelExportArtifact } from "../contracts";
import { EXCEL_EXPORT_LIMITS, type GeneratedRecipeExcel } from "./recipe-excel-export";

export { EXCEL_EXPORT_TTL_MS } from "../contracts";
export const MAX_STORED_EXPORTS = 20;
export const MAX_EXPORT_ID_ATTEMPTS = 3;
const MAX_EXCEL_EXPORT_BASE64_CHARS = Math.ceil(EXCEL_EXPORT_LIMITS.maxFileBytes / 3) * 4;
const EXPORT_ID_PATTERN = /^[A-Za-z0-9_-]{16,160}$/u;
const MAX_DATE_TIMESTAMP_MS = 8_640_000_000_000_000;

interface StoredExcelExport {
  ownership: OwnershipScope;
  artifact: ExcelExportArtifact;
  buffer: Buffer;
}

interface ExcelExportSnapshot {
  version: 1;
  entries: Array<{ ownership: OwnershipScope; artifact: ExcelExportArtifact; bufferBase64: string }>;
}

const excelExportSnapshotSchema: z.ZodType<ExcelExportSnapshot> = z.object({
  version: z.literal(1),
  entries: z.array(z.object({
    ownership: z.object({ tenantId: z.string().min(1), ownerId: z.string().min(1) }).strict(),
    artifact: excelExportArtifactSchema,
    bufferBase64: z.string().min(1).max(MAX_EXCEL_EXPORT_BASE64_CHARS).regex(/^[A-Za-z0-9+/]+={0,2}$/u),
  }).strict()).max(MAX_STORED_EXPORTS),
}).strict().superRefine((snapshot, context) => {
  const ids = snapshot.entries.map((entry) => entry.artifact.id);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: "custom", path: ["entries"], message: "Excel 下载快照包含重复标识" });
  }
});

export interface ExcelExportStoreHealth {
  mode: "memory" | "json-file";
  persistenceHealthy: boolean;
  lastPersistenceErrorAt: string | null;
  count: number;
  capacity: number;
  utilization: number;
  warning: string | null;
}

export interface ExcelExportStoreOptions {
  persistence?: SnapshotAdapter<ExcelExportSnapshot>;
  maxExports?: number;
  maxFileBytes?: number;
  idFactory?: () => string;
  clock?: () => number;
}

export class ExcelExportStore {
  private readonly entries = new Map<string, StoredExcelExport>();
  private readonly persistence?: SnapshotAdapter<ExcelExportSnapshot>;
  private readonly maxExports: number;
  private readonly maxFileBytes: number;
  private readonly idFactory: () => string;
  private readonly clock: () => number;
  private lastPersistenceErrorAt: string | null = null;

  constructor(options: ExcelExportStoreOptions = {}) {
    this.persistence = options.persistence;
    this.maxExports = options.maxExports ?? MAX_STORED_EXPORTS;
    if (!Number.isSafeInteger(this.maxExports) || this.maxExports < 1 || this.maxExports > MAX_STORED_EXPORTS) {
      throw new Error(`Excel 下载容量必须是 1–${MAX_STORED_EXPORTS} 的整数`);
    }
    this.maxFileBytes = options.maxFileBytes ?? EXCEL_EXPORT_LIMITS.maxFileBytes;
    if (!Number.isSafeInteger(this.maxFileBytes) || this.maxFileBytes < 1 || this.maxFileBytes > EXCEL_EXPORT_LIMITS.maxFileBytes) {
      throw new Error(`Excel 下载文件上限必须是 1–${EXCEL_EXPORT_LIMITS.maxFileBytes} 的整数`);
    }
    this.idFactory = options.idFactory ?? (() => randomUUID().replaceAll("-", ""));
    this.clock = options.clock ?? Date.now;
    const loadedSnapshot = this.persistence?.load();
    const snapshot = loadedSnapshot ? excelExportSnapshotSchema.parse(loadedSnapshot) : null;
    snapshot?.entries.forEach((entry) => {
      const buffer = Buffer.from(entry.bufferBase64, "base64");
      if (buffer.length !== entry.artifact.sizeBytes) throw new Error("Excel 下载快照的文件大小与元数据不一致");
      if (buffer.length > this.maxFileBytes) throw new Error("Excel 下载快照超过文件大小限制");
      this.entries.set(entry.artifact.id, {
        ownership: structuredClone(entry.ownership),
        artifact: structuredClone(entry.artifact),
        buffer,
      });
    });
    const currentTime = this.currentTime();
    const next = this.withoutExpired(currentTime);
    while (next.size > this.maxExports) next.delete(next.keys().next().value!);
    if (next.size !== this.entries.size) this.commit(next, currentTime);
  }

  private persist(entries: Map<string, StoredExcelExport>): void {
    this.persistence?.save({
      version: 1,
      entries: [...entries.values()].map((entry) => ({
        ownership: structuredClone(entry.ownership),
        artifact: structuredClone(entry.artifact),
        bufferBase64: entry.buffer.toString("base64"),
      })),
    });
  }

  private commit(entries: Map<string, StoredExcelExport>, operationTime = this.currentTime()): void {
    try {
      this.persist(entries);
      this.lastPersistenceErrorAt = null;
    } catch (error) {
      if (this.persistence) this.lastPersistenceErrorAt = new Date(operationTime).toISOString();
      throw error;
    }
    this.entries.clear();
    entries.forEach((entry, id) => this.entries.set(id, entry));
  }

  private pruneAndPersist(now: number): void {
    const next = this.withoutExpired(now);
    if (next.size !== this.entries.size) this.commit(next, now);
  }

  put(generated: GeneratedRecipeExcel, ownership: OwnershipScope, now = new Date(this.currentTime())): ExcelExportArtifact {
    if (
      !Buffer.isBuffer(generated.buffer)
      || generated.buffer.length === 0
      || generated.buffer.length !== generated.sizeBytes
      || generated.buffer.length > this.maxFileBytes
    ) {
      throw new Error("Excel 下载文件内容与元数据不一致");
    }
    const operationTime = this.checkedTimestamp(now.getTime(), "Excel 下载操作时间");
    const next = this.withoutExpired(operationTime);
    const id = this.createUniqueId(next);
    const artifact = excelExportArtifactSchema.parse({
      id,
      status: "ready",
      fileName: generated.fileName,
      downloadUrl: `/api/exports/${id}`,
      rowCount: generated.rowCount,
      fieldCount: generated.fieldCount,
      sizeBytes: generated.sizeBytes,
      createdAt: new Date(operationTime).toISOString(),
      expiresAt: new Date(operationTime + EXCEL_EXPORT_TTL_MS).toISOString(),
    } satisfies ExcelExportArtifact);
    next.set(id, {
      ownership: { tenantId: ownership.tenantId, ownerId: ownership.ownerId },
      artifact,
      buffer: Buffer.from(generated.buffer),
    });
    while (next.size > this.maxExports) next.delete(next.keys().next().value!);
    this.commit(next, operationTime);
    return artifact;
  }

  get(id: string, ownership: OwnershipScope, now = new Date(this.currentTime())): StoredExcelExport | undefined {
    const operationTime = this.checkedTimestamp(now.getTime(), "Excel 下载操作时间");
    this.pruneAndPersist(operationTime);
    const stored = this.entries.get(id);
    return stored && sameOwnership(stored.ownership, ownership)
      ? {
          ownership: structuredClone(stored.ownership),
          artifact: structuredClone(stored.artifact),
          buffer: Buffer.from(stored.buffer),
        }
      : undefined;
  }

  revoke(id: string, ownership: OwnershipScope): boolean {
    const stored = this.entries.get(id);
    if (!stored || !sameOwnership(stored.ownership, ownership)) return false;
    const next = new Map(this.entries);
    next.delete(id);
    this.commit(next);
    return true;
  }

  clear(): void {
    this.commit(new Map());
  }

  health(now = new Date(this.currentTime())): ExcelExportStoreHealth {
    const operationTime = this.checkedTimestamp(now.getTime(), "Excel 下载操作时间");
    try { this.pruneAndPersist(operationTime); } catch { /* health remains readable and reports the recorded persistence failure */ }
    const count = this.withoutExpired(operationTime).size;
    const utilization = this.maxExports === 0 ? 1 : count / this.maxExports;
    const persistenceHealthy = this.lastPersistenceErrorAt === null;
    return {
      mode: this.persistence ? "json-file" : "memory",
      persistenceHealthy,
      lastPersistenceErrorAt: this.lastPersistenceErrorAt,
      count,
      capacity: this.maxExports,
      utilization,
      warning: !persistenceHealthy
        ? "Excel 下载本地持久化最近一次写入失败"
        : utilization >= 0.8 ? `Excel 下载容量已使用 ${Math.round(utilization * 100)}%` : null,
    };
  }

  private withoutExpired(now: number): Map<string, StoredExcelExport> {
    const next = new Map(this.entries);
    for (const [id, entry] of this.entries) {
      if (Date.parse(entry.artifact.expiresAt) <= now) next.delete(id);
    }
    return next;
  }

  private currentTime(): number {
    return this.checkedTimestamp(this.clock(), "Excel 下载时钟");
  }

  private checkedTimestamp(value: number, label: string): number {
    if (!Number.isSafeInteger(value) || Math.abs(value) > MAX_DATE_TIMESTAMP_MS) {
      throw new Error(`${label}必须返回有效 Date 范围内的安全整数毫秒时间戳`);
    }
    return value;
  }

  private createUniqueId(entries: Map<string, StoredExcelExport>): string {
    for (let attempt = 0; attempt < MAX_EXPORT_ID_ATTEMPTS; attempt += 1) {
      const id = this.idFactory();
      if (!EXPORT_ID_PATTERN.test(id)) throw new Error("Excel 下载标识生成器返回了非法标识");
      if (!entries.has(id)) return id;
    }
    throw new Error("Excel 下载标识连续碰撞，拒绝覆盖已有文件");
  }
}

const globalStore = globalThis as typeof globalThis & { __studioExcelExportStore?: ExcelExportStore };
export let excelExportStoreStartupError: string | null = null;
function createExcelExportStore() {
  try {
    return new ExcelExportStore({
      persistence: configuredSnapshotAdapter("excel-exports.json", excelExportSnapshotSchema, 256 * 1024 * 1024),
    });
  } catch (error) {
    excelExportStoreStartupError = error instanceof Error ? error.message : "Excel 导出持久化初始化失败";
    return new ExcelExportStore();
  }
}
export const excelExportStore = globalStore.__studioExcelExportStore ??= createExcelExportStore();
