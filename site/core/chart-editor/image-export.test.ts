import { describe, expect, it } from "vitest";
import { chartImageFiles } from "./image-export";

describe("Graphic Walker image export boundary", () => {
  it("preserves Chinese names, MIME and SVG output with safe filenames", () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>成交金额</text></svg>';
    expect(chartImageFiles("svg", [svg], '季度/销售:"图表"?')).toEqual([{ name: "季度销售图表.svg", mime: "image/svg+xml;charset=utf-8", content: svg }]);
    expect(chartImageFiles("svg", [svg, svg], "CON").map(file => file.name)).toEqual(["图表-1.svg", "图表-2.svg"]);
  });
  it("decodes only PNG data URLs without fetching a remote resource", () => {
    const result = chartImageFiles("png", ["data:image/png;base64,iVBORw0KGgo="], "图表")[0];
    expect(result.mime).toBe("image/png");
    expect(Array.from(result.content as Uint8Array)).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(() => chartImageFiles("png", ["https://invalid/chart.png"], "")).toThrow("有效的 PNG");
  });
  it("fails before downloading any files when output is empty or malformed", () => {
    expect(() => chartImageFiles("svg", [], "")).toThrow("尚未完成");
    expect(() => chartImageFiles("svg", ["<html></html>"], "")).toThrow("有效的 SVG");
    expect(() => chartImageFiles("png", ["data:image/png;base64,YmFk"], "")).toThrow("不完整");
  });
});
