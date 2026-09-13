import {
  LIVE_HARNESS_GLOBAL_BUDGET,
  liveHarnessBudgetSchema,
  liveHarnessEvaluationCaseSchema,
  type LiveHarnessEvaluationCase,
} from "./contracts";

const cases: LiveHarnessEvaluationCase[] = [
  {
    id: "dataset-summary",
    caseVersion: 1,
    title: "检查 retail_orders 行列和字段摘要",
    category: "simpleReadOnly",
    request: {
      instruction: "检查 retail_orders 数据集是否可用，返回行数、列数和字段摘要。不要修改页面，不要创建 ChangeSet。",
      pageId: "page_home",
      dataSourceId: "dataset_retail_orders",
    },
    expected: {
      terminalState: "completed",
      terminationCode: "completed",
      toolSequence: ["inspectDataset"],
      operations: [],
    },
    limits: {
      maxModelCalls: 4,
      maxToolCalls: 1,
      promptTokenReservation: 4_400,
      completionTokenReservation: 1_500,
      activeElapsedReservationMs: 70_000,
      maxCompletionTokensPerCall: 400,
    },
  },
  {
    id: "east-anomaly-recipe-preview",
    caseVersion: 1,
    title: "执行华东异常订单配方预览",
    category: "multiStepAnalysis",
    request: {
      instruction: "检查 retail_orders 字段并执行华东异常订单配方预览。不要修改页面。",
      pageId: "page_customers",
      dataSourceId: "dataset_retail_orders",
    },
    expected: {
      terminalState: "completed",
      terminationCode: "completed",
      toolSequence: ["inspectDataset", "inspectFields", "previewDataRecipe"],
      operations: [],
    },
    limits: {
      maxModelCalls: 6,
      maxToolCalls: 3,
      promptTokenReservation: 9_000,
      completionTokenReservation: 2_400,
      activeElapsedReservationMs: 130_000,
      maxCompletionTokensPerCall: 400,
    },
  },
  {
    id: "revenue-title-change-preview",
    caseVersion: 1,
    title: "修改收入指标标题并等待确认",
    category: "changePreview",
    request: {
      instruction: "将本月收入指标标题改为月度总收入，不要应用。",
      pageId: "page_home",
    },
    expected: {
      terminalState: "awaitingConfirmation",
      terminationCode: "awaitingConfirmation",
      toolSequence: ["createChangeSetPreview"],
      operations: [{
        type: "updateNodeProps",
        pageId: "page_home",
        nodeId: "page_home_revenue",
        props: { label: "月度总收入" },
      }],
    },
    limits: {
      maxModelCalls: 3,
      maxToolCalls: 1,
      promptTokenReservation: 3_400,
      completionTokenReservation: 1_100,
      activeElapsedReservationMs: 55_000,
      maxCompletionTokensPerCall: 400,
    },
  },
];

export const liveHarnessSmokeCases = liveHarnessEvaluationCaseSchema.array().length(3).parse(cases);
export const liveHarnessGlobalBudget = liveHarnessBudgetSchema.parse(LIVE_HARNESS_GLOBAL_BUDGET);

export function findLiveHarnessCase(caseId: string): LiveHarnessEvaluationCase | undefined {
  return liveHarnessSmokeCases.find((evaluationCase) => evaluationCase.id === caseId);
}
