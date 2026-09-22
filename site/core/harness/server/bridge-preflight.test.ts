import { describe, expect, it } from "vitest";
import { StudioValidationError } from "@/core/schemas/errors";
import { NotebookBridgePreflightError, notebookBridgePreflightMessage, type NotebookBridgePreflightCode } from "./bridge-preflight";

const codes: NotebookBridgePreflightCode[] = ["missing_notebook_context", "unsupported_task_context", "unsupported_csv_profile",
  "source_unavailable", "workbook_context_mismatch", "missing_data_context", "workspace_unavailable",
  "notebook_cell_unsupported", "notebook_reference_unavailable", "python_unavailable"];

describe("finite bridge preflight diagnostics", () => {
  it.each(codes)("%s preserves validation classification and exposes only the fixed code/message", code => {
    const error = new NotebookBridgePreflightError(code);
    expect(error).toBeInstanceOf(StudioValidationError);
    const expected = notebookBridgePreflightMessage(error);
    expect(expected).toContain(`（${code}）`);
    error.message = "SYNTHETIC_PRIVATE/path/attachment.xlsx";
    error.issues.push("SYNTHETIC_PRIVATE_DATASET_ID");
    expect(notebookBridgePreflightMessage(error)).toBe(expected);
    expect(expected).not.toContain("SYNTHETIC_PRIVATE");
    expect(expected!.length).toBeLessThan(600);
  });

  it("unknown, lookalike, prototype keys and mutated codes do not become trusted diagnoses", () => {
    const fake = Object.assign(new Error("SYNTHETIC_PRIVATE"), { name: "NotebookBridgePreflightError", code: "source_unavailable" });
    expect(notebookBridgePreflightMessage(fake)).toBeUndefined();
    expect(notebookBridgePreflightMessage({ code: "source_unavailable" })).toBeUndefined();
    expect(notebookBridgePreflightMessage(new StudioValidationError("Notebook 工具桥拒绝请求", ["SYNTHETIC_PRIVATE"]))).toBeUndefined();
    for (const code of ["SYNTHETIC_PRIVATE", "constructor", "__proto__"]) {
      const error = new NotebookBridgePreflightError("source_unavailable");
      Object.assign(error, { code });
      expect(notebookBridgePreflightMessage(error)).toBeUndefined();
    }
  });
});
