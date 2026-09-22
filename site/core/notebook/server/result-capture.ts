import { dataTableSchema } from "@/core/datasets/table-contracts";
import { NOTEBOOK_LIMITS, notebookResultReferenceSchema, type NotebookResultReference, type NotebookTable } from "../contracts";
import type { NotebookResultPublication } from "../result-access";

/** A request-owned save buffer, not a cache, permission system, or result URL resolver. */
export function createNotebookResultCapture(scope: {
  cellId: string;
  revision: number;
  accessMode: NotebookResultReference["accessMode"];
  signal?: AbortSignal;
}) {
  const { cellId, revision, accessMode, signal } = scope;
  let disposed = false;
  let captured: { referenceKey: string; table: NotebookTable } | undefined;
  const assertOpen = () => {
    if (disposed) throw new Error("Notebook 完整结果捕获已释放");
    signal?.throwIfAborted();
  };
  return {
    publishResult({ reference, table }: NotebookResultPublication): void {
      assertOpen();
      if (reference.cellId !== cellId) return;
      if (captured) throw new Error("Notebook 完整结果已捕获，不能重复发布");
      if (reference.revision !== revision || reference.accessMode !== accessMode) throw new Error("Notebook 完整结果与当前保存范围不一致");
      const normalizedReference = notebookResultReferenceSchema.parse(reference);
      if (!normalizedReference.complete || table.truncated || normalizedReference.rowCount !== table.rows.length) {
        throw new Error("只有成功且完整的表格结果才能保存；不能使用截断预览");
      }
      if (table.rows.length > 50_000) throw new Error("Notebook 保存结果最多 50000 行，请先筛选或聚合数据");
      // This is a save-only limit. It does not change ordinary Notebook run or
      // engine budgets; the API independently checks its full response size.
      if (Buffer.byteLength(JSON.stringify(table), "utf8") > NOTEBOOK_LIMITS.outputBytes * 2) {
        throw new Error("Notebook 保存结果超过 4 MiB，请先筛选或聚合数据");
      }
      const copiedTable = dataTableSchema.parse(table);
      assertOpen();
      captured = { referenceKey: JSON.stringify(normalizedReference), table: copiedTable };
    },
    read(reference: NotebookResultReference): NotebookTable {
      assertOpen();
      if (!captured) throw new Error("本次运行没有可保存的完整结果");
      // Canonical schema key order compares every reference field, including
      // lineage/connection metadata. The caller's current request owns access.
      const key = JSON.stringify(notebookResultReferenceSchema.parse(reference));
      if (key !== captured.referenceKey) throw new Error("Notebook 完整结果引用与本次运行不一致");
      return structuredClone(captured.table);
    },
    dispose(): void {
      captured = undefined;
      disposed = true;
    },
  };
}
