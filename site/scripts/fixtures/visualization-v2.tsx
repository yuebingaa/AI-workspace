// Isolated B1 verification only, not a product route or Notebook editor.
import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { PureRenderer, getComputation, type IDataQueryPayload, type IRow } from "@kanaries/graphic-walker";
import { materializedGraphicWalker, assertMaterializedWorkflow } from "@/core/visualization/adapters/graphic-walker";
import { parseMaterializedVisualization, type MaterializedVisualization } from "@/core/visualization/result";
import type { ChartDefinitionV2 } from "@/core/visualization/definition";

const cases = ["series", "series-warm", "raw-order", "filtered", "rank", "empty", "stale"];
type Fixture = { definition: ChartDefinitionV2; result: MaterializedVisualization };
type Evidence = { scenario: string; queries: IDataQueryPayload[]; outputs: IRow[][]; status: string; error?: string };
declare global { interface Window { visualizationV2: Evidence; } }
const inputCounts: Record<string, number> = { series: 6, "raw-order": 4, filtered: 4, rank: 5, empty: 6 };
const fixtures: Promise<Record<string, Fixture>> = fetch("results.json").then(response => response.json());

function Plot({ fixture, scenario }: { fixture: Fixture; scenario: string }) {
  const adapter = useMemo(() => materializedGraphicWalker(fixture.definition, fixture.result.table), [fixture]);
  const compute = useMemo(() => {
    const raw = getComputation(fixture.result.table.rows);
    return async (payload: IDataQueryPayload) => {
      const evidence = window.visualizationV2;
      if (evidence.scenario !== scenario) throw Error("Stale fixture render");
      evidence.queries.push(payload);
      try { assertMaterializedWorkflow(payload); const rows = await raw(payload); evidence.outputs.push(rows); evidence.status = "ready"; return rows; }
      catch (error) { evidence.error = String(error); evidence.status = "error"; throw error; }
    };
  }, [fixture, scenario]);
  return <section aria-label="V2 画布">
    <h2>{adapter.title}</h2>
    <PureRenderer type="remote" computation={compute} visualState={adapter.chart.encodings} visualConfig={adapter.chart.config}
      visualLayout={adapter.chart.layout} scales={adapter.scales} vizThemeConfig={adapter.theme} name={adapter.title}
      appearance="light" locale="zh-CN" disableCollapse overrideSize={{ mode: "fixed", width: 1030, height: 430 }} />
    <p>完整上游 {fixture.result.visualResult.inputRowCount} 行 → 图表结果 {fixture.result.table.rows.length} 行；浏览器只允许 raw 投影。</p>
    <table aria-label="正式计算结果"><thead><tr>{fixture.result.table.fields.map(field => <th key={field.name}>{field.label}</th>)}</tr></thead>
      <tbody>{fixture.result.table.rows.map((row, index) => <tr key={index}>{fixture.result.table.fields.map(field => <td key={field.name}>{String(row[field.name] ?? "（空值）")}</td>)}</tr>)}</tbody></table>
  </section>;
}

function App() {
  const [scenario, setScenario] = useState("series");
  const [state, setState] = useState<{ fixture?: Fixture; evidence: Evidence }>({ evidence: { scenario: "", queries: [], outputs: [], status: "loading" } });
  useEffect(() => {
    let active = true;
    const evidence: Evidence = { scenario, queries: [], outputs: [], status: "loading" }; window.visualizationV2 = evidence;
    async function load() {
      try {
        const name = ["series-warm", "stale"].includes(scenario) ? "series" : scenario;
        const fixture = structuredClone((await fixtures)[name]);
        if (scenario === "series-warm") { fixture.definition.presentation.palette = "warm"; fixture.definition.presentation.grid = false; fixture.definition.presentation.legend = false; }
        await parseMaterializedVisualization(fixture.result, fixture.definition, { runId: "synthetic-run", revision: scenario === "stale" ? 8 : 7,
          accessMode: "user", inputResultId: "synthetic-run:sales", inputRowCount: inputCounts[name] });
        if (active) { if (!fixture.result.table.rows.length) evidence.status = "empty"; setState({ fixture, evidence }); }
      } catch (error) { if (active) { evidence.status = "error"; evidence.error = String(error); setState({ evidence }); } }
    }
    void load(); return () => { active = false; };
  }, [scenario]);
  const current = state.evidence.scenario === scenario;
  return <main>
    <h1>V2 图表计算与绘制 · 隔离验证</h1><p>模拟数据；真实 DuckDB 计算结果。不是正式 Notebook 页面，未开启保存或 AI 入口。</p>
    <label>验证场景 <select aria-label="验证场景" value={scenario} onChange={event => setScenario(event.target.value)}>{cases.map(name => <option key={name}>{name}</option>)}</select></label>
    {!current ? <p role="status">正在读取并核对结果…</p> : state.evidence.error ? <p role="alert">{state.evidence.error}</p>
      : state.fixture?.result.table.rows.length === 0 ? <p role="status">没有符合筛选条件的数据，正式结果为空；不会沿用上一张图。</p>
        : state.fixture ? <Plot key={scenario} fixture={state.fixture} scenario={scenario} /> : <p role="status">正在核对结果…</p>}
  </main>;
}
createRoot(document.getElementById("root")!).render(<App />);
