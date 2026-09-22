import { describe, expect, it } from "vitest";
import type { DataTable } from "@/core/datasets/table-contracts";
import { nextNotebookPreviewSort, notebookOrderedPreview, notebookTablePreview, type NotebookPreviewSort } from "./table-preview";

const ascending: NotebookPreviewSort = { fieldName: "value", direction: "ascending" };
const descending: NotebookPreviewSort = { fieldName: "value", direction: "descending" };
function table(values: (string | number | boolean | null)[], type: DataTable["fields"][number]["type"] = "number"): DataTable {
  return { fields: [{ name: "value", label: "值", type }], rows: values.map((value, index) => ({ value, index })), truncated: false };
}
const values = (preview: ReturnType<typeof notebookTablePreview>) => preview.rows.map((row) => row.value);

describe("Notebook preview sorting and pagination", () => {
  it("cycles original, ascending, descending, original and starts another column ascending", () => {
    expect(nextNotebookPreviewSort(null, "value")).toEqual(ascending);
    expect(nextNotebookPreviewSort(ascending, "value")).toEqual(descending);
    expect(nextNotebookPreviewSort(descending, "value")).toBeNull();
    expect(nextNotebookPreviewSort(descending, "other")).toEqual({ fieldName: "other", direction: "ascending" });
  });
  it("sorts numbers numerically, keeping zero, negative and fractions", () => {
    const input = table([10, 2, 0, -2, 1.5]);
    expect(values(notebookTablePreview(input, ascending, 0))).toEqual([-2, 0, 1.5, 2, 10]);
    expect(values(notebookTablePreview(input, descending, 0))).toEqual([10, 2, 1.5, 0, -2]);
  });
  it.each([ascending, descending])("keeps null and missing values last and ties stable: %o", (sort) => {
    const input = table([null, 2, 2, 1, null]);
    input.rows.push({ index: 5 });
    const result = notebookTablePreview(input, sort, 0);
    expect(result.rows.slice(-3).map((row) => row.index)).toEqual([0, 4, 5]);
    expect(result.rows.filter((row) => row.value === 2).map((row) => row.index)).toEqual([1, 2]);
  });
  it("preserves exact numeric strings, leading zeros and empty strings as text", () => {
    const input = table(["9007199254740993.00002", "9007199254740993.00001", "10", "2", "001", "", null], "string");
    expect(values(notebookTablePreview(input, ascending, 0))).toEqual(["", "001", "10", "2", "9007199254740993.00001", "9007199254740993.00002", null]);
  });
  it("sorts boolean values false first without treating false as empty", () => {
    const input = table([true, null, false, false], "boolean");
    expect(values(notebookTablePreview(input, ascending, 0))).toEqual([false, false, true, null]);
    expect(values(notebookTablePreview(input, descending, 0))).toEqual([true, false, false, null]);
  });
  it("orders mixed numeric fields by value type first without nontransitive text coercion", () => {
    const input = table(["15", 10, "3", 2, null, false]);
    expect(values(notebookTablePreview(input, ascending, 0))).toEqual([2, 10, "15", "3", false, null]);
    expect(values(notebookTablePreview(input, descending, 0))).toEqual([false, "3", "15", 10, 2, null]);
  });
  it("does not coerce strings in a mixed boolean field", () => {
    const input = table(["false", true, false, null, "true"], "boolean");
    expect(values(notebookTablePreview(input, ascending, 0))).toEqual([false, true, "false", "true", null]);
  });
  it("sorts date text without normalizing time zones or invalid dates", () => {
    const input = table(["2026-09-16T00:00:00+08:00", "2026-09-15T20:00:00Z", "invalid"], "date");
    expect(values(notebookTablePreview(input, ascending, 0))).toEqual(["2026-09-15T20:00:00Z", "2026-09-16T00:00:00+08:00", "invalid"]);
  });
  it("sorts the entire available preview before slicing pages and does not mutate source order", () => {
    const input = table(Array.from({ length: 45 }, (_, i) => 45 - i));
    const before = structuredClone(input);
    expect(values(notebookTablePreview(input, ascending, 0))).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(values(notebookTablePreview(input, ascending, 2))).toEqual([41, 42, 43, 44, 45]);
    expect(values(notebookTablePreview(input, null, 0))).toEqual(before.rows.slice(0, 20).map((row) => row.value));
    expect(input).toEqual(before);
  });
  it("never expands a truncated preview into a fabricated full result", () => {
    const input = { ...table(Array.from({ length: 1000 }, (_, i) => 1000 - i)), truncated: true };
    const result = notebookTablePreview(input, ascending, 49);
    expect(result.pageCount).toBe(50);
    expect(values(result)).toEqual(Array.from({ length: 20 }, (_, i) => i + 981));
    expect(input.truncated).toBe(true);
  });
  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])("clamps invalid page %s to the first page", (page) => {
    expect(notebookTablePreview(table([2, 1]), null, page).page).toBe(0);
  });
  it("clamps a removed page and accepts an empty table", () => {
    expect(notebookTablePreview(table(Array.from({ length: 21 }, (_, i) => i)), null, 50).page).toBe(1);
    expect(notebookTablePreview(table([]), ascending, 3)).toMatchObject({ rows: [], page: 0, pageCount: 1 });
  });
  it("ignores a removed sort field without inspecting arbitrary row properties", () => {
    const input = table([2, 1]);
    expect(notebookTablePreview(input, { fieldName: "index", direction: "descending" }, 0)).toMatchObject({ sort: null, rows: input.rows });
  });
  it("exposes all available sorted rows while pagination remains an exact slice of the same ordering", () => {
    const input = table(Array.from({ length: 45 }, (_, index) => 45 - index));
    const sorted = notebookOrderedPreview(input, ascending);
    expect(sorted.sort).toEqual(ascending);
    expect(sorted.rows.map((row) => row.value)).toEqual(Array.from({ length: 45 }, (_, index) => index + 1));
    for (let page = 0; page < 3; page += 1) {
      expect(notebookTablePreview(input, ascending, page).rows).toEqual(sorted.rows.slice(page * 20, (page + 1) * 20));
    }
    expect(input.rows[0].value).toBe(45);
  });
  it("exports only a supplied truncated preview and keeps invalid-sort fallback unchanged", () => {
    const input = { ...table([3, 1, null, 2]), truncated: true };
    expect(notebookOrderedPreview(input, ascending).rows.map((row) => row.value)).toEqual([1, 2, 3, null]);
    expect(notebookOrderedPreview(input, { fieldName: "absent", direction: "descending" })).toEqual({ sort: null, rows: input.rows });
    expect(notebookOrderedPreview(input, null)).toEqual({ sort: null, rows: input.rows });
    expect(input.truncated).toBe(true);
  });
  it("returns an empty ordered preview without inventing a row or changing the original pagination shape", () => {
    const input = table([]);
    expect(notebookOrderedPreview(input, descending)).toEqual({ sort: descending, rows: [] });
    expect(notebookTablePreview(input, descending, 0)).toEqual({ sort: descending, page: 0, pageCount: 1, rows: [] });
  });
});
