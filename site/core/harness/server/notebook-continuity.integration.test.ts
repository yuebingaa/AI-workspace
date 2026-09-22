import { afterEach, describe, expect, it, vi } from "vitest";
import { demoFixtureResult } from "@/fixtures/demo-product";
import { parseCsvUpload } from "@/core/datasets/server/csv-dataset";
import { MemoryDatasetRepository } from "@/core/datasets/server/dataset-repository";
import { adoptNotebookDraft } from "@/core/notebook/client-state";
import type { NotebookCell } from "@/core/notebook/definition";
import type { NotebookDocument, NotebookRun } from "@/core/notebook/contracts";
import { runNotebook } from "@/core/notebook/server/runtime";
import { harnessRequestSchema, type HarnessModel, type HarnessModelInput, type HarnessRequest, type HarnessToolName } from "../contracts";
import { HarnessRuntime } from "../runtime";
import { HarnessConversationStore } from "./conversation-store";

const ownership = { tenantId: "tenant_continuity", ownerId: "owner_continuity" };
const namespace = "owner_continuity:project_synthetic";
const toolOrder: HarnessToolName[] = ["cellSearch", "editNotebookCells", "runNotebookCells", "submitNotebookDraft"];
const originalValues = [{ region: "East", revenue: 150 }, { region: "South", revenue: 80 }];
const doubledValues = [{ region: "East", revenue: 300 }, { region: "South", revenue: 160 }];
const privateEmails = ["csv-one@example.invalid", "csv-two@example.invalid", "csv-three@example.invalid"];
const now = () => new Date("2026-09-21T08:00:00.000Z");

afterEach(() => { vi.unstubAllGlobals(); });

async function fixture() {
  if (!demoFixtureResult.success) throw new Error("Synthetic app fixture unavailable");
  // Same public amounts as the manual CSV acceptance, plus synthetic sensitive
  // values so this path must obtain consent instead of inventing an authorized source.
  const csv = `region,amount,email\nEast,100,${privateEmails[0]}\nEast,50,${privateEmails[1]}\nSouth,80,${privateEmails[2]}\n`;
  const parsed = await parseCsvUpload({ originalFileName: "continuity-sales.csv", mimeType: "text/csv", now,
    stream: new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode(csv)); controller.close();
    } }),
  });
  const repository = new MemoryDatasetRepository({ now });
  const uploaded = await repository.put(ownership, parsed);
  expect(uploaded.descriptor.aiAccessPolicy).toBe("pending");
  expect(() => repository.assertAiAccessPolicies(ownership, [{ datasetId: uploaded.descriptor.datasetId, policy: "pending" }])).toThrow();
  const descriptor = await repository.setAiAccessPolicy(ownership, uploaded.descriptor.datasetId, "masked");
  const source = descriptor.source;
  const authorize = () => repository.assertAiAccessPolicies(ownership, [{ datasetId: source.id, policy: "masked" }]);
  authorize();
  const document: NotebookDocument = { name: "CSV 连续分析", revision: 7, cells: [
    { id: "note", kind: "text", title: "既有人工说明", markdown: "保留此说明；每轮结果必须重新验证。" },
    { id: "data", kind: "data", title: "合成 CSV", sourceDataSourceId: source.id, outputName: "sales_data" },
  ] };
  const appSpec = structuredClone(demoFixtureResult.data.dataProduct.appSpec);
  appSpec.dataSources.push(source);
  const request = harnessRequestSchema.parse({ idempotencyKey: `csv_first_${crypto.randomUUID().replaceAll("-", "")}`,
    conversation_id: "csv_notebook_thread", instruction: "检查现有单元，按地区汇总 CSV，添加 SQL、表格和图表单元，先验证再让我采用。",
    role: "editor", pageId: "page_home", appSpec, recipes: [], dataSourceId: source.id,
    notebookContext: { document, sourceIds: [source.id] },
  });
  return { repository, descriptor, source, authorize, request, document, rows: uploaded.rows };
}

function additions(prefix: string, doubled = false): NotebookCell[] {
  return [
    { id: `${prefix}_sql`, kind: "sql", title: doubled ? "继续计算两倍收入" : "地区收入汇总",
      inputCellIds: [doubled ? "first_sql" : "data"], outputName: `${prefix}_totals`,
      sql: doubled ? "SELECT region, (revenue * 2)::DOUBLE AS revenue FROM first_totals ORDER BY region"
        : "SELECT region, SUM(amount)::DOUBLE AS revenue FROM sales_data GROUP BY region ORDER BY region" },
    { id: `${prefix}_table`, kind: "table", title: `${prefix} 结果表`, inputCellId: `${prefix}_sql`, columns: ["region", "revenue"] },
    { id: `${prefix}_chart`, kind: "chart", title: `${prefix} 地区图`, inputCellId: `${prefix}_sql`,
      chartType: "bar", categoryField: "region", valueFields: ["revenue"] },
  ];
}

async function runTurn(input: Awaited<ReturnType<typeof fixture>>, store: HarnessConversationStore,
  request: HarnessRequest, cells: NotebookCell[]) {
  const before = structuredClone(request);
  const lease = store.begin(request, namespace);
  const effectiveRequest = harnessRequestSchema.parse({ ...request, conversationContext: lease.context });
  const modelContexts: HarnessModelInput["context"][] = [];
  const runs: NotebookRun[] = [];
  const actions: Array<[HarnessToolName, Record<string, unknown>]> = [
    ["cellSearch", {}], ["editNotebookCells", { editVersion: 0, cells }],
    ["runNotebookCells", { editVersion: 1 }], ["submitNotebookDraft", { editVersion: 1 }],
  ];
  const usage = { promptTokens: 30, completionTokens: 30, totalTokens: 60 };
  const model: HarnessModel = {
    classifyIntent: async () => ({ model: "explicit-scripted-csv-router", inputChars: 300, usage,
      decision: { mode: "readOnlyTask", wantsNotebook: true, wantsData: true, wantsEdsAnalysis: false,
        wantsRawWorkbook: false, wantsFields: false, wantsRecipe: false, wantsAppInspection: false, wantsExcel: false,
        changeAction: "none", changeTarget: "none", componentKind: "none", chartType: "auto", skillIds: [],
        confidence: 1, rationale: "Synthetic Notebook tool integration, not a real model evaluation" } }),
    plan: async ({ fallbackPlan }) => ({ plan: fallbackPlan, model: "explicit-scripted-csv-plan", inputChars: 300, usage }),
    next: async (modelInput) => {
      modelContexts.push(structuredClone(modelInput.context));
      const action = actions[modelInput.iteration - 1];
      if (!action) throw new Error("Unexpected extra scripted model action");
      const [name, args] = action;
      expect(modelInput.tools.map((tool) => tool.name)).toContain(name);
      return { model: "explicit-scripted-csv-actions", usage,
        turn: { type: "callTool", name, arguments: args,
          toolCallId: `${request.idempotencyKey}_${modelInput.iteration}`, message: "执行合成 CSV 分析步骤" } };
    },
  };
  try {
    const task = await new HarnessRuntime().run(effectiveRequest, {
      dataRuntime: { rowsByDataSourceId: { [input.source.id]: input.rows } }, modelClient: model,
      authorizeModelCall: input.authorize, allowFailureExplanation: false,
      notebookRunner: async (artifact, context) => {
        input.authorize();
        const stored = await input.repository.get(ownership, input.source.id);
        if (!stored || artifact.baseRevision === undefined) throw new Error("Synthetic current source or revision missing");
        const run = await runNotebook({ document: { name: artifact.name, revision: artifact.baseRevision, cells: artifact.cells },
          sources: [{ source: stored.descriptor.source, rows: stored.rows }], forAi: true,
          signal: context.signal, log: () => {} });
        runs.push(structuredClone(run));
        return run;
      },
    });
    expect(task.state, task.error).toBe("awaitingConfirmation");
    expect(task.verification?.status).toBe("passed");
    expect(task.counters.toolCallCount).toBe(4);
    expect(task.events.flatMap((event) => event.type === "toolCall" ? [event.toolCall?.name] : [])).toEqual(toolOrder);
    expect((task.trace ?? []).filter((event) => event.type === "tool_completed").map((event) => event.toolCall?.status))
      .toEqual(["success", "success", "success", "success"]);
    expect(task.pendingChangeSet).toBeUndefined();
    expect(request).toEqual(before);
    expect(effectiveRequest.appSpec).toEqual(before.appSpec);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("success");
    expect(task.notebookArtifact?.executionEvidence?.runId).toBe(runs[0].runId);
    expect(task.notebookArtifact?.baseRevision).toBe(before.notebookContext?.document.revision);
    for (const value of privateEmails) expect(JSON.stringify({ modelContexts, task, runs })).not.toContain(value);
    return { task, run: runs[0], modelContexts, commit: () => lease.commit(task), release: () => lease.release() };
  } catch (error) { lease.release(); throw error; }
}

describe("真实 CSV Notebook 两轮分析与会话连续性", () => {
  it.each([true, false])("两轮真实 SQL 保留旧步骤、独立验证且等待采用；同会话=%s", async (sameConversation) => {
    const network = vi.fn(async () => { throw new Error("Network and real model calls are prohibited in this integration test"); });
    vi.stubGlobal("fetch", network);
    const input = await fixture();
    const originalRequest = structuredClone(input.request), originalDocument = structuredClone(input.document);
    const originalStored = structuredClone(await input.repository.get(ownership, input.source.id));
    const store = new HarnessConversationStore();
    const first = await runTurn(input, store, input.request, additions("first"));
    const firstDraft = first.task.notebookArtifact;
    if (!firstDraft) throw new Error("First trial did not produce a Notebook draft");
    let adopted: NotebookDocument;
    try {
      for (const cellId of ["first_sql", "first_table", "first_chart"]) {
        expect(first.run.cells.find((cell) => cell.cellId === cellId)?.table?.rows).toEqual(originalValues);
      }
      expect(firstDraft.cells.slice(0, originalDocument.cells.length)).toEqual(originalDocument.cells);
      expect(input.request).toEqual(originalRequest);
      // Adoption is the explicit user action; Harness and conversation commit do not install it.
      adopted = adoptNotebookDraft(input.document, firstDraft);
      expect(adopted.revision).toBe(originalDocument.revision + 1);
      expect(input.document).toEqual(originalDocument);
      first.commit();
    } finally { first.release(); }

    const followUp = harnessRequestSchema.parse({ ...input.request,
      idempotencyKey: `csv_followup_${crypto.randomUUID().replaceAll("-", "")}`,
      conversation_id: sameConversation ? input.request.conversation_id : "csv_fresh_thread",
      instruction: "保留现有地区汇总和图表单元，再计算其两倍收入并生成新的 SQL、表格和图表单元，先不要采用。",
      notebookContext: { ...input.request.notebookContext, document: adopted },
    });
    const beforeFollowUp = structuredClone(followUp);
    const second = await runTurn(input, store, followUp, additions("second", true));
    try {
      const secondDraft = second.task.notebookArtifact;
      if (!secondDraft) throw new Error("Follow-up did not produce a Notebook draft");
      expect(secondDraft.cells.slice(0, adopted.cells.length)).toEqual(adopted.cells);
      for (const cellId of ["first_sql", "first_table", "first_chart"]) {
        expect(second.run.cells.find((cell) => cell.cellId === cellId)?.table?.rows).toEqual(originalValues);
      }
      for (const cellId of ["second_sql", "second_table", "second_chart"]) {
        expect(second.run.cells.find((cell) => cell.cellId === cellId)?.table?.rows).toEqual(doubledValues);
      }
      expect(second.run.runId).not.toBe(first.run.runId);
      expect(second.run.cells.every((cell) => !cell.resultRef || cell.resultRef.runId === second.run.runId)).toBe(true);
      expect(second.modelContexts[0].latestObservation).toBeUndefined();
      expect(second.modelContexts[0].workingMemory).toMatchObject({ verifiedFacts: [] });
      expect(JSON.stringify(second.modelContexts[0])).not.toContain(first.run.runId);
      if (sameConversation) {
        expect(second.modelContexts[0].recentConversation).toMatchObject({ trust: "untrustedConversationContinuityOnly",
          recentMessages: [{ instruction: input.request.instruction, response: first.task.resultMessage }],
          previousInstruction: input.request.instruction,
        });
        expect(second.modelContexts[0].continuityMemory).toMatchObject({ trust: "conversationContinuityOnly" });
      } else {
        expect(second.modelContexts[0].recentConversation).not.toHaveProperty("previousInstruction");
        expect(second.modelContexts[0].recentConversation).toHaveProperty("recentMessages", undefined);
        expect(second.modelContexts[0].continuityMemory).toBeUndefined();
      }
      expect(second.modelContexts[3].latestObservation).toMatchObject({ result: { status: "success", runId: second.run.runId,
        results: expect.arrayContaining([{ cellId: "second_sql", rows: doubledValues,
          fields: expect.any(Array), resultRef: expect.objectContaining({ runId: second.run.runId, accessMode: "ai" }),
          returnedRows: 2, truncated: false }]),
      } });
      second.commit();
      expect(followUp).toEqual(beforeFollowUp);
      expect(adopted.cells).toEqual(firstDraft.cells);
      expect(adopted.lastDraftId).toBe(firstDraft.id);
      expect(secondDraft.id).not.toBe(adopted.lastDraftId);
      expect(() => adoptNotebookDraft({ ...adopted, revision: adopted.revision + 1 }, secondDraft)).toThrow("Notebook 已在草稿生成后修改");
      expect(input.request).toEqual(originalRequest);
      expect(input.document).toEqual(originalDocument);
      expect(await input.repository.get(ownership, input.source.id)).toEqual(originalStored);
      expect(network).not.toHaveBeenCalled();
    } finally { second.release(); }
  }, 30_000);
});
