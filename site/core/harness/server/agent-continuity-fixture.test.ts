import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { demoFixtureResult } from "@/fixtures/demo-product";
import { parseCsvUpload } from "@/core/datasets/server/csv-dataset";
import { MemoryDatasetRepository } from "@/core/datasets/server/dataset-repository";
import { adoptNotebookDraft } from "@/core/notebook/client-state";
import { harnessPublicRequestSchema, harnessTaskSummarySchema } from "../contracts";
import { createAgentContinuityRunner, AGENT_CONTINUITY_CSV, AGENT_CONTINUITY_FILE_NAME } from "@/scripts/fixtures/agent-continuity.mjs";

const handles = { allowed: "16a5679f-c71e-4565-81e7-e139d6f6d420", other: "3344ce8e-a9b0-47c8-902f-693a75be69b7" };
const ownership = { tenantId: "synthetic", ownerId: "continuity" };
const resources: Array<{ directory: string; runner?: Awaited<ReturnType<typeof createAgentContinuityRunner>> }> = [];

afterEach(async () => {
  for (const resource of resources.splice(0)) {
    await resource.runner?.close();
    const directory = resolve(resource.directory);
    if (dirname(directory) !== resolve(tmpdir()) || !basename(directory).startsWith("agent-continuity-test-")) {
      throw new Error("Refusing cleanup outside this test's own temporary directory");
    }
    await rm(directory, { recursive: true });
  }
});

async function fixture() {
  if (!demoFixtureResult.success) throw new Error("Synthetic app fixture unavailable");
  const beforeEnvironment = process.env.STUDIO_LOCAL_STATE_DIR, beforeFetch = globalThis.fetch;
  const directory = await mkdtemp(join(tmpdir(), "agent-continuity-test-"));
  const resource: (typeof resources)[number] = { directory }; resources.push(resource);
  const parsed = await parseCsvUpload({ originalFileName: AGENT_CONTINUITY_FILE_NAME, mimeType: "text/csv",
    stream: new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode(AGENT_CONTINUITY_CSV)); controller.close();
    } }),
  });
  const repository = new MemoryDatasetRepository();
  const stored = await repository.put(ownership, parsed);
  const source = stored.descriptor.source;
  const appSpec = structuredClone(demoFixtureResult.data.dataProduct.appSpec); appSpec.dataSources.push(source);
  const payload = harnessPublicRequestSchema.parse({ idempotencyKey: "agent_continuity_first", conversation_id: "agent_continuity_thread",
    instruction: "检查现有单元，按地区汇总 CSV，添加 SQL、表格和图表单元，先验证再让我采用。",
    pageId: "page_home", dataSourceId: source.id, appSpec, recipes: [], notebookContext: {
      sourceIds: [source.id], document: { name: "Browser request synthetic", revision: 4, cells: [
        { id: "manual_data", kind: "data", title: "手工 CSV 来源", sourceDataSourceId: source.id, outputName: "sales_data" },
      ] },
    } });
  let sourceLoads = 0;
  const runner = await createAgentContinuityRunner({ directory,
    scope: { projectHandle: handles.allowed, pageId: payload.pageId, datasetId: source.id },
    loadSyntheticDataset: async (scope: { projectHandle: string; datasetId: string }) => {
      expect(scope.projectHandle).toBe(handles.allowed); expect(scope.datasetId).toBe(source.id); sourceLoads++;
      const loaded = await repository.get(ownership, source.id);
      if (!loaded) throw new Error("Synthetic source unavailable");
      return { descriptor: loaded.descriptor, rows: loaded.rows };
    },
  });
  resource.runner = runner;
  return { runner, payload, stored: structuredClone(stored), repository, sourceLoads: () => sourceLoads, beforeEnvironment, beforeFetch };
}

describe("浏览器实际请求驱动的隔离 Agent 连续分析 fixture", () => {
  it("生成真实两轮 SQL 和正式 SSE，复用在途/完成重复回执，不安装第二稿，并恢复环境", async () => {
    const input = await fixture(), before = structuredClone(input.payload);
    const args = { payload: input.payload, projectHandle: handles.allowed, phase: "first" };
    const [first, duplicate] = await Promise.all([input.runner.run(args), input.runner.run(structuredClone(args))]);
    expect(first).toEqual(duplicate);
    expect(first.request.idempotencyKey).toBe(input.payload.idempotencyKey);
    expect(first.task.instruction).toBe(input.payload.instruction);
    expect(first.task.id).toBe(`harness_${input.payload.idempotencyKey}`);
    expect(first.body).toContain("event: completed\n");
    expect(first.headers["content-type"]).toBe("text/event-stream; charset=utf-8");
    expect(input.runner.getStats()).toEqual({ executions: 1, trials: 1, modelActions: 4, networkAttempts: 0 });
    const firstTask = harnessTaskSummarySchema.parse(first.task);
    if (!firstTask.notebookArtifact || !input.payload.notebookContext) throw new Error("Missing actual trial draft");
    expect(firstTask.state).toBe("awaitingConfirmation");
    expect(input.payload).toEqual(before);
    const adopted = adoptNotebookDraft(input.payload.notebookContext.document, firstTask.notebookArtifact);
    const followup = harnessPublicRequestSchema.parse({ ...input.payload, idempotencyKey: "agent_continuity_second",
      instruction: "保留现有地区汇总和图表单元，再计算其两倍收入并生成新的 SQL、表格和图表单元，先不要采用。",
      notebookContext: { ...input.payload.notebookContext, document: adopted },
    });
    const second = await input.runner.run({ payload: followup, projectHandle: handles.allowed, phase: "followup" });
    expect(second.task.state).toBe("awaitingConfirmation");
    expect(second.task.verification.status).toBe("passed");
    expect(second.trials[0].runId).not.toBe(first.trials[0].runId);
    expect(second.modelContexts[0].recentConversation.previousInstruction).toBe(input.payload.instruction);
    expect(second.modelContexts[0].workingMemory.verifiedFacts).toEqual([]);
    expect(second.trials[0].cells.find((cell: { cellId: string }) => cell.cellId === "m7_agent_followup_table").table.rows)
      .toEqual([{ region: "East", revenue: 300 }, { region: "South", revenue: 160 }]);
    expect(followup.notebookContext?.document.cells).toHaveLength(4);
    expect(second.task.notebookArtifact.cells).toHaveLength(7);
    first.task.resultMessage = "Caller mutation must not change the cache";
    expect((await input.runner.run(args)).task.resultMessage).toBe(duplicate.task.resultMessage);
    expect(input.sourceLoads()).toBe(2);
    expect(input.runner.getStats()).toEqual({ executions: 2, trials: 2, modelActions: 8, networkAttempts: 0 });
    expect(await input.repository.get(ownership, input.stored.descriptor.datasetId)).toEqual(input.stored);
    await input.runner.close();
    expect(process.env.STUDIO_LOCAL_STATE_DIR).toBe(input.beforeEnvironment);
    expect(globalThis.fetch).toBe(input.beforeFetch);
    await expect(input.runner.run(args)).rejects.toThrow("Fixture is closed");
  }, 30_000);

  it("跨项目/页面/来源、伪造角色、未采用或旧修订追问及幂等冲突均拒绝，不额外执行", async () => {
    const input = await fixture();
    const run = (payload: unknown, overrides = {}) => input.runner.run({ payload, projectHandle: handles.allowed, phase: "first", ...overrides });
    await expect(run(input.payload, { projectHandle: handles.other })).rejects.toThrow("Project scope mismatch");
    await expect(run({ ...input.payload, pageId: "page_other" })).rejects.toThrow("Page scope mismatch");
    await expect(run({ ...input.payload, dataSourceId: "dataset_other" })).rejects.toThrow("Dataset scope mismatch");
    await expect(run({ ...input.payload, role: "admin" })).rejects.toThrow();
    await expect(run(input.payload, { phase: "followup" })).rejects.toThrow("First phase has not completed");
    expect(input.sourceLoads()).toBe(0);
    expect(input.runner.getStats().executions).toBe(0);
    const firstPayload = { ...input.payload, idempotencyKey: "guard_first_valid" };
    const first = await run(firstPayload), task = harnessTaskSummarySchema.parse(first.task);
    if (!task.notebookArtifact || !input.payload.notebookContext) throw new Error("Missing draft");
    const adopted = adoptNotebookDraft(input.payload.notebookContext.document, task.notebookArtifact);
    await expect(run({ ...firstPayload, instruction: "different request" })).rejects.toThrow("Idempotency key was reused");
    await expect(run({ ...input.payload, idempotencyKey: "guard_unadopted" }, { phase: "followup" }))
      .rejects.toThrow("actually adopted current revision");
    await expect(run({ ...input.payload, idempotencyKey: "guard_stale", notebookContext: {
      ...input.payload.notebookContext, document: { ...adopted, revision: adopted.revision - 1 },
    } }, { phase: "followup" })).rejects.toThrow("actually adopted current revision");
    expect(input.sourceLoads()).toBe(1);
    expect(input.runner.getStats()).toEqual({ executions: 1, trials: 1, modelActions: 4, networkAttempts: 0 });
  }, 30_000);
});
