import { afterEach, describe, expect, it, vi } from "vitest";
import { demoFixtureResult } from "@/fixtures/demo-product";
import { HarnessRuntime } from "@/core/harness/runtime";
import { harnessResponseSchema, type HarnessModel } from "@/core/harness/contracts";
import { readHarnessStream } from "@/core/harness/stream";
import { POST } from "./route";
import { POST as streamPOST } from "./stream/route";

describe("Notebook trial evidence through the existing JSON/SSE APIs", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

  it.each(["json", "sse"] as const)("%s accepts an actual run, but not a success receipt for the wrong cell set", async (transport) => {
    if (!demoFixtureResult.success) throw new Error("Synthetic demo unavailable");
    vi.stubEnv("HARNESS_MCP_ENABLED", "false");
    vi.stubEnv("HARNESS_MULTI_AGENT_MODE", "single");
    vi.stubEnv("DEEPSEEK_API_KEY", "synthetic-trial-key");
    const network = vi.fn<typeof fetch>(async () => { throw new Error("No provider requests are allowed"); });
    vi.stubGlobal("fetch", network);
    const rawRuntime = HarnessRuntime.prototype.run;
    let rejectReceipt = false;
    let actualExecutions = 0;
    const dataCell = { id: "trial_data", kind: "data", title: "合成来源", sourceDataSourceId: "dataset_retail_orders", outputName: "trial_input" };
    const sqlCell = { id: "trial_sql", kind: "sql", title: "合成计算", inputCellIds: [dataCell.id], outputName: "trial_result",
      sql: "SELECT 1 AS value FROM trial_input LIMIT 1" };
    const tableCell = { id: "trial_table", kind: "table", title: "合成结果", inputCellId: sqlCell.id, columns: ["value"] };
    vi.spyOn(HarnessRuntime.prototype, "run").mockImplementation((raw, options) => {
      let planId: string | undefined;
      const model: HarnessModel = { next: async ({ iteration, context }) => {
        if (iteration === 2) {
          const latest = context.latestObservation as { result?: { analysisPlanArtifactId?: unknown } } | undefined;
          if (typeof latest?.result?.analysisPlanArtifactId !== "string") throw new Error(`Missing scripted plan: ${JSON.stringify(latest)}`);
          planId = latest.result.analysisPlanArtifactId;
        }
        return { model: "scripted-trial-verification", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          turn: iteration === 1 ? { type: "callTool", name: "createAnalysisPlan", toolCallId: "trial_plan", message: "规划合成测试", arguments: {
            name: "合成试运行计划", objective: "验证执行回执", questions: ["是否得到一行结果？"], deliverables: ["table"], steps: [
              { id: dataCell.id, kind: "data", title: dataCell.title, objective: "读取授权来源", dependsOn: [], sourceDataSourceId: dataCell.sourceDataSourceId },
              { id: sqlCell.id, kind: "sql", title: sqlCell.title, objective: "生成一行数值", dependsOn: [dataCell.id], transformation: "读取数据并输出一行value为1" },
              { id: tableCell.id, kind: "table", title: tableCell.title, objective: "展示已计算结果", dependsOn: [sqlCell.id], columns: ["value"] },
            ],
          } } : { type: "callTool", name: "createNotebookDraft", toolCallId: `trial_draft_${iteration}`, message: "创建并验证草稿",
            arguments: { name: "合成试运行草稿", analysisPlanId: planId, cells: [dataCell, sqlCell, tableCell] } } };
      } };
      const runner = options.notebookRunner;
      if (!runner) throw new Error("API did not compose the real Notebook runner");
      return rawRuntime.call(new HarnessRuntime(), raw, { ...options, modelClient: model, allowFailureExplanation: false,
        bounds: { ...options.bounds, maxToolCalls: 2 }, notebookRunner: async (artifact, context) => {
          const run = await runner(artifact, context);
          expect(run.status).toBe("success");
          expect(run.cells[1].table?.rows).toEqual([{ value: 1 }]);
          actualExecutions++;
          return rejectReceipt ? { ...run, cells: [], notice: "PRIVATE_SYNTHETIC_WRONG_RECEIPT" } : run;
        } });
    });
    for (const mismatch of [false, true]) {
      rejectReceipt = mismatch;
      const response = await (transport === "sse" ? streamPOST : POST)(new Request(`http://127.0.0.1:3001/api/ai/harness${transport === "sse" ? "/stream" : ""}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
          idempotencyKey: `trial_${transport}_${mismatch}`, instruction: "根据当前数据创建分析文档并汇总结果", pageId: "page_home",
          dataSourceId: "dataset_retail_orders", appSpec: demoFixtureResult.data.dataProduct.appSpec, recipes: [],
          notebookContext: { sourceIds: ["dataset_retail_orders"], document: { name: "合成文档", revision: 4, cells: [] } },
        }),
      }));
      expect(response.status, response.status === 200 ? undefined : await response.text()).toBe(200);
      const body = harnessResponseSchema.parse(transport === "sse"
        ? await readHarnessStream(response, new AbortController().signal) : await response.json());
      expect(body.task.pendingChangeSet).toBeUndefined();
      expect(body.task.trace?.filter((event) => event.type === "completed")).toHaveLength(1);
      if (mismatch) {
        expect(body.task.state).toBe("failed");
        expect(body.task.notebookArtifact).toBeUndefined();
        expect(body.task.notebookDiagnostics).toMatchObject({ status: "unavailable", cells: [
          { cellId: dataCell.id, status: "unknown" }, { cellId: sqlCell.id, status: "unknown" }, { cellId: tableCell.id, status: "unknown" },
        ] });
        expect(body.task.notebookDiagnostics?.runId).toBeUndefined();
        expect(JSON.stringify(body)).not.toContain("PRIVATE_SYNTHETIC_WRONG_RECEIPT");
      } else {
        expect(body.task.state, JSON.stringify(body.task.trace?.map((event) => [event.type, event.message]))).toBe("awaitingConfirmation");
        expect(body.task.verification?.status).toBe("passed");
        expect(body.task.notebookArtifact).toMatchObject({ baseRevision: 4, executionEvidence: {
          status: "success", completedCellIds: [dataCell.id, sqlCell.id, tableCell.id],
        } });
      }
    }
    expect(actualExecutions).toBe(2);
    expect(network).not.toHaveBeenCalled();
  }, 30_000);
});
