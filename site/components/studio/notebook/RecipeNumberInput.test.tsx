import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { RecipeNumberInput, parseRecipeNumberInput } from "./RecipeNumberInput";
import { RecipeStepsEditor } from "./RecipeStepsEditor";
import type { DataRecipeStep } from "@/core/models";

describe("配方数字输入解析", () => {
  it.each([
    ["0", 0], ["-0", -0], ["+0", 0], ["5", 5], ["-12", -12],
    ["0.25", 0.25], [".5", 0.5], ["-.5", -0.5], ["1.", 1],
    ["1e3", 1000], ["-2.5e-2", -0.025], ["1E+2", 100], [" 12.5 ", 12.5],
    ["9007199254740992", 9007199254740992], [String(Number.MAX_VALUE), Number.MAX_VALUE],
  ])("保留合法十进制或指数 %s", (raw, expected) => {
    expect(parseRecipeNumberInput(String(raw))).toBe(expected);
  });

  it.each([
    "", " ", "\t\n", "+", "-", ".", "-.", "1e", "1e+", "1e-", "e2",
    "NaN", "Infinity", "-Infinity", "0x10", "0b10", "0o10", "1_000",
    "1,000", "12px", "1 2", "1.2.3", "1e309", "-1e309",
  ])("拒绝空值或未完成数字 %j，不补成零", (raw) => {
    expect(parseRecipeNumberInput(raw)).toBeNull();
  });
});

describe("配方数字控件与接线", () => {
  it("标记必填数字控件并保留零，不在渲染时修改上层草稿", () => {
    const onChange = vi.fn();
    const html = renderToStaticMarkup(<RecipeNumberInput value={0} label="筛选值" onChange={onChange} />);
    expect(html).toContain('type="number"');
    expect(html).toContain('aria-label="筛选值"');
    expect(html).toContain("data-recipe-number");
    expect(html).toContain('required=""');
    expect(html).toContain('step="any"');
    expect(html).toContain('value="0"');
    expect(html).not.toContain('role="alert"');
    expect(onChange).not.toHaveBeenCalled();
  });

  it("整数行数沿用已有上下界", () => {
    const html = renderToStaticMarkup(<RecipeNumberInput value={100} label="行数" min={1} max={10_000} integer onChange={() => {}} />);
    expect(html).toContain('min="1"');
    expect(html).toContain('max="10000"');
    expect(html).toContain('step="1"');
    expect(html).toContain('value="100"');
  });

  it.each([0, -1, 1.5, 10_001])("行数 %s 显示关联错误且不替用户补值", (value) => {
    const onChange = vi.fn();
    const html = renderToStaticMarkup(<RecipeNumberInput value={value} label="行数" min={1} max={10_000} integer onChange={onChange} />);
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('role="alert"');
    expect(html).toMatch(/aria-describedby="[^"]+"/u);
    expect(html).toContain(`value="${value}"`);
    expect(onChange).not.toHaveBeenCalled();
  });

  it.each([1, 10_000])("行数 %s 在允许边界内不误报错误", (value) => {
    const html = renderToStaticMarkup(<RecipeNumberInput value={value} label="行数" min={1} max={10_000} integer onChange={() => {}} />);
    expect(html).not.toContain('aria-invalid="true"');
    expect(html).not.toContain('role="alert"');
  });

  it("数字筛选、左右常数和行数全部接入同一控件", () => {
    const steps: DataRecipeStep[] = [
      { id: "filter", type: "filter", field: "amount", operator: "greaterThan", value: 5 },
      { id: "derive", type: "deriveField", field: "net", label: "净额", operator: "multiply", left: { kind: "literal", value: -2.5 }, right: { kind: "literal", value: 0 } },
      { id: "limit", type: "limit", count: 100 },
    ];
    const before = structuredClone(steps);
    const onChange = vi.fn();
    const html = renderToStaticMarkup(<RecipeStepsEditor steps={steps} onChange={onChange} />);
    expect(html.match(/data-recipe-number/gu)).toHaveLength(4);
    expect(html.match(/type="number"/gu)).toHaveLength(4);
    expect(html).toContain('aria-label="左侧"');
    expect(html).toContain('aria-label="右侧"');
    expect(html).toContain('value="-2.5"');
    expect(html).toContain('value="0"');
    expect(html).toContain('min="1"');
    expect(steps).toEqual(before);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("文本、布尔筛选与字段操作数不套用数值必填规则", () => {
    const steps: DataRecipeStep[] = [
      { id: "text", type: "filter", field: "name", operator: "equals", value: "" },
      { id: "boolean", type: "filter", field: "enabled", operator: "equals", value: false },
      { id: "derive", type: "deriveField", field: "net", label: "净额", operator: "multiply", left: { kind: "field", field: "amount" }, right: { kind: "field", field: "ratio" } },
    ];
    const html = renderToStaticMarkup(<RecipeStepsEditor steps={steps} onChange={() => {}} />);
    expect(html).not.toContain("data-recipe-number");
    expect(html).not.toContain('type="number"');
    expect(html).toContain('<option value="string" selected="">');
    expect(html).toContain('<option selected="">false</option>');
    expect(html).toContain('value="amount"');
    expect(html).toContain('value="ratio"');
  });
});
