import { describe, expect, it } from "vitest";
import type { NotebookCell } from "./definition";
import {
  DEFAULT_NOTEBOOK_CAPABILITIES,
  notebookCapabilityMutationIssue,
  type NotebookCapabilities,
} from "./capabilities";

const disabled: NotebookCapabilities = { python: { enabled: false } };
const python: NotebookCell = {
  id: "python",
  kind: "python",
  title: "Python 清洗",
  inputCellIds: ["data"],
  fileNames: [],
  outputName: "cleaned",
  code: "cleaned = raw.copy()",
};
const sql: NotebookCell = {
  id: "sql",
  kind: "sql",
  title: "SQL 汇总",
  inputCellIds: ["data"],
  outputName: "summary",
  sql: "SELECT 1 AS value",
};

describe("Notebook disabled capability mutation guard", () => {
  it("allows unrelated changes while preserving the disabled definition exactly", () => {
    expect(notebookCapabilityMutationIssue(disabled, [python, sql], [
      { ...sql, title: "SQL 月度汇总" },
      { code: python.code, outputName: python.outputName, fileNames: [], inputCellIds: ["data"],
        title: python.title, kind: "python", id: python.id },
    ])).toBeUndefined();
  });

  it("rejects removing, editing, replacing or adding disabled definitions", () => {
    expect(notebookCapabilityMutationIssue(disabled, [python, sql], [sql])).toContain("不能移除");
    expect(notebookCapabilityMutationIssue(disabled, [python, sql], [{ ...python, code: "cleaned = raw" }, sql]))
      .toContain("不能修改");
    expect(notebookCapabilityMutationIssue(disabled, [sql], [sql, python])).toContain("不能新增或替换");
    expect(notebookCapabilityMutationIssue(disabled, [python, sql], [{ ...sql, id: python.id }, sql]))
      .toContain("不能修改");
  });

  it("does not lock Python while the capability is enabled", () => {
    expect(notebookCapabilityMutationIssue(DEFAULT_NOTEBOOK_CAPABILITIES, [python], [])).toBeUndefined();
  });
});
