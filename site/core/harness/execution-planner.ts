import {
  harnessExecutionPlanSchema,
  type HarnessExecutionPlan,
  type HarnessObservation,
  type HarnessRequest,
  type HarnessSemanticIntentDecision,
  type HarnessToolName,
  type HarnessWorkingMemory,
} from "./contracts";
import { plannedHarnessToolSequence, type HarnessRecoveryContext } from "./context-selector";
import { sanitizeHarnessText } from "./security";
import { requiresHarnessVisualVerification } from "./task-verifier";

const toolObjectives: Record<HarnessToolName, string> = {
  analyzeEdsReports: "读取并验证 EDS 派生汇总",
  scanEdsRawWorkbook: "完整扫描授权的原始工作簿并建立结构概况",
  queryEdsRawWorkbook: "按目标查询完整匹配集合并保留来源",
  inspectEdsRawWorkbook: "检查原始工作簿结构",
  readEdsRawRows: "读取授权范围内的原始行列",
  inspectDataset: "检查目标数据集概况",
  inspectFields: "验证任务所需字段与数据质量",
  previewDataRecipe: "执行数据配方预览",
  validateDataRecipe: "验证数据配方可执行性",
  exportDataRecipeToExcel: "生成可下载的 Excel 结果",
  inspectAppSpec: "检查当前页面和组件结构",
  createEdsBreakdownChartPreview: "生成 EDS 异常分类图表变更预览",
  createEdsLineIssueChartPreview: "生成指定线体异常类型图表变更预览",
  updateEdsTablePreview: "生成 EDS 明细表调整预览",
  createChangeSetPreview: "生成页面变更预览",
};

function finalObjective(sequence: HarnessToolName[], requiresVisualVerification: boolean): string {
  if (sequence.some((toolName) => toolName.includes("Preview") || toolName === "createChangeSetPreview")) {
    return "提交待确认 ChangeSet 并暂停，等待用户确认";
  }
  if (sequence.includes("exportDataRecipeToExcel")) return "返回验证结论和 Excel 下载结果";
  if (requiresVisualVerification) return "截取桌面与窄屏最终页面，由多模态模型完成视觉验收后再回答";
  return "根据工具验证结果直接回答用户";
}

export function createHarnessExecutionPlan(
  request: HarnessRequest,
  semanticIntent?: HarnessSemanticIntentDecision,
): HarnessExecutionPlan {
  const sequence = plannedHarnessToolSequence(request, semanticIntent);
  const steps: HarnessExecutionPlan["steps"] = sequence.map((toolName, index) => ({
    id: `step_${index + 1}_${toolName.toLocaleLowerCase("en-US")}`.slice(0, 80),
    kind: "tool",
    objective: toolObjectives[toolName],
    toolName,
    status: index === 0 ? "active" : "pending",
    attempts: 0,
  }));
  const finalizeStep = {
    id: `step_${steps.length + 1}_finalize`,
    kind: "finalize" as const,
    objective: finalObjective(sequence, requiresHarnessVisualVerification(request, semanticIntent)),
    status: steps.length === 0 ? "active" as const : "pending" as const,
    attempts: 0,
  };
  const planSteps = [...steps, finalizeStep];
  return harnessExecutionPlanSchema.parse({
    revision: 1,
    goal: sanitizeHarnessText(request.instruction).slice(0, 420),
    steps: planSteps,
    currentStepId: planSteps.find((step) => step.status === "active")?.id,
    allowedTools: sequence.slice(0, 1),
  });
}

export function syncHarnessExecutionPlan(
  plan: HarnessExecutionPlan,
  observations: HarnessObservation[],
  allowedTools: HarnessToolName[],
  failedAttempts: HarnessWorkingMemory["failedAttempts"],
  recovery?: HarnessRecoveryContext,
): HarnessExecutionPlan {
  const completedTools = new Set(observations.map((observation) => observation.toolName));
  const exhaustedTools = new Set(failedAttempts
    .filter((attempt) => attempt.status === "exhausted")
    .map((attempt) => attempt.toolName));
  const executorTool = recovery && recovery.failureKind !== "argumentValidation"
    ? allowedTools.find((toolName) => toolName !== recovery.failedTool) ?? allowedTools[0]
    : allowedTools[0];
  const existingToolSteps = plan.steps.filter((step) => step.kind === "tool");
  const needsRecoveryStep = Boolean(
    recovery
    && executorTool
    && !existingToolSteps.some((step) => step.toolName === executorTool && step.status !== "completed"),
  );
  const recoveryStep = needsRecoveryStep && executorTool ? {
    id: `replan_${Math.max(plan.revision, recovery?.attempt ?? 0) + 1}_${executorTool.toLocaleLowerCase("en-US")}`.slice(0, 80),
    kind: "tool" as const,
    objective: toolObjectives[executorTool],
    toolName: executorTool,
    status: "pending" as const,
    attempts: 0,
  } : undefined;
  const recoveryInsertIndex = recoveryStep && recovery
    ? existingToolSteps.findIndex((step) => step.toolName === recovery.failedTool && step.status !== "completed")
    : -1;
  const plannedToolSteps = recoveryStep
    ? [
        ...existingToolSteps.slice(0, recoveryInsertIndex < 0 ? existingToolSteps.length : recoveryInsertIndex),
        recoveryStep,
        ...existingToolSteps.slice(recoveryInsertIndex < 0 ? existingToolSteps.length : recoveryInsertIndex),
      ]
    : existingToolSteps;
  let activated = false;
  const toolSteps = plannedToolSteps.map((step) => {
    const toolName = step.toolName;
    const attempts = toolName ? failedAttempts.filter((attempt) => attempt.toolName === toolName).length : 0;
    if (toolName && completedTools.has(toolName)) return { ...step, status: "completed" as const, attempts };
    if (toolName && exhaustedTools.has(toolName)) return { ...step, status: "failed" as const, attempts };
    if (toolName === executorTool && !activated) {
      activated = true;
      return { ...step, status: "active" as const, attempts };
    }
    return { ...step, status: "pending" as const, attempts };
  });
  const hasActiveToolStep = toolSteps.some((step) => step.status === "active");
  const finalize = plan.steps.find((step) => step.kind === "finalize");
  if (!finalize) throw new Error("Harness 执行计划缺少收尾步骤。");
  const finalizeStep = {
    ...finalize,
    status: hasActiveToolStep || allowedTools.length > 0 ? "pending" as const : "active" as const,
  };
  const steps = [...toolSteps, finalizeStep];
  const recoveryReason = recovery
    ? `第 ${recovery.attempt} 次重新规划：${toolObjectives[recovery.failedTool]}失败；${recovery.issueSummary.join("；")}`
    : undefined;
  return harnessExecutionPlanSchema.parse({
    ...plan,
    revision: recovery ? Math.max(plan.revision, recovery.attempt + 1) : plan.revision,
    steps,
    currentStepId: steps.find((step) => step.status === "active")?.id ?? finalizeStep.id,
    allowedTools: executorTool ? [executorTool] : [],
    ...(recoveryReason ? { replanReason: sanitizeHarnessText(recoveryReason).slice(0, 500) } : {}),
  });
}

export function finishHarnessExecutionPlan(
  plan: HarnessExecutionPlan,
  outcome: "completed" | "awaitingConfirmation" | "blocked" | "failed" | "cancelled",
): HarnessExecutionPlan {
  const successful = outcome === "completed" || outcome === "awaitingConfirmation";
  return harnessExecutionPlanSchema.parse({
    ...plan,
    steps: plan.steps.map((step) => step.status === "active"
      ? { ...step, status: successful ? "completed" as const : "failed" as const }
      : step),
    currentStepId: undefined,
    allowedTools: [],
  });
}

export function replanHarnessExecutionPlanAfterVerification(
  plan: HarnessExecutionPlan,
  issues: string[],
): HarnessExecutionPlan {
  const finalize = plan.steps.find((step) => step.kind === "finalize");
  if (!finalize) throw new Error("Harness 执行计划缺少收尾步骤。");
  const steps = plan.steps.map((step) => step.kind === "finalize"
    ? { ...step, status: "active" as const, attempts: step.attempts + 1 }
    : step.status === "active"
      ? { ...step, status: "pending" as const }
      : step);
  return harnessExecutionPlanSchema.parse({
    ...plan,
    revision: plan.revision + 1,
    steps,
    currentStepId: finalize.id,
    allowedTools: [],
    replanReason: sanitizeHarnessText(`Verifier 未通过：${issues.join("；")}`).slice(0, 500),
  });
}

export function harnessExecutionPlanContext(plan: HarnessExecutionPlan) {
  const currentStep = plan.steps.find((step) => step.id === plan.currentStepId);
  return {
    revision: plan.revision,
    separation: "plannerThenExecutor",
    rule: "Executor 只执行 currentStep 和 allowedTools",
    ...(currentStep ? {
      currentStep: {
        id: currentStep.id,
        kind: currentStep.kind,
        objective: currentStep.objective,
        status: currentStep.status,
      },
    } : {}),
    allowedTools: plan.allowedTools,
    ...(plan.replanReason ? { replanReason: plan.replanReason } : {}),
    steps: plan.steps.map(({ id, toolName, status }) => ({
      id,
      ...(toolName ? { toolName } : {}),
      status,
    })),
  };
}
