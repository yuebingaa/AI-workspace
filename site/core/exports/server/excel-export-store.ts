import { randomUUID } from "node:crypto";
import { sameOwnership, type OwnershipScope } from "@/core/identity/ownership";
import type { ExcelExportArtifact } from "../contracts";
import type { GeneratedRecipeExcel } from "./recipe-excel-export";

export const EXCEL_EXPORT_TTL_MS = 10 * 60_000;
export const MAX_STORED_EXPORTS = 20;

interface StoredExcelExport {
  ownership: OwnershipScope;
  artifact: ExcelExportArtifact;
  buffer: Buffer;
}

class ExcelExportStore {
  private readonly entries = new Map<string, StoredExcelExport>();

  put(generated: GeneratedRecipeExcel, ownership: OwnershipScope, now = new Date()): ExcelExportArtifact {
    this.prune(now.getTime());
    const id = randomUUID().replaceAll("-", "");
    const artifact: ExcelExportArtifact = {
      id,
      status: "ready",
      fileName: generated.fileName,
      downloadUrl: `/api/exports/${id}`,
      rowCount: generated.rowCount,
      fieldCount: generated.fieldCount,
      sizeBytes: generated.sizeBytes,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + EXCEL_EXPORT_TTL_MS).toISOString(),
    };
    this.entries.set(id, {
      ownership: { tenantId: ownership.tenantId, ownerId: ownership.ownerId },
      artifact,
      buffer: generated.buffer,
    });
    while (this.entries.size > MAX_STORED_EXPORTS) this.entries.delete(this.entries.keys().next().value!);
    return artifact;
  }

  get(id: string, ownership: OwnershipScope, now = new Date()): StoredExcelExport | undefined {
    this.prune(now.getTime());
    const stored = this.entries.get(id);
    return stored && sameOwnership(stored.ownership, ownership) ? stored : undefined;
  }

  clear(): void {
    this.entries.clear();
  }

  private prune(now: number): void {
    for (const [id, entry] of this.entries) {
      if (Date.parse(entry.artifact.expiresAt) <= now) this.entries.delete(id);
    }
  }
}

const globalStore = globalThis as typeof globalThis & { __studioExcelExportStore?: ExcelExportStore };
export const excelExportStore = globalStore.__studioExcelExportStore ??= new ExcelExportStore();
