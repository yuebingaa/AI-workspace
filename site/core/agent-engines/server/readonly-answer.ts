import type { HarnessRequest } from "@/core/harness/contracts";
import { isNotebookInspection } from "@/core/harness/notebook-cell-tools";
import { sanitizeHarnessText } from "@/core/harness/security";
import { dataTableSchema } from "@/core/datasets/table-contracts";
import { notebookResultReferenceSchema } from "@/core/notebook/contracts";

export interface DshReadonlyMode { allowRun: boolean; requireOutput: boolean }
export interface DshReadonlyObservation { toolCallId: string; toolName: string; data: unknown }
export interface DshAnalysisToolAttempt {
  toolName: string;
  status: "running" | "success" | "failure";
  /** Set only by the engine from a trusted, recoverable search error. */
  recoverableSearchFailure?: boolean;
}

const prohibitedAction = /(?:不要|不必|不用|无需|禁止|不能|不允许|别|不)(?:再|去|自动|重新)?(?:创建|新增|增加|添加|生成|制作|编辑|修改|改动|改成|改为|改名|重命名|调整|移动|更改|更新|删除|移除|替换|修复|导出|下载|保存|发布|重跑|运行|执行|分析)/gu;
const mutation = /创建|新增|增加|添加|生成|制作|编辑|修改|改动|改成|改为|改名|重命名|调整|移动|更改|更新|删除|移除|替换|修复|导出|下载|保存|发布|重新分析|重做分析|(?:帮我|请|给我|替我).{0,12}分析|\b(?:create|add|edit|modify|update|delete|remove|replace|rename|move|adjust|fix|export|download|save|publish|analy[sz]e)\b/iu;
// Recognize existing-analysis nouns/questions, never silently downgrade an
// unfamiliar positive request to analyze something new into read-only delivery.
const newOrAmbiguousAnalysis = /分析(?!结果|输出|定义|步骤|逻辑|过程|文档|任务|单元|了(?:什么|哪些|多少)|出(?:了)?(?:什么|哪些|多少)|的是|什么|哪些|的)/u;
const noRun = /(?:不要|不必|不用|无需|禁止|不能|不允许|别|不)(?:再|去|自动|重新)?(?:重跑|运行|执行)|\b(?:do not|don't|without)\s+(?:run|running|execute|executing)\b/iu;
const currentSubject = /当前|现在|现有|已有|已经|刚才|刚刚|上次|这些|这个|本次|Notebook|单元|\bcell\b|\bsql\b|图表|变量|结果|输出|字段|血缘|上游|下游/iu;
const asksExplanation = /解释|说明|查看|读取|检索|查找|看看|看一下|告诉我|描述|总结|是什么|什么|哪些|多少|怎么样|为什么|含义|来源|依赖|\b(?:explain|describe|inspect|show|what|which|how many)\b/iu;
const asksResult = /结果|输出|数值|数额|金额|收入|订单|销售|合计|总计|统计|平均|最大|最小|多少|趋势|分析(?:了|出|出来)|\b(?:result|output|value|total|amount|count)\b/iu;

/** Conservative task routing, not a language-complete classifier or authorization. */
export function resolveDshReadonlyMode(request: HarnessRequest): DshReadonlyMode | undefined {
  if (!request.notebookContext) return;
  const instruction = request.instruction.trim();
  const positive = instruction.replace(prohibitedAction, "");
  if (mutation.test(positive) || newOrAmbiguousAnalysis.test(positive)) return;
  if (!isNotebookInspection(request) && !(currentSubject.test(instruction) && asksExplanation.test(instruction))) return;
  const allowRun = !noRun.test(instruction);
  return { allowRun, requireOutput: allowRun && asksResult.test(instruction) };
}

/** A terminal delivery option, never a read-only tool-routing decision.
 * Match the whole simple request; additional objectives and unfamiliar wording
 * deliberately retain the draft contract. Names cannot smuggle a second task.
 */
export function isDshExistingAnalysisRequest(request: HarnessRequest): boolean {
  if (!request.notebookContext) return false;
  const instruction = request.instruction.trim().replace(/[。！!？?]$/u, "").trim();
  const match = /^(?:请\s*)?(?:(?:帮我|为我|替我)\s*)?分析(?:一下|下)?\s*(.+)$/u.exec(instruction);
  if (!match || noRun.test(instruction)) return false;
  const subject = match[1].trim();
  // Even an exact selected name is not treated as an instruction if it contains
  // action/goal wording. False negatives here preserve the original contract.
  if (/创建|新增|增加|添加|生成|制作|编辑|修改|改动|改成|改为|改名|重命名|调整|移动|更改|更新|删除|移除|替换|修复|导出|下载|保存|发布|重新|重做|图表|统计|计算|预测|对比|比较|汇总|筛选|排序|增长|提高|降低|[，,;；\n\r]/u.test(subject)) return false;
  if (/^(?:(?:当前选中|当前|这份|这个|该|选中|本次上传|已上传|上传)(?:的)?)?(?:文件|数据|数据集)$/u.test(subject)) return true;
  const named = /^(?:文件|数据集|数据)?[“"「]?(.+?)[”"」]?(?:的)?(?:文件|数据集|数据)$/u.exec(subject);
  if (!named) return false;
  const name = named[1].trim();
  const sourceIds = new Set(request.notebookContext.sourceIds);
  const names = request.appSpec.dataSources.filter(source => sourceIds.has(source.id)).map(source => source.name);
  if (request.rawWorkbookManifest) names.push(request.rawWorkbookManifest.fileName);
  // Neither arbitrary ASCII names nor fuzzy workbook/sheet prefixes identify
  // a selected source. Only an exact name (optionally without extension) does.
  const basename = (value: string) => value.replace(/\.(?:csv|xlsx?|tsv)$/iu, "");
  return names.some(candidate => candidate === name || basename(candidate) === basename(name));
}

/** The complete private attempt ledger, not just unchanged formal state, must
 * prove that no edit/submit/other capability was tried, including failed calls.
 */
export function canDeliverDshExistingAnalysisAnswer(attempts: readonly DshAnalysisToolAttempt[]): boolean {
  let definitionRead = false;
  let ran = false;
  let searchNeedsRecovery = false;
  for (const attempt of attempts) {
    if ((attempt.toolName !== "cellSearch" && attempt.toolName !== "runNotebookCells") || attempt.status === "running") return false;
    if (attempt.status === "failure") {
      if (attempt.toolName !== "cellSearch" || attempt.recoverableSearchFailure !== true) return false;
      searchNeedsRecovery = true;
    } else if (attempt.toolName === "cellSearch") {
      definitionRead = true;
      searchNeedsRecovery = false;
    } else ran = true;
  }
  return definitionRead && ran && !searchNeedsRecovery;
}

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const identifier = (value: unknown, maximum = 160): value is string => typeof value === "string" && value.length > 0 && value.length <= maximum;
const nonnegative = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const genericAnswer = /^(?:(?:已|已经)?(?:完成|完成了|分析完成|任务完成|处理完成|检查完成|分析已完成|任务已完成|处理已完成|检查已完成)|done|completed|analysis complete)[。.!！\s]*$/iu;

function definitionRead(data: Record<string, unknown>) {
  if (!nonnegative(data.totalCells) || !nonnegative(data.matchedCount) || data.matchedCount > data.totalCells || !Array.isArray(data.cells)) return false;
  if (data.totalCells === 0) return data.matchedCount === 0 && data.cells.length === 0;
  return data.matchedCount > 0 && data.cells.length > 0 && data.cells.every(cell => record(cell) && identifier(cell.id, 120));
}

function validRun(data: Record<string, unknown>) {
  return data.status === "success" && identifier(data.runId) && nonnegative(data.editVersion)
    && Array.isArray(data.completedCellIds) && data.completedCellIds.length > 0
    && data.completedCellIds.every(id => identifier(id, 120));
}

function matchedOutput(data: Record<string, unknown>, run: Record<string, unknown> | undefined) {
  const output = data.output;
  if (!run || data.editVersion !== run.editVersion || !record(output) || output.availability !== "available"
    || output.runId !== run.runId || !identifier(output.cellId, 120) || !Array.isArray(run.completedCellIds)
    || !run.completedCellIds.includes(output.cellId) || !Array.isArray(output.rows) || !Array.isArray(output.fields)
    || !nonnegative(output.rowCount) || !nonnegative(output.availableRows) || output.rows.length > output.availableRows
    || output.availableRows > output.rowCount || typeof output.resultComplete !== "boolean" || typeof output.tableTruncated !== "boolean") return false;
  const reference = output.resultRef;
  return record(reference) && reference.accessMode === "ai" && reference.runId === run.runId
    && reference.cellId === output.cellId && identifier(reference.resultId, 240) && nonnegative(reference.revision);
}

/** runNotebookCells already returns bounded result samples, not only a status.
 * The run owns editVersion; result references own the formal base revision.
 * Those two version numbers are intentionally not interchangeable.
 */
function matchedRunResults(run: Record<string, unknown>, definitionVersion: number | undefined, baseRevision: number | undefined) {
  if (definitionVersion === undefined || baseRevision === undefined || run.editVersion !== definitionVersion
    || !Array.isArray(run.results) || !run.results.length || run.results.length > 3
    || !Array.isArray(run.completedCellIds)) return false;
  const completedCellIds = run.completedCellIds;
  const cells = new Set<string>();
  return run.results.every(result => {
    if (!record(result) || !identifier(result.cellId, 120) || cells.has(result.cellId)
      || !completedCellIds.includes(result.cellId) || !Array.isArray(result.rows) || result.rows.length > 5
      || !nonnegative(result.returnedRows) || result.rows.length !== Math.min(5, result.returnedRows)) return false;
    cells.add(result.cellId);
    const table = dataTableSchema.safeParse({ fields: result.fields, rows: result.rows, truncated: result.truncated });
    const reference = notebookResultReferenceSchema.safeParse(result.resultRef);
    if (!table.success || !reference.success) return false;
    const ref = reference.data;
    return identifier(ref.resultId, 240) && ref.runId === run.runId && ref.cellId === result.cellId
      && ref.revision === baseRevision && ref.accessMode === "ai" && ref.rowCount >= result.returnedRows
      && result.truncated === (!ref.complete || ref.rowCount > result.returnedRows);
  });
}

/** Verifies task-owned evidence and output boundaries, not every natural-language claim. */
export function verifyDshReadonlyAnswer(input: {
  mode: DshReadonlyMode;
  finalResponse?: string;
  observations: readonly DshReadonlyObservation[];
  formalUnchanged: boolean;
  failedTools: readonly string[];
}): { valid: boolean; message: string; evidenceIds: string[]; issue: string } {
  const fail = (issue: string) => ({ valid: false, message: "", evidenceIds: [], issue });
  if (!input.formalUnchanged) return fail("正式 Notebook 或看板已变化，不能作为只读回答交付。");
  if (!input.mode.allowRun && input.mode.requireOutput) return fail("只读回答的执行范围不一致。");
  if (typeof input.finalResponse !== "string" || !input.finalResponse.trim() || input.finalResponse.length > 1_800) {
    return fail("缺少有效的只读回答，或回答超过显示上限。");
  }
  const answer = sanitizeHarnessText(input.finalResponse.trim(), "").trim();
  if (!answer || genericAnswer.test(answer)) return fail("只读回答过于笼统，尚未说明当前 Notebook。");
  if (input.failedTools.some(name => name !== "cellSearch")) return fail("本次存在运行失败或不允许的工具调用，不能宣告只读分析完成。");
  const ids = new Set<string>();
  let hasDefinition = false;
  let hasOutput = false;
  let latestRun: Record<string, unknown> | undefined;
  let definitionVersion: number | undefined;
  let baseRevision: number | undefined;
  for (const observation of input.observations) {
    if (!identifier(observation.toolCallId) || ids.has(observation.toolCallId) || !record(observation.data)) return fail("本任务工具证据无效或重复。");
    ids.add(observation.toolCallId);
    if (observation.toolName === "runNotebookCells") {
      if (!input.mode.allowRun || !validRun(observation.data)) return fail("本次运行未获允许或没有成功回执。");
      latestRun = observation.data;
      // A newer run invalidates previous evidence, but its own validated result
      // sample needs no redundant cellSearch output call to become evidence.
      hasOutput = matchedRunResults(latestRun, definitionVersion, baseRevision);
    } else if (observation.toolName === "cellSearch") {
      if (definitionRead(observation.data)) {
        hasDefinition = true;
        if (nonnegative(observation.data.editVersion)) definitionVersion = observation.data.editVersion;
        if (nonnegative(observation.data.baseRevision)) baseRevision = observation.data.baseRevision;
      }
      hasOutput ||= matchedOutput(observation.data, latestRun);
    } else return fail("只读任务调用了修改、提交或其他范围外工具，不能作为只读回答交付。");
  }
  if (!hasDefinition) return fail("尚未成功读取匹配单元或明确确认空 Notebook，不能只凭模型文字回答。");
  if (input.mode.requireOutput && !hasOutput) return fail("结果问题缺少本任务成功运行及同版本、同运行的 AI 结果或输出证据。");
  const scope = input.mode.requireOutput
    ? "只读回答：依据本轮成功运行返回或检索读取的结果，范围以实际返回数据为准；未修改步骤或看板。"
    : "只读说明：依据本轮读取的单元定义；不代表数值结果已经验证，未修改步骤或看板。";
  const notice = input.finalResponse.trim().length > 1_000 && answer.length === 1_000 ? "\n（回答已按显示上限截取。）" : "";
  return { valid: true, message: `${scope}\n${answer}${notice}`,
    evidenceIds: [...ids].slice(-15), issue: "" };
}
