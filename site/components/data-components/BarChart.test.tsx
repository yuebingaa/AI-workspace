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

    expect(html).toContain('data-chart-engine="recharts"');
    expect(html).toContain('data-has-negative="true"');
    expect(html).toContain('data-has-positive="true"');
    expect(html).toContain("区域甲：-10");
    expect(html).toContain("区域丙：20");
  });

  it("使用受控颜色令牌切换柱形配色", () => {
    const html = renderToStaticMarkup(<BarChart
      title="各线体异常次数"
      subtitle="按次数降序"
      color="blue"
      labels={["A5FSL06"]}
      values={[72]}
      yAxis={["72", "0"]}
      domain={{ minimum: 0, maximum: 72 }}
    />);

    expect(html).toContain('data-chart-color="blue"');
    expect(html).toContain("--chart-bar-color:#85b8ee");
    expect(html).toContain("--chart-bar-focus-color:#2563eb");
  });

  it("按配置在柱形顶部显示格式化数值", () => {
    const html = renderToStaticMarkup(<BarChart
      title="各线体异常次数"
      subtitle="按次数降序"
      showValues
      labels={["A5FSL06", "A5FSL01"]}
      values={[72, 59.25]}
      yAxis={["72", "0"]}
      domain={{ minimum: 0, maximum: 72 }}
    />);

    expect(html).toContain('data-show-values="true"');
    expect(html).toContain("A5FSL06：72");
    expect(html).toContain("A5FSL01：59.25");
  });

  it.each([
    ["line", "curve-chart recharts-curve-chart line"],
    ["area", "curve-chart recharts-curve-chart area"],
    ["pie", "radial-plot"],
    ["donut", "radial-plot donut"],
  ] as const)("渲染受控的 %s 图表类型", (chartType, expectedClass) => {
    const html = renderToStaticMarkup(<BarChart
      title="异常类型占比"
      subtitle="按异常次数汇总"
      chartType={chartType}
      labels={["报警甲", "报警乙", "报警丙"]}
      values={[50, 30, 20]}
      yAxis={["50", "25", "0"]}
      domain={{ minimum: 0, maximum: 50 }}
    />);

    expect(html).toContain(`data-chart-type="${chartType}"`);
    expect(html).toContain(`class="${expectedClass}"`);
    expect(html).toContain("报警甲");
  });

  it("饼图图例显示真实分类占比且可选显示原始值", () => {
    const html = renderToStaticMarkup(<BarChart
      title="异常类型占比"
      subtitle="按异常次数汇总"
      chartType="pie"
      showValues
      labels={["报警甲", "报警乙"]}
      values={[75, 25]}
      yAxis={["75", "0"]}
      domain={{ minimum: 0, maximum: 75 }}
    />);

    expect(html).toContain("75.0% · 75");
    expect(html).toContain("25.0% · 25");
    expect(html).toContain('data-recharts-engine="true"');
  });

  it("密集长分类柱图限制在内部滚动并自动使用竖排标签", () => {
    const labels = Array.from({ length: 14 }, (_, index) => `第${index + 1}类很长的异常类型名称`);
    const html = renderToStaticMarkup(<BarChart
      title="A5FNL01 异常类型分布"
      subtitle="14 类异常"
      labels={labels}
      values={labels.map((_, index) => 14 - index)}
      yAxis={["14", "7", "0"]}
      domain={{ minimum: 0, maximum: 14 }}
    />);

    expect(html).toContain('aria-label="柱状图横向滚动区域"');
    expect(html).toContain('class="chart vertical-labels"');
    expect(html).toContain('class="bars-scroll vertical-labels"');
    expect(html).toContain("min-width:840px");
    expect(html).toContain("--bar-slot-width:60px");
  });

  it("柱子数量增加时自动缩小单柱槽位", () => {
    const labels = Array.from({ length: 10 }, (_, index) => `A5FSL${index}`);
    const html = renderToStaticMarkup(<BarChart
      title="各线体异常次数"
      subtitle="10 条线体"
      labels={labels}
      values={labels.map((_, index) => 10 - index)}
      yAxis={["10", "5", "0"]}
      domain={{ minimum: 0, maximum: 10 }}
    />);

    expect(html).toContain('class="recharts-bar-plot dense"');
    expect(html).toContain("--bar-slot-width:70px");
  });
});
