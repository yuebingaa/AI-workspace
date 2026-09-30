import { describe, expect, it, vi } from "vitest";
import { executeVisualization } from "./execute";
import { definition, inputFor, sales } from "../test-fixture";
import { parseMaterializedVisualization } from "../result";

const computed = { fields: [{ name: "quarter", label: "quarter", type: "date" as const },
  { name: "segment", label: "segment", type: "string" as const }, { name: "amount", label: "amount", type: "number" as const }],
rows: [{ quarter: "2024-01-01", segment: "企业", amount: 150 }], truncated: false };
describe("V2 execution and result boundary", () => {
  it.each(["runId", "revision", "accessMode", "cellId", "resultId", "rowCount", "dataSignature"] as const)("refuses wrong %s before query", async key => {
    const input = await inputFor(), query = vi.fn();
    Object.assign(input.reference, { [key]: typeof input.reference[key] === "number" ? 999 : "mismatch" });
    await expect(executeVisualization(input, query)).rejects.toThrow(); expect(query).not.toHaveBeenCalled();
  });
  it("refuses a preview slice even if marked non-truncated", async () => {
    const input = await inputFor(), query = vi.fn(); input.table = { ...sales, rows: sales.rows.slice(0, 1) };
    await expect(executeVisualization(input, query)).rejects.toThrow(/完整上游/); expect(query).not.toHaveBeenCalled();
  });
  it("refuses truncation without a successful result", async () => {
    await expect(executeVisualization(await inputFor(), async () => ({ ...computed, truncated: true }))).rejects.toThrow(/超过展示范围/);
  });
  it.each([
    (out: typeof computed) => { out.fields[2].type = "string" as "number"; },
    out => { out.rows[0].amount = Number.MAX_SAFE_INTEGER + 1; },
    out => { out.rows[0].amount = 0.1; },
    out => { Object.assign(out.rows[0], { hidden: 1 }); },
  ] satisfies ((out: typeof computed) => void)[])("refuses invalid returned table %#", async edit => {
    const out = structuredClone(computed); edit(out); await expect(executeVisualization(await inputFor(), async () => out)).rejects.toThrow();
  });
  it("never accepts cancellation before or after the query", async () => {
    const controller = new AbortController(), input = await inputFor(), query = vi.fn(); controller.abort();
    await expect(executeVisualization({ ...input, signal: controller.signal }, query)).rejects.toThrow(); expect(query).not.toHaveBeenCalled();
    const late = new AbortController();
    await expect(executeVisualization({ ...input, signal: late.signal }, async () => { late.abort(); return computed; })).rejects.toThrow();
  });
  it("preserves query errors instead of manufacturing success", async () => {
    await expect(executeVisualization(await inputFor(), async () => { throw Error("test timeout"); })).rejects.toThrow("test timeout");
  });
  it("validates identity, data and table hash on restoration; styles do not invalidate values", async () => {
    const input = await inputFor(), d = definition(), query = vi.fn(async () => computed);
    const result = await executeVisualization(input, query);
    expect(query).toHaveBeenCalledTimes(1);
    const expected = { ...input.expected, inputResultId: input.reference.resultId, inputRowCount: sales.rows.length };
    d.presentation.palette = "warm";
    expect(await parseMaterializedVisualization(JSON.parse(JSON.stringify(result)), d, expected)).toEqual(result);
    await expect(parseMaterializedVisualization(result, d, { ...expected, revision: 99 })).rejects.toThrow(/不一致/);
    const changed = structuredClone(result); changed.table.rows[0].amount = 999;
    await expect(parseMaterializedVisualization(changed, d, expected)).rejects.toThrow(/不一致/);
    d.data.filters = [{ kind: "oneOf", field: "客户类型", values: ["个人"] }];
    await expect(parseMaterializedVisualization(result, d, expected)).rejects.toThrow(/不一致/);
  });
});
