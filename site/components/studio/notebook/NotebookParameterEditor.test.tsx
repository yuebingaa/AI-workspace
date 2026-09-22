import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { NotebookCell } from "@/core/notebook/definition";
import type { NotebookParameter } from "@/core/notebook/parameter";
import { NotebookCellEditor } from "./NotebookCellEditor";
import { NotebookParameterEditor, NotebookParameterSummary, parseNotebookParameterInput } from "./NotebookParameterEditor";
import { cellSource, cellReviewSource } from "./cell-source";

const cell = (parameter: NotebookParameter): Extract<NotebookCell, { kind: "parameter" }> => ({
  id: "threshold", kind: "parameter", title: "合成参数", outputName: "threshold", parameter,
});

describe("Notebook parameter editor", () => {
  it.each(["", "  leading and trailing  ", "line 1\nline 2", "'); DROP TABLE records; --", "9007199254740993"])("preserves text exactly: %j", (value) => {
    expect(parseNotebookParameterInput("text", value, [])).toEqual({ type: "text", value });
  });
  it.each(["", " ", "NaN", "Infinity", "-Infinity", "0xff", "1,000", "1e999", "9007199254740992"])("rejects invalid/unsafe numeric input %j rather than defaulting it", (value) => {
    expect(() => parseNotebookParameterInput("number", value, [])).toThrow();
  });
  it.each([["0", 0], ["-0.25", -0.25], [".5", 0.5], ["1e3", 1000], [" 12 ", 12]] as const)("accepts decimal input %s", (value, expected) => {
    expect(parseNotebookParameterInput("number", value, [])).toEqual({ type: "number", value: expected });
  });
  it("validates calendar dates without timezone conversion", () => {
    expect(parseNotebookParameterInput("date", "2024-02-29", [])).toEqual({ type: "date", value: "2024-02-29" });
    for (const value of ["", "2025-02-29", "2026-13-01", "2026-09-17T00:00:00Z"]) expect(() => parseNotebookParameterInput("date", value, [])).toThrow("有效日期");
  });
  it("preserves ordered option values and rejects duplicates, empty entries and missing selections", () => {
    expect(parseNotebookParameterInput("select", "South", ["East", "South"])).toEqual({ type: "select", options: ["East", "South"], value: "South" });
    for (const options of [[], ["East", "East"], ["East", ""], ["East", " ", "South"], ["South"]]) {
      expect(() => parseNotebookParameterInput("select", "East", options)).toThrow("选项");
    }
    expect(() => parseNotebookParameterInput("select", "missing", ["East", "South"])).toThrow("选项");
  });
  it("round-trips whitespace and multiline choices without splitting or mutating them", () => {
    const options = [" East ", "line 1\nline 2", "Other"];
    const before = [...options];
    const parameter = parseNotebookParameterInput("select", options[1], options);
    expect(parameter).toEqual({ type: "select", value: "line 1\nline 2", options: before });
    expect(options).toEqual(before);
    const html = renderToStaticMarkup(<NotebookParameterEditor cell={cell(parameter)} disabled={false} onSave={() => {}} onCancel={() => {}} />);
    expect(html.match(/<textarea /gu)).toHaveLength(3);
    expect(html).toContain(" East </textarea>");
    expect(html).toContain("line 1\nline 2</textarea>");
    expect(html).toContain('aria-label="移除选项 1"');
    expect(html).toContain("添加选项");
  });
  it("keeps form constraints and error messages independent of entered values", () => {
    expect(() => parseNotebookParameterInput("text", "s".repeat(2001), [])).toThrow("2,000");
    expect(() => parseNotebookParameterInput("select", "secret-marker", ["allowed"])).toThrow("参数值必须属于选项");
    try { parseNotebookParameterInput("select", "secret-marker", ["allowed"]); } catch (error) { expect(String(error)).not.toContain("secret-marker"); }
  });
  it.each([
    { type: "text", value: "quoted <script>" },
    { type: "number", value: 5 },
    { type: "date", value: "2026-09-17" },
    { type: "select", options: ["East", "South"], value: "South" },
  ] satisfies NotebookParameter[])("renders accessible %s controls and explicit manual-run/privacy guidance", (parameter) => {
    const html = renderToStaticMarkup(<NotebookParameterEditor cell={cell(parameter)} disabled={false} onSave={() => {}} onCancel={() => {}} />);
    expect(html).toContain('aria-label="参数类型"');
    expect(html).toContain('aria-label="参数值"');
    expect(html).toContain("保存单元");
    expect(html).toContain("取消编辑");
    expect(html).toContain("默认手动运行，仅显式开启参数自动重算后");
    expect(html).toContain("保存值变更才触发相关步骤；不向数据库 SQL 插入值");
    expect(html).toContain("请勿填写密码、API Key");
    expect(html).toContain("Python 已转换为日期列");
    expect(html).toContain("与带时区数据比较时请显式统一时区");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain('disabled=""');
    if (parameter.type === "select") expect(html).toContain('aria-label="单选选项 1"');
    if (parameter.type === "number") expect(html).toContain('inputMode="decimal"');
    if (parameter.type === "date") expect(html).toContain('type="date"');
  });
  it("routes the canonical editor to the parameter form and applies its disabled boundary", () => {
    const html = renderToStaticMarkup(<NotebookCellEditor cell={cell({ type: "number", value: 5 })} availableInputs={[]} sources={[]} models={[]} disabled onSave={() => {}} onCancel={() => {}} />);
    expect(html).toContain('aria-label="参数类型"');
    expect(html).toContain('<fieldset disabled="">');
    expect(html).toContain('class="notebook-primary" disabled=""');
    expect(html).not.toContain("输入表（勾选后才能在 SQL 中查询）");
  });
  it("shows saved type/value safely and keeps full configuration in source and review", () => {
    const parameter: NotebookParameter = { type: "text", value: "<script>\n" + "x".repeat(200) };
    const html = renderToStaticMarkup(<NotebookParameterSummary parameter={parameter} />);
    expect(html).toContain("文本 · 当前值");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("…");
    expect(html).not.toContain("x".repeat(200));
    expect(JSON.parse(cellSource(cell(parameter)).value)).toEqual({ outputName: "threshold", parameter });
    expect(JSON.parse(cellReviewSource(cell(parameter)))).toEqual(cell(parameter));
  });
});
