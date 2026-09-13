import type { ExcelExportArtifact } from "@/core/exports/contracts";
import type { ChangeSet } from "@/core/models";
import {
  harnessTaskVerificationSchema,
  type HarnessExecutionPlan,
  type HarnessObservation,
  type HarnessRequest,
  type HarnessSemanticIntentDecision,
  type HarnessTaskVerification,
  type HarnessVisualVerificationEvidence,
  type HarnessVerificationCheck,
} from "./contracts";
import { plannedHarnessToolSequence, resolveHarnessIntent } from "./context-selector";
import { sanitizeHarnessText } from "./security";

export type HarnessVerificationOutcome = "completed" | "awaitingConfirmation";

export interface HarnessVerificationCandidate {
  outcome: HarnessVerificationOutcome;
  message: string;
  pendingChangeSet?: ChangeSet;
  exportArtifact?: ExcelExportArtifact;
  formalAppSpecUnchanged: boolean;
}

export interface HarnessTaskVerifierInput {
  request: HarnessRequest;
  plan: HarnessExecutionPlan;
  observations: HarnessObservation[];
  candidate: HarnessVerificationCandidate;
  attempt: number;
  semanticIntent?: HarnessSemanticIntentDecision;
  visualEvidence?: HarnessVisualVerificationEvidence;
}

const genericCompletionPattern = /^(?:已完成|任务已完成|分析已完成|处理完成|检查完成)[。.!！]?$/u;
const explicitChartChangeGoalPattern = /(?:帮我|请|替我|给我|把|将).{0,40}(?:做|画|制作|生成|创建|新增|增加|添加|改成|换成).{0,40}(?:面积图|饼(?:状)?图|环形图|折线图|曲线图|柱状图|柱形图|条形图|图表)/u;
const visualTaskFallbackPattern = /(?:页面|网页|界面|UI|图表|柱状图|折线图|面积图|饼(?:状)?图|环形图|看板|布局|样式|颜色|响应式|缩放|窄屏|宽屏|溢出|重叠|遮挡|裁切|对齐|间距|字体|坐标轴|图例|渲染)/iu;

export function requiresHarnessVisualVerification(
  request: HarnessRequest,
  semanticIntent?: HarnessSemanticIntentDecision,
): boolean {
  if (semanticIntent?.mode === "conversation") return false;
  if (semanticIntent?.requiresVisualVerification === true) return true;
  if (semanticIntent?.mode === "changePreview" && semanticIntent.changeTarget !== "none") return true;
  if (semanticIntent && (
    semanticIntent.componentKind === "chart"
    || ["chart", "edsBreakdownChart", "edsLineIssueChart"].includes(semanticIntent.changeTarget)
  )) return true;
  const fallbackInstruction = request.instruction
    .replace(/不要(?:修改|变更|更新|创建|调整)[^，。；]*(?:页面|网页|界面|UI|看板)/giu, "")
    .replace(/(?:页面|网页|界面|UI|看板)[^，。；]*保持不变/giu, "")
    .replace(/不要创建\s*ChangeSet/giu, "");
  return !semanticIntent && visualTaskFallbackPattern.test(fallbackInstruction);
}

export function harnessVisualVerificationMode(
  request: HarnessRequest,
  semanticIntent?: HarnessSemanticIntentDecision,
): "inspection" | "acceptance" {
  const intent = resolveHarnessIntent(request, semanticIntent);
  const readOnlyVisualInspection = semanticIntent?.mode === "readOnlyTask"
    && semanticIntent.requiresVisualVerification === true;
  return !intent.wantsChange && (intent.wantsAppInspection || readOnlyVisualInspection)
    ? "inspection"
    : "acceptance";
}

function check(
  id: string,
  label: string,
  passed: boolean,
  passedDetail: string,
  failedDetail: string,
): HarnessVerificationCheck {
  return {
    id,
    label,
    status: passed ? "passed" : "failed",
    detail: sanitizeHarnessText(passed ? passedDetail : failedDetail).slice(0, 360),
  };
}

export function pendingHarnessTaskVerification(): HarnessTaskVerification {
  return harnessTaskVerificationSchema.parse({
    attempt: 0,
    status: "pending",
    checks: [],
    issues: [],
    evidenceToolCallIds: [],
  });
}

export function verifyHarnessTask(input: HarnessTaskVerifierInput): HarnessTaskVerification {
  const requiredTools = plannedHarnessToolSequence(input.request, input.semanticIntent);
  const observedTools = new Set(input.observations.map((observation) => observation.toolName));
  const missingTools = requiredTools.filter((toolName) => !observedTools.has(toolName));
  const unresolvedPlanSteps = input.plan.steps.filter((step) => step.kind === "tool"
    && step.toolName
    && !observedTools.has(step.toolName)
    && step.status !== "skipped");
  const plannedChangeSet = requiredTools.some((toolName) => toolName === "createChangeSetPreview"
    || toolName === "createEdsBreakdownChartPreview"
    || toolName === "createEdsLineIssueChartPreview"
    || toolName === "updateEdsTablePreview");
  const explicitChartChangeGoal = explicitChartChangeGoalPattern.test(input.request.instruction)
    && !/不要(?:修改|创建|新增|增加|添加|生成)[^，。；]*/u.test(input.request.instruction);
  const requiresChangeSet = !requiredTools.includes("createNotebookDraft") && (plannedChangeSet || explicitChartChangeGoal);
  const requiresExport = requiredTools.includes("exportDataRecipeToExcel");
  const requiresAnalysisPlan = requiredTools.includes("createAnalysisPlan");
  const requiresNotebook = requiredTools.includes("createNotebookDraft");
  const message = sanitizeHarnessText(input.candidate.message).trim();
  const responseIsSpecific = message.length > 0
    && (input.candidate.outcome === "awaitingConfirmation"
      || requiredTools.length === 0
      || !genericCompletionPattern.test(message));
  const changeSetReady = !requiresChangeSet || (
    input.candidate.outcome === "awaitingConfirmation"
    && Boolean(input.candidate.pendingChangeSet?.operations.length)
  );
  const exportReady = !requiresExport || Boolean(input.candidate.exportArtifact);
  const analysisPlanObservation = input.observations.find((observation) => observation.toolName === "createAnalysisPlan");
  const analysisPlanData = analysisPlanObservation?.data && typeof analysisPlanObservation.data === "object"
    ? analysisPlanObservation.data as Record<string, unknown>
    : undefined;
  const analysisPlanId = typeof analysisPlanData?.analysisPlanArtifactId === "string" ? analysisPlanData.analysisPlanArtifactId : undefined;
  const analysisPlanReady = !requiresAnalysisPlan || Boolean(
    analysisPlanId
    && analysisPlanData?.status === "planned"
    && Array.isArray(analysisPlanData.steps)
    && analysisPlanData.steps.length > 0,
  );
  const notebookReady = !requiresNotebook || input.observations.some((observation) => {
    if (observation.toolName !== "createNotebookDraft" || !observation.data || typeof observation.data !== "object") return false;
    const data = observation.data as Record<string, unknown>;
    return typeof data.notebookArtifactId === "string"
      && data.status === "draft"
      && typeof data.cellCount === "number"
      && data.cellCount > 0
      && (!requiresAnalysisPlan || data.analysisPlanId === analysisPlanId)
      && (!input.request.notebookContext || (data.execution !== null && typeof data.execution === "object" && "status" in data.execution && data.execution.status === "success"));
  });
  const requiresVisualEvidence = requiresHarnessVisualVerification(input.request, input.semanticIntent);
  const visualReady = !requiresVisualEvidence
    || input.visualEvidence?.status === "passed"
    || (input.candidate.outcome === "awaitingConfirmation" && input.visualEvidence?.status === "deferred");
  const checks = [
    ...(requiredTools.includes("querySemanticModel") ? [check(
      "semantic_model", "语义模型口径",
      input.observations.some((observation) => {
        const data = observation.data;
        return observation.toolName === "querySemanticModel" && data !== null && typeof data === "object"
          && "modelId" in data && data.modelId === input.request.semanticModel?.id
          && "modelVersion" in data && data.modelVersion === input.request.semanticModel?.version
          && "sourceDataSourceId" in data && data.sourceDataSourceId === input.request.semanticModel?.sourceDatasetId;
      }),
      "查询结果引用了本次选中的语义模型版本和数据源。",
      "缺少与本次选中模型版本及数据源一致的查询证据。",
    )] : []),
    ...(requiresNotebook ? [check(
      "notebook_draft", "Notebook 草稿",
      notebookReady,
      "Notebook 草稿包含已校验的单元和依赖关系。",
      "缺少经过 createNotebookDraft 校验的 Notebook 草稿证据。",
    )] : []),
    ...(requiresAnalysisPlan ? [check(
      "analysis_plan", "Analysis Plan",
      analysisPlanReady,
      "Analysis Plan 包含经过校验的目标、步骤和交付物。",
      "缺少经过 createAnalysisPlan 校验的分析计划证据。",
    )] : []),
    check(
      "goal_output",
      "目标与输出",
      responseIsSpecific,
      "最终输出包含可交付的具体结论。",
      "最终输出过于笼统，不能证明已经回答原始目标。",
    ),
    check(
      "planned_steps",
      "计划完成度",
      missingTools.length === 0 && unresolvedPlanSteps.length === 0,
      "Planner 要求的工具步骤均有成功观察证据。",
      `仍缺少计划步骤：${[...new Set([...missingTools, ...unresolvedPlanSteps.flatMap((step) => step.toolName ? [step.toolName] : [])])].join("、") || "未知步骤"}`,
    ),
    check(
      "tool_evidence",
      "工具证据",
      requiredTools.length === 0 || input.observations.length > 0,
      requiredTools.length === 0 ? "当前任务不要求工具证据。" : `已核对 ${input.observations.length} 条工具观察。`,
      "任务要求读取或修改数据，但没有成功工具观察。",
    ),
    check(
      "deliverable",
      "交付物",
      changeSetReady && exportReady && analysisPlanReady && notebookReady,
      requiresChangeSet ? "ChangeSet 已生成并停在人工确认。" : requiresExport ? "Excel 导出物已生成。" : requiresNotebook ? "Analysis Plan 和 Notebook 草稿已生成。" : requiresAnalysisPlan ? "Analysis Plan 已生成。" : "当前任务不要求额外交付物。",
      requiresChangeSet ? "缺少待确认 ChangeSet。" : requiresExport ? "缺少要求的 Excel 导出物。" : requiresNotebook ? "缺少要求的 Analysis Plan 或 Notebook 草稿。" : "缺少要求的 Analysis Plan。",
    ),
    check(
      "formal_app_protection",
      "正式页面保护",
      input.candidate.formalAppSpecUnchanged,
      "Verifier 确认正式 AppSpec 未被执行过程直接修改。",
      "正式 AppSpec 在用户确认前发生变化，拒绝通过验证。",
    ),
    ...(requiresVisualEvidence ? [check(
      "visual_render",
      "最终渲染视觉验证",
      visualReady,
      input.visualEvidence?.status === "deferred"
        ? "ChangeSet 仍在人工确认阶段；最终渲染视觉验证已明确延期，当前任务未宣告完成。"
        : `Playwright 截图已由多模态模型验收：${input.visualEvidence?.summary ?? "通过"}`,
      input.visualEvidence?.status === "failed"
        ? `多模态视觉验收未通过：${input.visualEvidence.issues.join("；") || input.visualEvidence.summary}`
        : input.visualEvidence?.status === "unavailable"
          ? `视觉验证不可用：${input.visualEvidence.summary}`
          : "UI、图表或布局任务缺少 Playwright 截图与多模态模型视觉证据。",
    )] : []),
  ];
  const issues = checks.filter((item) => item.status === "failed").map((item) => item.detail).slice(0, 6);
  return harnessTaskVerificationSchema.parse({
    attempt: input.attempt,
    status: issues.length === 0 ? "passed" : "replan",
    checks,
    issues,
    evidenceToolCallIds: input.observations.map((observation) => observation.toolCallId).slice(-15),
    ...(requiresVisualEvidence && input.visualEvidence ? { visualEvidence: input.visualEvidence } : {}),
  });
}

export function failHarnessTaskVerification(verification: HarnessTaskVerification): HarnessTaskVerification {
  return harnessTaskVerificationSchema.parse({ ...verification, status: "failed" });
}
