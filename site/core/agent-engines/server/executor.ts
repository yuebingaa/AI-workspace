import type { AgentEngineId } from "../contracts";
import type { HarnessRequest, HarnessTaskSummary, HarnessTraceEvent } from "@/core/harness/contracts";
import { CoordinatedHarness, type CoordinatedHarnessOptions } from "@/core/harness/agents/coordinator";
import { runDshEngine, type DshDriver, type DshDriverResult, type DshNativeSessionBinding } from "./dsh-engine";
import { officialDshDriver } from "./dsh-driver";
import type { DshExecutionPolicy } from "./execution-policy";
import type { AuthorizedAgentDataPorts } from "./authorized-ports";

export interface DshAgentExecutionOptions extends AuthorizedAgentDataPorts {
  authorizeCurrentAccess(): void;
  signal?: AbortSignal;
  onEvent?: (event: HarnessTraceEvent) => void;
  executionPolicy?: DshExecutionPolicy;
}

interface AgentExecutionMode {
  dshConversation?: boolean;
  nativeSession?: DshNativeSessionBinding;
}

/** Only this composition point chooses a complete execution kernel. */
export function createAgentExecutor(dshDriver: DshDriver = officialDshDriver) {
  const original = new CoordinatedHarness();
  async function runDsh(request: HarnessRequest, options: DshAgentExecutionOptions, conversationMode = false, nativeSession?: DshNativeSessionBinding) {
    if (!options.notebookRunner || !options.authorizeCurrentAccess) throw new Error("DSH 服务端能力未完整组装。");
    let driverTask: Promise<DshDriverResult> | undefined;
    try { return await runDshEngine(request, {
      dataRuntime: options.dataRuntime, notebookRunner: options.notebookRunner, conversationMode, nativeSession,
      rawWorkbook: options.rawWorkbook, notebookCapabilities: options.notebookCapabilities,
      pythonRuntimeInfo: options.pythonRuntimeInfo, connectionInspector: options.connectionInspector,
      authorizeCurrentAccess: options.authorizeCurrentAccess,
      signal: options.signal, onEvent: options.onEvent,
      driver(input) { driverTask = dshDriver(input); return driverTask; },
      // These options come from server composition, not the public request.
      // The engine validates all values against its own bounded policy.
      maxToolCalls: options.executionPolicy?.maxToolCalls,
      totalExecutionTimeoutMs: options.executionPolicy?.totalExecutionTimeoutMs,
      toolCallTimeoutMs: options.executionPolicy?.toolCallTimeoutMs,
    }); } finally {
      // The engine rejects late observations immediately. The HTTP task lease
      // nevertheless stays held until the trusted driver has joined SDK exit
      // and closed its broker, including cancellation and deadline paths.
      await driverTask?.catch(() => undefined);
    }
  }
  function execute(engine: "harness", request: HarnessRequest, options: CoordinatedHarnessOptions, mode?: AgentExecutionMode): Promise<HarnessTaskSummary>;
  function execute(engine: "dsh", request: HarnessRequest, options: DshAgentExecutionOptions, mode?: AgentExecutionMode): Promise<HarnessTaskSummary>;
  function execute(engine: AgentEngineId, request: HarnessRequest, options: CoordinatedHarnessOptions | DshAgentExecutionOptions,
    mode: AgentExecutionMode = {}): Promise<HarnessTaskSummary> {
    if (mode.dshConversation && engine !== "dsh") return Promise.reject(new Error("DSH 对话入口不能使用其他执行器。"));
    return engine === "dsh"
      ? runDsh(request, options as DshAgentExecutionOptions, mode.dshConversation, mode.nativeSession)
      : original.run(request, options as CoordinatedHarnessOptions);
  }
  return execute;
}

export const executeAgent = createAgentExecutor();
