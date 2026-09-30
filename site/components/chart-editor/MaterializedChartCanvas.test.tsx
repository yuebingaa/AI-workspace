// @vitest-environment happy-dom
import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { MaterializedChartCanvas } from "./MaterializedChartCanvas";
import { definition } from "@/core/visualization/test-fixture";
import type { MaterializedVisualization } from "@/core/visualization/result";

const calls = vi.hoisted(() => ({ resolve: [] as (() => void)[] }));
vi.mock("@kanaries/graphic-walker", () => ({
  getComputation: () => () => new Promise<[]>(resolve => { calls.resolve.push(() => resolve([])); }),
  PureRenderer: ({ computation }: { computation: (payload: unknown) => Promise<unknown> }) => {
    useEffect(() => { void computation({ workflow: [{ type: "view", query: [{ op: "raw", fields: ["quarter", "amount"] }] }] }); }, [computation]);
    return <div>mock renderer lifecycle only</div>;
  },
}));
vi.mock("@/core/visualization/adapters/graphic-walker", () => ({
  assertMaterializedWorkflow: () => {},
  materializedGraphicWalker: () => ({ chart: { encodings: {}, config: {}, layout: {} }, scales: {}, grid: { columns: 2, rows: 2, enabled: true }, theme: { light: {}, dark: {} } }),
}));
vi.mock("./ChartImageExport", () => ({ ChartImageExport: () => null }));

let resize: (entries: { contentRect: { width: number; height: number } }[]) => void;
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
vi.stubGlobal("ResizeObserver", class {
  constructor(callback: typeof resize) { resize = callback; }
  observe() {} disconnect() {}
});
const host = document.createElement("div"); document.body.appendChild(host);
let root = createRoot(host);
afterEach(async () => { await act(async () => root.unmount()); root = createRoot(host); calls.resolve.length = 0; });
// This boundary receives already verified results; only lifecycle ordering is mocked here.
const result = (id: string) => ({ table: { fields: [], rows: [{ amount: 3 }], truncated: false }, visualResult: { tableHash: id, runId: id, inputRowCount: 2, outputRowCount: 1 } }) as unknown as MaterializedVisualization;
const d = definition();
it("a late pre-resize projection cannot leave a successfully rendered facet chart loading", async () => {
  await act(async () => root.render(<MaterializedChartCanvas definition={d} result={result("a")} />));
  expect(calls.resolve).toHaveLength(1);
  await act(async () => resize([{ contentRect: { width: 1000, height: 700 } }]));
  expect(calls.resolve).toHaveLength(2);
  await act(async () => calls.resolve[1]()); expect(host.querySelector("section")?.dataset.state).toBe("ready");
  await act(async () => calls.resolve[0]()); expect(host.querySelector("section")?.dataset.state).toBe("ready");
});
it("a stale preceding data result cannot mark a new result as ready", async () => {
  await act(async () => root.render(<MaterializedChartCanvas definition={d} result={result("a")} />));
  await act(async () => root.render(<MaterializedChartCanvas definition={d} result={result("b")} />));
  await act(async () => calls.resolve[0]()); expect(host.querySelector("section")?.dataset.state).toBe("loading");
  await act(async () => calls.resolve[1]()); expect(host.querySelector("section")?.dataset.state).toBe("ready");
});
