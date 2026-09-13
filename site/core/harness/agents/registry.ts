import type { HarnessRequest, HarnessToolName } from "../contracts";
import { classifyHarnessTask, plannedHarnessToolSequence, resolveHarnessIntent } from "../context-selector";
import { requiresHarnessVisualVerification } from "../task-verifier";

export const dataAgentProfile = {
  id: "data",
  name: "数据 Agent",
  tools: ["inspectDataset", "inspectFields", "querySemanticModel", "analyzeEdsReports",
    "scanEdsRawWorkbook", "queryEdsRawWorkbook", "inspectEdsRawWorkbook", "readEdsRawRows"] as readonly HarnessToolName[],
  instructions: "你是数据子 Agent，只执行当前委派的只读任务。保持用户的筛选条件和指标口径；结论必须来自本轮工具结果。不得委派、修改页面、导出或调用外部工具。",
} as const;

export function isDataAgentTool(name: string): name is HarnessToolName {
  return dataAgentProfile.tools.some((tool) => tool === name);
}

/** Conservative v1 routing. Follow-ups retain the existing conversation semantics. */
export function canDelegateDataTask(request: HarnessRequest): boolean {
  const intent = resolveHarnessIntent(request);
  const tools = plannedHarnessToolSequence(request);
  return classifyHarnessTask(request).complexity === "multiStep"
    && !intent.wantsChange && !intent.wantsExcel && !intent.wantsRecipe
    && !intent.wantsMcpTool && !intent.wantsNotebook && !intent.wantsAnalysisPlan
    && !intent.wantsAppInspection && !requiresHarnessVisualVerification(request)
    && !request.userImageEvidence && !request.imageAttachmentManifest?.length
    && !request.conversationContext?.previousInstruction
    && !request.conversationContext?.recentMessages?.length
    && !request.conversationContext?.summary && !request.conversationContext?.workingMemory
    && tools.length > 0 && tools.every((name) => dataAgentProfile.tools.includes(name));
}
