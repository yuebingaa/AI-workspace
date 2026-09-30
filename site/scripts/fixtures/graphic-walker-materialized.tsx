// Isolated feasibility experiment, not a product route or persisted V2 contract.
import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { PureRenderer, normalize, getComputation, type IDataQueryPayload, type IMutField, type IRow, type TerseSpec } from "@kanaries/graphic-walker";

const scenarios = ["series", "facets", "rank", "input-order", "duplicate", "dates-null"] as const;
type Scenario = typeof scenarios[number];
declare global { interface Window { gwGate: { scenario: string; inputs: IRow[]; queries: IDataQueryPayload[]; outputs: IRow[][]; errors: string[] }; } }
function experiment(scenario: Scenario) {
  const numeric = (fid: string, name: string): IMutField => ({ fid, name, analyticType: "measure", semanticType: "quantitative" });
  const dimension = (fid: string, name: string): IMutField => ({ fid, name, analyticType: "dimension", semanticType: "nominal" });
  let fields = [dimension("quarter", "季度"), dimension("segment", "客户类型"), dimension("region", "地区"), dimension("market", "渠道"), numeric("amount", "成交金额")];
  let inputs: IRow[] = [
    { quarter: "2024 Q1", segment: "企业", region: "东区", amount: 150 }, { quarter: "2024 Q1", segment: "个人", region: "东区", amount: 80 },
    { quarter: "2024 Q2", segment: "企业", region: "东区", amount: 300 }, { quarter: "2024 Q2", segment: "个人", region: "东区", amount: 160 },
    { quarter: "2024 Q1", segment: "企业", region: "西区", amount: 120 }, { quarter: "2024 Q1", segment: "个人", region: "西区", amount: 70 },
    { quarter: "2024 Q2", segment: "企业", region: "西区", amount: 180 }, { quarter: "2024 Q2", segment: "个人", region: "西区", amount: 90 },
  ];
  let spec: TerseSpec = { mark: "area", x: "fid:quarter", y: "fid:amount", color: "fid:segment", aggregate: false, stack: "stack",
    config: { timezoneDisplayOffset: 0 }, layout: { useSvg: true, showActions: false, interactiveScale: false } };
  if (scenario === "series") inputs = inputs.filter(row => row.region === "东区");
  if (scenario === "facets") {
    inputs = inputs.flatMap(row => [{ ...row, market: "直销" }, { ...row, market: "伙伴", amount: Number(row.amount) * 2 }]);
    spec = { ...spec, x: ["fid:market", "fid:quarter"], y: ["fid:region", "fid:amount"] };
  }
  if (scenario === "rank" || scenario === "input-order" || scenario === "duplicate") {
    fields = [dimension("category", "项目"), numeric("amount", "数值")];
    inputs = scenario === "duplicate" ? [{ category: "重复分类", amount: 10 }, { category: "重复分类", amount: 20 }]
      : [{ category: "Z 项", amount: 30 }, { category: "A 项", amount: 12 }, { category: "M 项", amount: 21 }];
    spec = { ...spec, mark: scenario === "duplicate" ? "point" : "bar", x: "fid:category", color: undefined, stack: "none", ...(scenario === "rank" ? { sort: "descending" } : {}) };
  }
  if (scenario === "dates-null") {
    fields = [{ fid: "date", name: "日期", analyticType: "dimension", semanticType: "temporal", offset: 0 }, numeric("amount", "数值")];
    inputs = [{ date: "2024-01-01", amount: 0 }, { date: "2024-04-01", amount: null }, { date: "2024-07-01", amount: -5 }, { date: "2024-10-01", amount: 10 }];
    spec = { ...spec, mark: "line", x: "fid:date", color: undefined, stack: "none" };
  }
  const chart = normalize(spec, fields);
  if (scenario === "rank") {
    // TerseSpec.sort targets the last Y measure in 0.5.2. Rank the categorical
    // X channel explicitly through the public canonical encoding instead.
    chart.encodings.rows = chart.encodings.rows.map(field => ({ ...field, sort: "none" }));
    chart.encodings.columns = chart.encodings.columns.map(field => ({ ...field, sort: "descending" }));
  }
  if (scenario === "input-order") {
    // Public canonical encoding, not a private Vega View/DOM patch.
    chart.encodings.columns = chart.encodings.columns.map(field => ({ ...field, sort: "none" }));
  }
  return { inputs, chart };
}

function App() {
  const [scenario, setScenario] = useState<Scenario>("series");
  const { chart, scales, computation, evidence } = useMemo(() => {
    const { inputs, chart } = experiment(scenario), compute = getComputation(inputs);
    const evidence = { scenario, inputs, queries: [] as IDataQueryPayload[], outputs: [] as IRow[][], errors: [] as string[] };
    // `sort: none` alone still defaults to lexical category order. The public
    // scale domain preserves the explicit materialized order without mutation.
    const scales = scenario === "input-order" ? { column: { domain: inputs.map(row => String(row.category)) } } : undefined;
    return { chart, scales, evidence, computation: async (payload: IDataQueryPayload) => {
      evidence.queries.push(payload);
      // Assert on the actual emitted workflow, not aggregate:false alone.
      if (payload.workflow.some(step => step.type === "view" && step.query.some(query => query.op === "aggregate"))) {
        evidence.errors.push("unexpected business aggregation"); throw Error("No business aggregation allowed");
      }
      const rows = await compute(payload); evidence.outputs.push(rows); return rows;
    } };
  }, [scenario]);
  useEffect(() => { window.gwGate = evidence; }, [evidence]);
  return <main style={{ padding: 24, fontFamily: "Arial, Microsoft YaHei, sans-serif" }}>
    <h1>Graphic Walker 已计算结果适配试验（模拟数据）</h1>
    <p>隔离验证页面，不是正式 Notebook / V2 功能；记录实际计算请求，禁止再次业务聚合。</p>
    <label>场景 <select aria-label="适配场景" value={scenario} onChange={event => setScenario(event.target.value as Scenario)}>{scenarios.map(name => <option key={name}>{name}</option>)}</select></label>
    <section key={scenario} aria-label="适配画布" style={{ marginTop: 24 }}>
      <PureRenderer type="remote" computation={computation} visualState={chart.encodings} visualConfig={chart.config} visualLayout={chart.layout} scales={scales}
        appearance="light" locale="zh-CN" disableCollapse overrideSize={{ mode: scenario === "facets" ? "auto" : "fixed", width: 1000, height: 450 }} />
    </section>
  </main>;
}
createRoot(document.getElementById("root")!).render(<App />);
