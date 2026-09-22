import { describe, expect, it } from "vitest";
import type { NotebookResultReference, NotebookTable } from "../contracts";
import { createNotebookResultCapture } from "./result-capture";

function fixture() {
  const table: NotebookTable = { fields: [{ name: "exact", label: "Exact", type: "string" }, { name: "enabled", label: "Enabled", type: "boolean" }],
    rows: [{ exact: "9007199254740993.00001", enabled: true }, { exact: null, enabled: false }], truncated: false };
  const reference: NotebookResultReference = { resultId: "run:target", runId: "run", cellId: "target", revision: 7, mode: "table",
    inputResultIds: ["run:source"], rowCount: 2, complete: true, dataSignature: "synthetic-signature", accessMode: "user",
    sourceDatasetIds: ["synthetic-source"] };
  const capture = createNotebookResultCapture({ cellId: "target", revision: 7, accessMode: "user" });
  return { capture, reference, table };
}

describe("request-owned complete Notebook result capture", () => {
  it("captures typed complete data and clones across both write and read boundaries", () => {
    const { capture, reference, table } = fixture();
    const original = structuredClone(table);
    capture.publishResult({ reference, table });
    table.rows[0].exact = "changed input";
    reference.sourceDatasetIds!.push("changed source");
    const expectedRef = { ...reference, sourceDatasetIds: ["synthetic-source"] };
    const first = capture.read(expectedRef);
    expect(first).toEqual(original);
    first.rows[0].exact = "changed reader";
    expect(capture.read(expectedRef)).toEqual(original);
  });

  it("ignores other cells but rejects reads before a matching publication", () => {
    const { capture, reference, table } = fixture();
    capture.publishResult({ reference: { ...reference, cellId: "other" }, table });
    expect(() => capture.read(reference)).toThrow("没有可保存的完整结果");
    capture.publishResult({ reference, table });
    expect(capture.read(reference)).toEqual(table);
  });

  it.each([
    { revision: 8 }, { accessMode: "ai" as const },
  ])("rejects an out-of-scope publication %j", (changed) => {
    const { capture, reference, table } = fixture();
    expect(() => capture.publishResult({ reference: { ...reference, ...changed }, table })).toThrow("保存范围");
    expect(() => capture.read(reference)).toThrow("没有可保存的完整结果");
  });

  it.each([
    { runId: "other-run" }, { resultId: "other-result" }, { cellId: "other" }, { revision: 8 },
    { accessMode: "ai" as const }, { dataSignature: "other-signature" }, { rowCount: 3 },
    { complete: false }, { inputResultIds: ["run:other"] }, { sourceDatasetIds: ["other-source"] },
    { connectionId: "other-connection" },
  ])("rejects a different result reference %j", (changed) => {
    const { capture, reference, table } = fixture();
    capture.publishResult({ reference, table });
    expect(() => capture.read({ ...reference, ...changed })).toThrow("引用");
  });

  it.each(["incomplete", "truncated", "wrong-count"])("does not capture a %s table", (kind) => {
    const { capture, reference, table } = fixture();
    if (kind === "incomplete") reference.complete = false;
    if (kind === "truncated") table.truncated = true;
    if (kind === "wrong-count") reference.rowCount++;
    expect(() => capture.publishResult({ reference, table })).toThrow("完整");
    expect(() => capture.read(reference)).toThrow("没有可保存的完整结果");
  });

  it("rejects duplicate publication without overwriting the first captured result", () => {
    const { capture, reference, table } = fixture();
    capture.publishResult({ reference, table });
    expect(() => capture.publishResult({ reference, table: { ...table, rows: [] } })).toThrow("重复发布");
    expect(capture.read(reference)).toEqual(table);
  });

  it("keeps parallel request captures independent and permanently closes on dispose", () => {
    const first = fixture(), second = fixture();
    first.capture.publishResult({ reference: first.reference, table: first.table });
    expect(() => second.capture.read(first.reference)).toThrow("没有可保存的完整结果");
    first.capture.dispose(); first.capture.dispose();
    expect(() => first.capture.read(first.reference)).toThrow("已释放");
    expect(() => first.capture.publishResult(first)).toThrow("已释放");
    second.capture.publishResult(second);
    expect(second.capture.read(second.reference)).toEqual(second.table);
  });

  it("honors cancellation before publication and before materialization", () => {
    const { reference, table } = fixture();
    const before = new AbortController();
    const first = createNotebookResultCapture({ cellId: "target", revision: 7, accessMode: "user", signal: before.signal });
    before.abort();
    expect(() => first.publishResult({ reference, table })).toThrow();
    const after = new AbortController();
    const second = createNotebookResultCapture({ cellId: "target", revision: 7, accessMode: "user", signal: after.signal });
    second.publishResult({ reference, table });
    after.abort();
    expect(() => second.read(reference)).toThrow();
  });

  it("accepts at most 50000 rows and refuses larger tables without retaining them", () => {
    const { reference, table } = fixture();
    const rows = Array.from({ length: 50_000 }, () => ({ exact: "1", enabled: false }));
    const limit = createNotebookResultCapture({ cellId: "target", revision: 7, accessMode: "user" });
    const fullRef = { ...reference, rowCount: rows.length };
    limit.publishResult({ reference: fullRef, table: { ...table, rows } });
    expect(limit.read(fullRef).rows).toHaveLength(50_000);
    const over = fixture().capture;
    expect(() => over.publishResult({ reference: { ...fullRef, rowCount: 50_001 }, table: { ...table, rows: [...rows, rows[0]] } })).toThrow("50000");
    expect(() => over.read(fullRef)).toThrow("没有可保存的完整结果");
    limit.dispose(); over.dispose();
  });

  it("counts UTF-8 bytes against the 4 MiB save capture limit", () => {
    const { capture, reference } = fixture();
    const table: NotebookTable = { fields: [{ name: "value", label: "Text", type: "string" }],
      rows: Array.from({ length: 500 }, () => ({ value: "汉".repeat(3000) })), truncated: false };
    expect(JSON.stringify(table).length).toBeLessThan(4 * 1024 * 1024);
    expect(() => capture.publishResult({ reference: { ...reference, rowCount: 500 }, table })).toThrow("4 MiB");
    expect(() => capture.read(reference)).toThrow("没有可保存的完整结果");
  });
});
