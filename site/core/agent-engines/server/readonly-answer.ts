import type { HarnessRequest } from "@/core/harness/contracts";
import { isNotebookInspection } from "@/core/harness/notebook-cell-tools";
import { redactHarnessSecrets } from "@/core/harness/security";
import { dataTableSchema } from "@/core/datasets/table-contracts";
import { notebookResultReferenceSchema } from "@/core/notebook/contracts";
import { hasCompleteParameterSources, resolveDshParameterInspection,
  type DshParameterInspection, type DshParameterSourceEvidence } from "./parameter-inspection";

export interface DshReadonlyMode { allowRun: boolean; requireOutput: boolean; parameterInspection?: DshParameterInspection }
export interface DshReadonlyObservation {
  toolCallId: string; toolName: string; data: unknown;
  /** Private engine ledger: parsed actual tool arguments, never model receipts. */
  sourceOffset?: number;
}
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
const conclusionCue = /结论|总结|概括|归纳/u;
const additionalGoal = /创建|新增|增加|添加|生成|制作|编辑|修改|改动|改成|改为|改名|重命名|调整|移动|更改|更新|删除|移除|替换|修复|导出|下载|保存|发布|重新|重做|图表|统计|计算|预测|对比|比较|汇总|筛选|排序|增长|提高|降低|[，,;；\n\r]/u;

function isSelectedAnalysisSource(request: HarnessRequest, subject: string): boolean {
  if (!request.notebookContext || additionalGoal.test(subject)) return false;
  const named = /^(?:文件|数据集|数据)?[“"「]?(.+?)[”"」]?(?:的)?\s*(?:文件|数据集|数据)$/u.exec(subject);
  if (!named) return false;
  const name = named[1].trim();
  const sourceIds = new Set(request.notebookContext.sourceIds);
  const names = request.appSpec.dataSources.filter(source => sourceIds.has(source.id)).map(source => source.name);
  if (request.rawWorkbookManifest) names.push(request.rawWorkbookManifest.fileName);
  const basename = (value: string) => value.replace(/\.(?:csv|xlsx?|tsv)$/iu, "");
  return names.some(candidate => candidate === name || basename(candidate) === basename(name));
}

function isExistingConclusionSubject(request: HarnessRequest, text: string): boolean {
  const subject = text.trim().replace(/的$/u, "").trim();
  if (/^(?:(?:当前选中|当前|现在|现有|已有|刚才|刚刚|上次|本次|这次|这个|这些|这份|该|选中|本次上传|已上传|上传)的?)?(?:Notebook|笔记本|单元|步骤|分析|结果|输出|文件|数据集|数据)?(?:的?分析)?(?:的?(?:结果|输出))?$/iu.test(subject)) return true;
  // A named subject must resolve to the selected metadata, never a fuzzy name
  // or a new calculation target that happens to contain the word "conclusion".
  const source = subject.replace(/(?:的)?分析(?:的)?(?:结果|输出)?$/u, "").replace(/的$/u, "").trim();
  return isSelectedAnalysisSource(request, source);
}

/** Parse the complete speech act, not a keyword exception to mutation rules.
 * Only polite look-at preambles, explicit prohibitions and requests to state
 * or summarize the current analysis are consumed. Any remaining clause keeps
 * the normal task contract, including additional computation/export goals.
 */
function existingConclusionRequestKind(request: HarnessRequest): "definition" | "result" | undefined {
  let kind: "definition" | "result" | undefined;
  const clauses = request.instruction.trim().replace(/\.$/u, "").split(/[，,。!！?？;；\n\r]+/u).map(clause => clause.trim()).filter(Boolean);
  for (const clause of clauses) {
    const text = clause.replace(/^(?:(?:请|麻烦|帮我|替我|为我|能不能|能否|可否|可以|是否可以)\s*)+/u, "")
      .replace(/(?:好吗|可以吗|吗|呢|吧)$/u, "").trim();
    if (/^(?:不要|不必|不用|无需|禁止|不能|不允许|别|不)(?:再|去|自动|重新)?(?:重跑|运行|执行|修改|编辑|改动|创建|新增|添加|生成|删除|导出|保存)(?:当前|已有|现有)?(?:的)?(?:Notebook|笔记本|单元|步骤|图表|文件|结果)?$/iu.test(text)) continue;
    const preamble = /^(?:看看|看一下|看一看)\s*(.*)$/u.exec(text);
    if (preamble && !conclusionCue.test(preamble[1]) && isExistingConclusionSubject(request, preamble[1])) continue;
    // Preserve explicit current-definition questions: a field named "结论"
    // is not an output request. The whole clause still has to name a current
    // Notebook/SQL/cell object and a structural property, with no extra goal.
    const definition = /^(?:解释|说明|查看|总结|概括|归纳)(?:一下|下)?\s*(?:(?:当前|现有|已有|这个|这些)的?)?(?:Notebook|笔记本|SQL|单元|步骤)(?:的|里的|中的)?(?:([\p{L}\p{N}_-]{1,80})字段的?)?(?:结构|定义|逻辑|作用|来源|依赖|血缘|含义)$/iu.exec(text);
    if (definition && !additionalGoal.test(text) && !/并|然后|再|同时|顺便|读取|检索|查找|搜索/u.test(definition[1] ?? "")) {
      kind ??= "definition";
      continue;
    }
    const basedOn = /^(?:根据|基于)\s*(.*?)\s*(?:给我|给出|提供)\s*(?:一个|一份)?\s*(.*?)\s*(?:结论|总结)$/u.exec(text);
    if (basedOn && isExistingConclusionSubject(request, basedOn[1]) && isExistingConclusionSubject(request, basedOn[2])) { kind = "result"; continue; }
    const delivery = /^(?:给我|给出|提供|告诉我|说明|解释|查看|看看|看一下)\s*(?:一个|一份|一下)?\s*(.*?)\s*(?:结论|总结)$/u.exec(text);
    const summary = /^(?:总结|概括|归纳)(?:一下|下)?\s*(.*?)$/u.exec(text);
    const question = /^(.*?)\s*结论(?:是什么|怎么样|有哪些)$/u.exec(text);
    const subject = delivery?.[1] ?? summary?.[1] ?? question?.[1];
    if (subject === undefined || !isExistingConclusionSubject(request, subject)) return;
    kind = "result";
  }
  return kind;
}

/** Conservative task routing, not a language-complete classifier or authorization. */
export function resolveDshReadonlyMode(request: HarnessRequest): DshReadonlyMode | undefined {
  if (!request.notebookContext) return;
  const parameterInspection = resolveDshParameterInspection(request);
  if (parameterInspection) return { allowRun: false, requireOutput: false, parameterInspection };
  const instruction = request.instruction.trim();
  // Conclusion requests imply the current Notebook even without a deictic
  // word, and need fresh output rather than a definition-only explanation.
  // Failed whole-clause recognition must not fall through to keyword routing.
  if (conclusionCue.test(instruction)) {
    const kind = existingConclusionRequestKind(request);
    if (!kind) return;
    const allowRun = !noRun.test(instruction);
    return { allowRun, requireOutput: allowRun && kind === "result" };
  }
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
  if (additionalGoal.test(subject)) return false;
  if (/^(?:(?:当前选中|当前|这份|这个|该|选中|本次上传|已上传|上传)(?:的)?)?(?:文件|数据|数据集)$/u.test(subject)) return true;
  // Neither arbitrary ASCII names nor fuzzy workbook/sheet prefixes identify
  // a selected source. Only an exact name (optionally without extension) does.
  return isSelectedAnalysisSource(request, subject);
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

function matchedOutput(data: Record<string, unknown>, run: Record<string, unknown> | undefined, parameterCellIds: ReadonlySet<string>) {
  const output = data.output;
  if (!run || data.editVersion !== run.editVersion || !record(output) || output.availability !== "available"
    || output.runId !== run.runId || !identifier(output.cellId, 120) || parameterCellIds.has(output.cellId) || !Array.isArray(run.completedCellIds)
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
function matchedRunResults(run: Record<string, unknown>, definitionVersion: number | undefined, baseRevision: number | undefined,
  parameterCellIds: ReadonlySet<string>) {
  if (definitionVersion === undefined || baseRevision === undefined || run.editVersion !== definitionVersion
    || !Array.isArray(run.results) || !run.results.length || run.results.length > 3
    || !Array.isArray(run.completedCellIds)) return false;
  const completedCellIds = run.completedCellIds;
  const cells = new Set<string>();
  const valid = run.results.every(result => {
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
  // A parameter's successful value-table is input evidence, not a business
  // result. Still validate every returned sample, including parameter samples.
  return valid && [...cells].some(cellId => !parameterCellIds.has(cellId));
}

/** A conversation with no edit attempts already owns the original document
 * revision and editVersion=0. A real run of that document need not manufacture
 * a preceding definition lookup. Classic readonly intent validation below is
 * intentionally unchanged; this validates actual bridge receipts only.
 */
export function verifyDshCurrentRunEvidence(input: {
  observations: readonly DshReadonlyObservation[];
  baseRevision: number | undefined;
  parameterCellIds: readonly string[];
}): { valid: boolean; evidenceIds: string[]; issue: string } {
  const fail = (issue: string) => ({ valid: false, evidenceIds: [], issue });
  if (!nonnegative(input.baseRevision)) return fail("没有本轮正式 Notebook 修订基线，无法核对计算回执。");
  const ids = new Set<string>();
  const parameters = new Set(input.parameterCellIds);
  let latestRun: Record<string, unknown> | undefined;
  let hasOutput = false;
  for (const observation of input.observations) {
    if (!identifier(observation.toolCallId) || ids.has(observation.toolCallId) || !record(observation.data)) {
      return fail("本轮工具证据无效或重复。");
    }
    ids.add(observation.toolCallId);
    const data = observation.data;
    if (observation.toolName === "runNotebookCells") {
      if (!validRun(data) || data.editVersion !== 0) return fail("本轮未取得未修改文档的成功运行回执。");
      latestRun = data;
      hasOutput = matchedRunResults(data, 0, input.baseRevision, parameters);
    } else if (observation.toolName === "cellSearch") {
      if (matchedOutput(data, latestRun, parameters) && record(data.output) && record(data.output.resultRef)
        && data.output.resultRef.revision === input.baseRevision) hasOutput = true;
    } else return fail("本轮结果证据包含不允许的工具类型。");
  }
  if (!latestRun || !hasOutput) return fail("尚未取得本轮成功运行的有效业务结果，不能宣告数值分析完成。");
  return { valid: true, evidenceIds: [...ids].slice(-15), issue: "" };
}

/** Verifies task-owned evidence and output boundaries, not every natural-language claim. */
export function verifyDshReadonlyAnswer(input: {
  mode: DshReadonlyMode;
  finalResponse?: string;
  observations: readonly DshReadonlyObservation[];
  formalUnchanged: boolean;
  failedTools: readonly string[];
  /** Captured from the task's original formal definition, never model output. */
  parameterCellIds?: readonly string[];
  parameterSourceEvidence?: DshParameterSourceEvidence;
}): { valid: boolean; message: string; evidenceIds: string[]; issue: string } {
  const fail = (issue: string) => ({ valid: false, message: "", evidenceIds: [], issue });
  if (!input.formalUnchanged) return fail("正式 Notebook 或看板已变化，不能作为只读回答交付。");
  if (!input.mode.allowRun && input.mode.requireOutput) return fail("只读回答的执行范围不一致。");
  if (input.mode.parameterInspection && (input.mode.allowRun || input.mode.requireOutput)) return fail("参数定义问答不能授权运行或宣称业务结果。");
  if (typeof input.finalResponse !== "string" || !input.finalResponse.trim()) {
    return fail("缺少有效的只读回答。");
  }
  const answer = redactHarnessSecrets(input.finalResponse.trim()).trim();
  if (!answer || genericAnswer.test(answer)) return fail("只读回答过于笼统，尚未说明当前 Notebook。");
  if (input.failedTools.some(name => name !== "cellSearch")) return fail("本次存在运行失败或不允许的工具调用，不能宣告只读分析完成。");
  const ids = new Set<string>();
  const parameterCellIds = new Set(input.parameterCellIds ?? []);
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
      hasOutput = matchedRunResults(latestRun, definitionVersion, baseRevision, parameterCellIds);
    } else if (observation.toolName === "cellSearch") {
      if (definitionRead(observation.data)) {
        hasDefinition = true;
        if (nonnegative(observation.data.editVersion)) definitionVersion = observation.data.editVersion;
        if (nonnegative(observation.data.baseRevision)) baseRevision = observation.data.baseRevision;
      }
      hasOutput ||= matchedOutput(observation.data, latestRun, parameterCellIds);
    } else return fail("只读任务调用了修改、提交或其他范围外工具，不能作为只读回答交付。");
  }
  if (!hasDefinition) return fail("尚未成功读取匹配单元或明确确认空 Notebook，不能只凭模型文字回答。");
  if (input.mode.parameterInspection && !hasCompleteParameterSources(input.mode.parameterInspection, input.parameterSourceEvidence, input.observations)) {
    return fail("参数定义问题尚未完整读取所有目标参数的本任务同版本源码；摘要、历史值或不完整分页不能作为当前值证据。");
  }
  if (input.mode.requireOutput && !hasOutput) return fail("结果问题缺少本任务成功运行及同版本、同运行的 AI 结果或输出证据。");
  const scope = input.mode.parameterInspection
    ? "参数定义说明：依据本轮完整读取的当前参数配置，参数值是分析输入，不是业务计算结果；未运行或修改 Notebook 与看板。"
    : input.mode.requireOutput
    ? "只读回答：依据本轮成功运行返回或检索读取的结果，范围以实际返回数据为准；未修改步骤或看板。"
    : "只读说明：依据本轮读取的单元定义；不代表数值结果已经验证，未修改步骤或看板。";
  return { valid: true, message: `${scope}\n${answer}`,
    evidenceIds: [...ids].slice(-15), issue: "" };
}
