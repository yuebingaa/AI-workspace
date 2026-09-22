import assert from "node:assert/strict";
import { createServer } from "node:http";
import { demoFixtureResult } from "@/fixtures/demo-product";
import { harnessRequestSchema } from "@/core/harness/contracts";
import { createNotebookToolBridge } from "@/core/harness/server/notebook-tool-bridge";
import { createDshToolBroker } from "@/core/agent-engines/server/tool-broker";
import type { runDshSession } from "../runtime/dsh/driver.mjs";

type ToolName = "cellSearch" | "inspectConnectionSchema";

/** Real SDK + DeepSeek adapter + broker + business bridge; only the model and DB I/O are fixtures. */
export async function verifyDshDispatch(runSession: typeof runDshSession) {
  assert.ok(demoFixtureResult.success);
  const scenarios = [];
  for (const order of [["inspectConnectionSchema", "cellSearch"], ["cellSearch", "inspectConnectionSchema"]] satisfies ToolName[][]) {
    const request = harnessRequestSchema.parse({
      idempotencyKey: `offline_dispatch_${order[0]}`, instruction: "Inspect the authorized test connection and current empty Notebook.",
      role: "editor", pageId: "page_home", recipes: [],
      appSpec: { ...structuredClone(demoFixtureResult.data.dataProduct.appSpec), dataSources: [] },
      notebookContext: { sourceIds: [], document: { name: "Synthetic dispatch inspection", revision: 0, cells: [] },
        connections: [{ id: "fixture_db", name: "Synthetic reader", kind: "postgresql", allowAi: true }] },
    });
    const original = structuredClone(request);
    const controller = new AbortController();
    let active = 0, maximum = 0, modelRequests = 0, modelAuthorizations = 0, schemaInspections = 0;
    const dispatch: string[] = [], outcomes: Array<{ name: string; ok: boolean }> = [];
    const providerFailures: string[] = [];
    const bridge = createNotebookToolBridge({ request, profile: "notebook", dataRuntime: { rowsByDataSourceId: {} },
      signal: controller.signal, authorizeCurrentAccess() {},
      notebookRunner: async () => { throw new Error("This read-only dispatch fixture must not run Notebook cells."); },
      connectionInspector: async (connectionId, signal) => {
        assert.equal(connectionId, "fixture_db");
        signal?.throwIfAborted();
        schemaInspections++;
        // A concurrent second tool would reach the bridge while this first call still owns busy.
        await new Promise((resolve) => setTimeout(resolve, 80));
        signal?.throwIfAborted();
        return { columns: [{ table_schema: "public", table_name: "fixture_sales", column_name: "amount", data_type: "integer" }], truncated: false };
      },
    });
    const broker = await createDshToolBroker({ signal: controller.signal, authorizeCurrentAccess() {},
      onModelCall() { modelAuthorizations++; },
      tools: bridge.catalog().map(tool => ({ ...tool, async execute(args: unknown, signal?: AbortSignal) {
        active++; maximum = Math.max(maximum, active); dispatch.push(`start:${tool.name}`);
        try {
          const result = await bridge.execute(tool.name, args, signal);
          outcomes.push({ name: tool.name, ok: true });
          return { summary: result.summary, data: result.data };
        } catch (error) { outcomes.push({ name: tool.name, ok: false }); throw error; }
        finally { dispatch.push(`finish:${tool.name}`); active--; }
      } })),
    });
    const provider = createServer(async (incoming, response) => {
      try {
        let body = ""; for await (const chunk of incoming) body += chunk;
        const parsed = JSON.parse(body) as { messages: Array<{ role: string; content?: unknown }> };
        const index = modelRequests++;
        assert.ok(index < 2, "Only one multi-tool response and one completion are permitted.");
        if (index === 1) assert.equal(parsed.messages.filter(message => message.role === "tool").length, 2);
        const delta = index === 0 ? { role: "assistant", tool_calls: order.map((name, position) => ({
          index: position, id: `dispatch_call_${position}`, type: "function", function: { name,
            arguments: JSON.stringify(name === "cellSearch" ? {} : { connectionId: "fixture_db" }) },
        })) } : { role: "assistant", content: "Synthetic multi-call inspection completed." };
        response.writeHead(200, { "content-type": "text/event-stream" });
        for (const [part, finish_reason] of [[delta, null], [{}, index === 0 ? "tool_calls" : "stop"]]) {
          response.write(`data: ${JSON.stringify({ id: "offline-dispatch", object: "chat.completion.chunk", created: 1,
            model: "offline-model", choices: [{ index: 0, delta: part, finish_reason }],
          })}\n\n`);
        }
        response.end("data: [DONE]\n\n");
      } catch {
        providerFailures.push("Local provider fixture assertion failed.");
        response.writeHead(500).end("Local provider fixture assertion failed.");
      }
    });
    await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
    try {
      const address = provider.address();
      assert.ok(address && typeof address !== "string");
      const result = await runSession({ brokerUrl: broker.url, brokerToken: broker.token, signal: controller.signal,
        modelConfig: { mode: "deepseek", baseURL: `http://127.0.0.1:${address.port}`, model: "offline-model",
          apiKey: "synthetic-local-provider-key", timeoutMs: 2000 },
        instruction: request.instruction, sessionId: `offline_dispatch_${order[0]}`,
      });
      assert.deepEqual(providerFailures, []);
      assert.equal(modelRequests, 2);
      assert.equal(modelAuthorizations, 2);
      assert.equal(schemaInspections, 1);
      assert.equal(maximum, 1, "Undeclared concurrency safety must default to exclusive SDK dispatch.");
      assert.equal(active, 0);
      assert.deepEqual(dispatch, order.flatMap(name => [`start:${name}`, `finish:${name}`]));
      assert.deepEqual(outcomes, order.map(name => ({ name, ok: true })));
      assert.equal(result.reaped, true);
      assert.equal(bridge.getVerifiedDraft(), undefined);
      assert.deepEqual(request, original);
      scenarios.push({ responseToolOrder: order, dispatch, maximumConcurrentBridgeCalls: maximum,
        toolOutcomes: outcomes, modelRequests, modelAuthorizations, schemaInspections,
        completedAfterReaping: result.reaped, formalDocumentUnchanged: true, noDraft: true });
    } finally {
      await broker.close(); bridge.close();
      provider.closeAllConnections(); await new Promise<void>((resolve) => provider.close(() => resolve()));
    }
  }
  return { passed: true, officialSdk: true, officialDeepSeekAdapter: true, actualBrokerAndBusinessBridge: true,
    realPaidModel: false, realDatabase: false, scenarios,
    conclusion: "Both multi-tool response orders execute serially; the current default SDK dispatch does not conflict with the Notebook busy guard. This does not identify the earlier real-model failure arguments." };
}
