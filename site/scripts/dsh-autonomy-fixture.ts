import assert from "node:assert/strict";
import { harnessPublicRequestSchema, harnessRequestSchema } from "@/core/harness/contracts";
import { createHarnessStreamResponse, readHarnessStream } from "@/core/harness/stream";
import { runDshEngine } from "@/core/agent-engines/server/dsh-engine";
import { runNotebook } from "@/core/notebook/server/runtime";

/** Fixed model driver, real engine/bridge/SQL/SSE; never a provider or external database. */
export async function createAutonomyFixture(payload: unknown) {
  const input = harnessPublicRequestSchema.parse(payload);
  const request = harnessRequestSchema.parse({ ...input, role: "editor", recipes: [] });
  const source = request.appSpec.dataSources.find(candidate => candidate.id === request.dataSourceId);
  assert.ok(source && source.name.includes("dsh-autonomy-synthetic"));
  assert.deepEqual(source.fields.map(field => field.name), ["region", "amount"]);
  assert.equal(request.notebookContext?.document.cells.length, 1);
  const data = request.notebookContext.document.cells[0]; assert.ok(data.kind === "data");
  assert.match(data.outputName, /^[A-Za-z_][A-Za-z0-9_]*$/u);
  const before = structuredClone(request), controller = new AbortController();
  const rows = [{ region: "East", amount: 100 }, { region: "East", amount: 50 }, { region: "South", amount: 80 }];
  const response = createHarnessStreamResponse(controller.signal, (signal, onEvent) => runDshEngine(request, {
    signal, onEvent, dataRuntime: { rowsByDataSourceId: { [source.id]: rows } }, authorizeCurrentAccess() {},
    notebookRunner: (artifact, execution) => runNotebook({
      document: { name: artifact.name, revision: artifact.baseRevision ?? 0, cells: artifact.cells },
      sources: [{ source, rows }], forAi: true, signal: execution.signal, log() {},
    }),
    driver: async driver => {
      async function call(name: string, args: unknown) {
        const tool = driver.tools.find(candidate => candidate.name === name); assert.ok(tool);
        driver.onModelCall(); return tool.execute(args, driver.signal);
      }
      await call("cellSearch", {});
      await call("editNotebookCells", { editVersion: 0, cells: [
        { id: "autonomy_totals", kind: "sql", title: "地区销售汇总", inputCellIds: [data.id], outputName: "regional_totals",
          sql: `SELECT region, SUM(amount)::DOUBLE AS revenue FROM ${data.outputName} GROUP BY region ORDER BY region` },
        { id: "autonomy_table", kind: "table", title: "地区销售表", inputCellId: "autonomy_totals", columns: ["region", "revenue"] },
        { id: "autonomy_chart", kind: "chart", title: "地区销售柱状图", inputCellId: "autonomy_totals", chartType: "bar", categoryField: "region", valueFields: ["revenue"] },
      ] });
      const run = await call("runNotebookCells", { editVersion: 1 });
      assert.match(JSON.stringify(run.data), /"revenue":150/u); assert.match(JSON.stringify(run.data), /"revenue":80/u);
      await call("submitNotebookDraft", { editVersion: 1 });
      return { finalResponse: "离线模型替身验收：按地区汇总，East 销售额150，South销售额80，合计230。仅有三行合成记录，没有时间和产品维度，不能据此判断趋势或业务原因。草稿尚未保存到正式文档。", model: "offline-fixed-driver" };
    },
  }));
  const body = await response.text();
  const { task } = await readHarnessStream(new Response(body, { headers: response.headers }), controller.signal);
  assert.equal(task.state, "awaitingConfirmation"); assert.equal(task.notebookArtifact?.executionEvidence?.status, "success");
  assert.match(task.resultMessage ?? "", /AI 分析说明/u); assert.deepEqual(request, before);
  return { body, task, evidence: { actualEngine: true, actualBridge: true, actualNotebookSql: true, actualSse: true,
    fixedModelDriver: true, publicHandler: false, officialSdk: false, paidModel: false, externalDatabase: false } };
}
