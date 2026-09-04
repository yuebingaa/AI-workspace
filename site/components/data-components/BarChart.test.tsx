import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BarChart } from "./BarChart";

describe("BarChart", () => {
  it("按跨零坐标域分别呈现正负柱", () => {
    const html = renderToStaticMarkup(<BarChart
      title="虚构净变化"
      subtitle="测试数据"
      labels={["区域甲", "区域乙", "区域丙"]}
      values={[-10, 0, 20]}
      yAxis={["20", "12.5", "5", "-2.5", "-10"]}
      domain={{ minimum: -10, maximum: 20 }}
    />);

    expect(html).toContain("negative");
    expect(html).toContain("positive");
    expect(html).toContain("区域甲：-10");
    expect(html).toContain("区域丙：20");
    expect(html).not.toContain("height:-");
  });
});
