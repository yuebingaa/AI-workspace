import type { IDataQueryPayload } from "@kanaries/graphic-walker";

/** Only raw projection: never change already materialized business values. */
export function assertMaterializedWorkflow(payload: IDataQueryPayload): void {
  if (payload.limit !== undefined || payload.offset !== undefined || payload.workflow.some(step => step.type !== "view"
    || step.query.some(query => query.op !== "raw"))) throw Error("渲染器尝试重新计算正式图表结果，已拒绝。");
}
