import assert from "node:assert/strict";
import { harnessPublicRequestSchema, harnessRequestSchema } from "@/core/harness/contracts";
import { createHarnessStreamResponse, readHarnessStream } from "@/core/harness/stream";
import { runDshEngine } from "@/core/agent-engines/server/dsh-engine";

/** Real conversation-mode engine / context / SSE; deliberately no SDK or model. */
export async function createConversationFixture(payload: unknown, round: number) {
  const input = harnessPublicRequestSchema.parse(payload);
  const request = harnessRequestSchema.parse({ ...input, role: "editor" });
  assert.ok(round === 1 || round === 2);
  assert.equal(request.appSpec.dataSources.length, 0);
  assert.equal(request.recipes.length, 0);
  assert.equal(request.notebookContext?.document.cells.length ?? 0, 0);
  const before = structuredClone(request), controller = new AbortController();
  let continuityVerified = false;
  const response = createHarnessStreamResponse(controller.signal, (signal, onEvent) => runDshEngine(request, {
    conversationMode: true, signal, onEvent, dataRuntime: { rowsByDataSourceId: {} }, authorizeCurrentAccess() {},
    notebookRunner: async () => { throw new Error("Conversation fixture must never execute a Notebook."); },
    driver: async driver => {
      assert.equal(driver.profile, "conversation");
      assert.equal(driver.tools.length, 0);
      assert.deepEqual(driver.context.completion && (driver.context.completion as { mode: string }).mode, "conversation");
      driver.onModelCall();
      if (round === 1) {
        assert.match(driver.instruction, /测试代号晨星42/u);
        assert.equal(request.conversationContext?.recentMessages?.length ?? 0, 0);
        return { finalResponse: "我是通过 DeepSeek Harness 接入的 AgentCanvas 助手。已记住本次合成测试代号：晨星42。", model: "offline-fixed-driver" };
      }
      const recent = driver.context.recentConversation as { recentMessages?: Array<{ instruction: string; response: string }> } | undefined;
      assert.equal(recent?.recentMessages?.length, 1);
      const code = recent?.recentMessages?.[0].instruction.match(/测试代号(晨星\d+)/u)?.[1];
      assert.equal(code, "晨星42", "Second-round answer must come from actual browser history delivered to the engine.");
      assert.match(recent!.recentMessages![0].response, /晨星42/u);
      continuityVerified = true;
      return { finalResponse: code, model: "offline-fixed-driver" };
    },
  }));
  const body = await response.text();
  const { task } = await readHarnessStream(new Response(body, { headers: response.headers }), controller.signal);
  assert.equal(task.state, "completed"); assert.equal(task.counters.toolCallCount, 0);
  assert.equal(task.notebookArtifact, undefined); assert.equal(task.pendingChangeSet, undefined);
  assert.deepEqual(request, before);
  return { body, task, evidence: { actualEngine: true, conversationMode: true, actualContext: true, actualSse: true,
    fixedModelDriver: true, continuityVerified, publicHandler: false, officialSdk: false, paidModel: false, notebookExecuted: false } };
}
