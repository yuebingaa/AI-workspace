import { expect, it } from "vitest";
import type { IDataQueryPayload } from "@kanaries/graphic-walker";
import { assertMaterializedWorkflow } from "./materialized-workflow";
it("allows real GW raw projection including duplicate requested fields", () => {
  expect(() => assertMaterializedWorkflow({ workflow: [{ type: "view", query: [{ op: "raw", fields: ["x", "y", "x"] }] }] })).not.toThrow();
});
it.each([
  { workflow: [{ type: "view", query: [{ op: "aggregate", groupBy: [], measures: [] }] }] },
  { workflow: [{ type: "filter", filters: [] }] }, { workflow: [{ type: "transform", transform: [] }] },
  { workflow: [{ type: "sort", by: [], sort: "ascending" }] }, { workflow: [], limit: 10 }, { workflow: [], offset: 1 },
])("rejects re-computation/slicing %#", payload => {
  expect(() => assertMaterializedWorkflow(payload as IDataQueryPayload)).toThrow(/重新计算/);
});
