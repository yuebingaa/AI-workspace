import { describe, expect, it, vi } from "vitest";
import { HarnessToolArgumentsError } from "@/core/harness/tool-registry";
import { NotebookSearchError } from "@/core/notebook/search";
import { NotebookSearchStateError } from "@/core/harness/notebook-cell-search";
import { NotebookSubmissionError } from "@/core/harness/notebook-submission-error";
import { notebookSearchFailureMessage, notebookToolFailureMessage } from "../../../runtime/dsh/tool-diagnostics.mjs";
import { dshToolErrorMessage, trustedNotebookSearchFailure } from "./tool-error-message";

const parameters = { type: "object", properties: {
  query: { type: "string" }, bindings: { type: "object", additionalProperties: { type: "string" } },
  cells: { type: "array", items: { $ref: "#/$defs/cell" } },
}, $defs: { cell: { anyOf: [{ type: "object", properties: { code: { type: "string" } } }] } } };
const secret = "SYNTHETIC_PRIVATE_VALUE_DO_NOT_EXPORT";
const input = (error: unknown) => ({ name: "cellSearch" as const, parameters, error,
  signal: new AbortController().signal, authorizeCurrentAccess: vi.fn(() => {}) });

describe("DSH public tool error message", () => {
  it.each(["notebook_submit_version_stale", "notebook_submit_no_changes", "notebook_submit_run_required",
    "notebook_submit_receipt_mismatch"] as const)("trusted submission %s explains the guard without treating it as recoverable search", code => {
    const error = new NotebookSubmissionError(code);
    error.message = secret;
    const options = { ...input(error), name: "submitNotebookDraft" as const };
    const message = dshToolErrorMessage(options);
    expect(message).toContain(code);
    expect(message).toBe(notebookToolFailureMessage({ error: { code } }, "submitNotebookDraft"));
    expect(message).not.toContain(secret);
    expect(options.authorizeCurrentAccess).toHaveBeenCalledOnce();
    expect(trustedNotebookSearchFailure("submitNotebookDraft", error)).toBeUndefined();
    expect(trustedNotebookSearchFailure("cellSearch", error)).toBeUndefined();
  });

  it.each(["spoofed", "unknown-code", "wrong-tool", "revoked", "cancelled", "cancelled-during"])("submission %s stays generic", kind => {
    const error = kind === "spoofed" ? Object.assign(new Error(secret), { name: "NotebookSubmissionError", code: "notebook_submit_no_changes" })
      : new NotebookSubmissionError("notebook_submit_no_changes");
    if (kind === "unknown-code") Object.assign(error, { code: secret });
    const controller = new AbortController();
    const options = { ...input(error), name: kind === "wrong-tool" ? "runNotebookCells" as const : "submitNotebookDraft" as const,
      signal: controller.signal };
    if (kind === "revoked") options.authorizeCurrentAccess.mockImplementation(() => { throw new Error(secret); });
    if (kind === "cancelled") controller.abort(new Error(secret));
    if (kind === "cancelled-during") options.authorizeCurrentAccess.mockImplementation(() => controller.abort(new Error(secret)));
    expect(dshToolErrorMessage(options)).toBe(`${options.name} 执行失败。`);
  });

  it.each([
    new NotebookSearchError("notebook_search_anchor_not_found"),
    new NotebookSearchError("notebook_search_anchor_required"),
    new NotebookSearchStateError("notebook_search_version_stale"),
    new NotebookSearchStateError("notebook_search_run_stale"),
    new NotebookSearchStateError("notebook_search_budget_exceeded"),
  ])("trusted search code $code shares the exact fixed model/UI message", error => {
    error.message = `synthetic/private/path ${secret}`;
    const options = input(error);
    expect(dshToolErrorMessage(options)).toBe(notebookSearchFailureMessage({ error: { code: error.code } }, "cellSearch"));
    expect(dshToolErrorMessage(options)).not.toContain(secret);
  });

  it.each(["spoofed", "unknown-code", "wrong-tool", "revoked", "cancelled"])("business %s cannot expose trusted search diagnostics", kind => {
    const error = kind === "spoofed" ? Object.assign(new Error(secret), { name: "NotebookSearchError", code: "notebook_search_anchor_not_found" })
      : new NotebookSearchError("notebook_search_anchor_not_found");
    if (kind === "unknown-code") Object.assign(error, { code: secret });
    const controller = new AbortController();
    const options = { ...input(error), name: kind === "wrong-tool" ? "editNotebookCells" as const : "cellSearch" as const, signal: controller.signal };
    if (kind === "revoked") options.authorizeCurrentAccess.mockImplementation(() => { throw new Error(secret); });
    if (kind === "cancelled") controller.abort(new Error(secret));
    expect(dshToolErrorMessage(options)).toBe(`${options.name} 执行失败。`);
  });

  it("rechecks authorization and keeps only bounded schema-owned fields and known issue codes", () => {
    const options = input(new HarnessToolArgumentsError("cellSearch", [
      `query:invalid_type；要求 ${secret}`, `bindings.${secret}:custom；${secret}`,
      `cells.0.code:invalid_format；${secret}`, `${secret}:invalid_value`, `query:${secret}`,
      "query:too_small", "query:too_big",
    ]));
    const message = dshToolErrorMessage(options);
    expect(options.authorizeCurrentAccess).toHaveBeenCalledOnce();
    expect(message).toBe("cellSearch 参数校验失败（invalid_tool_arguments）：query: invalid_type；bindings: custom；cells.0.code: invalid_format；$: invalid_value；query: too_small。请按工具定义修正参数。");
    expect(message).not.toContain(secret);
    expect(message).not.toContain("too_big");
    expect(message.length).toBeLessThan(2_000);
  });

  it.each(["unknown", "spoofed", "wrong-tool"])("%s errors cannot impersonate trusted argument diagnostics", kind => {
    const error = kind === "wrong-tool" ? new HarnessToolArgumentsError("editNotebookCells", [`query:invalid_type；${secret}`])
      : kind === "spoofed" ? Object.assign(new Error(secret), { name: "HarnessToolArgumentsError", toolName: "cellSearch", issueSummary: ["query:invalid_type"] })
      : new Error(`synthetic/private/path ${secret}`);
    const options = input(error);
    expect(dshToolErrorMessage(options)).toBe("cellSearch 执行失败。");
    expect(options.authorizeCurrentAccess).not.toHaveBeenCalled();
  });

  it("does not disclose field diagnostics after authorization was revoked", () => {
    const options = input(new HarnessToolArgumentsError("cellSearch", ["query:invalid_type"]));
    options.authorizeCurrentAccess.mockImplementation(() => { throw new Error(secret); });
    expect(dshToolErrorMessage(options)).toBe("cellSearch 执行失败。");
    expect(options.authorizeCurrentAccess).toHaveBeenCalledOnce();
  });

  it.each(["before", "during"])("%s cancellation suppresses even trusted field diagnostics", phase => {
    const controller = new AbortController();
    const options = { ...input(new HarnessToolArgumentsError("cellSearch", ["query:invalid_type"])), signal: controller.signal };
    if (phase === "before") controller.abort(new Error(secret));
    else options.authorizeCurrentAccess.mockImplementation(() => controller.abort(new Error(secret)));
    expect(dshToolErrorMessage(options)).toBe("cellSearch 执行失败。");
    expect(options.authorizeCurrentAccess).toHaveBeenCalledTimes(phase === "before" ? 0 : 1);
  });
});
