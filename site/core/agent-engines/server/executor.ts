import type { AgentExecutionEngine, AgentEngineId } from "../contracts";
import type { HarnessRequest, HarnessTaskSummary } from "@/core/harness/contracts";
import { CoordinatedHarness, type CoordinatedHarnessOptions } from "@/core/harness/agents/coordinator";
import { runDshEngine, type DshDriver, type DshDriverResult } from "./dsh-engine";
import { officialDshDriver } from "./dsh-driver";

type Engine = AgentExecutionEngine<HarnessRequest, CoordinatedHarnessOptions, HarnessTaskSummary>;

/** Only this composition point chooses a complete execution kernel. */
export function createAgentExecutor(dshDriver: DshDriver = officialDshDriver) {
  const original = new CoordinatedHarness();
  const engines: Record<AgentEngineId, Engine> = {
    harness: { id: "harness", run: (request, options) => original.run(request, options) },
    dsh: { id: "dsh", async run(request, options) {
      if (!options.notebookRunner || !options.authorizeModelCall) throw new Error("DSH 服务端能力未完整组装。");
      let driverTask: Promise<DshDriverResult> | undefined;
      try { return await runDshEngine(request, {
        dataRuntime: options.dataRuntime, notebookRunner: options.notebookRunner,
        rawWorkbook: options.rawWorkbook, notebookCapabilities: options.notebookCapabilities,
        pythonRuntimeInfo: options.pythonRuntimeInfo, connectionInspector: options.connectionInspector,
        authorizeCurrentAccess: options.authorizeModelCall,
        signal: options.signal, onEvent: options.onEvent,
        driver(input) { driverTask = dshDriver(input); return driverTask; },
        // These options come from server composition, not the public request.
        // The engine validates all values against its own bounded policy.
        maxToolCalls: options.bounds?.maxToolCalls,
        totalExecutionTimeoutMs: options.bounds?.totalExecutionTimeoutMs,
        toolCallTimeoutMs: options.bounds?.toolCallTimeoutMs,
      }); } finally {
        // The engine rejects late observations immediately. The HTTP task lease
        // nevertheless stays held until the trusted driver has joined SDK exit
        // and closed its broker, including cancellation and deadline paths.
        await driverTask?.catch(() => undefined);
      }
    } },
  };
  return (engine: AgentEngineId, request: HarnessRequest, options: CoordinatedHarnessOptions) => engines[engine].run(request, options);
}

export const executeAgent = createAgentExecutor();
