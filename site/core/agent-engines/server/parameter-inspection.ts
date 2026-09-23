import type { HarnessRequest } from "@/core/harness/contracts";

export interface DshParameterInspection { cellIds: readonly string[] }

function unquote(value: string): string {
  const pairs: Readonly<Record<string, string>> = { '"': '"', "'": "'", "`": "`", "“": "”", "「": "」" };
  return pairs[value[0]] === value.at(-1) ? value.slice(1, -1).trim() : value;
}

/** Complete parameter-definition questions only. Names are exact metadata,
 * never executable patterns; unconsumed clauses retain the normal contract. */
export function resolveDshParameterInspection(request: HarnessRequest): DshParameterInspection | undefined {
  const notebook = request.notebookContext;
  if (!notebook) return;
  const parameters = notebook.document.cells.filter(cell => cell.kind === "parameter");
  if (!parameters.length) return;
  const ids = new Set<string>();
  const clauses = request.instruction.trim().replace(/\.$/u, "").split(/[，,。!！?？;；\n\r]+/u).map(clause => clause.trim()).filter(Boolean);
  for (const clause of clauses) {
    const text = clause.replace(/^(?:(?:请|麻烦|帮我|替我|能不能|能否|可否|可以)\s*)+/u, "")
      .replace(/^please\s+/iu, "").replace(/(?:好吗|吗|呢|吧)$/u, "").trim();
    if (/^(?:不要|不用|无需|禁止|别)(?:再|重新)?(?:运行|执行|修改|编辑|删除|保存)(?:当前|已有|现有)?(?:的)?(?:Notebook|笔记本|参数|单元|步骤)?$/iu.test(text)
      || /^(?:do not|don't)\s+(?:run|execute|modify|edit|delete|save)(?:\s+(?:the\s+)?(?:notebook|cells?|parameters?))?$/iu.test(text)) continue;

    const chinese = /^(.+?)(?:的)?有哪些(?:选项|可选值)$/u.exec(text)
      ?? /^(?:(?:查看|读取|说明|解释|告诉我|列出|显示)(?:一下|下)?\s*)?(.+?)(?:的)?(?:当前值|值|类型|配置|可选值|选项|输出变量名|输出变量|输出名)(?:是(?:什么|多少)|有哪些)?$/u.exec(text);
    const english = /^(?:show|list|read|explain|describe)\s+(?:the\s+)?(.+?)\s+(?:current\s+)?(?:values?|types?|configuration|options|output\s+(?:name|variable)s?)$/iu.exec(text)
      ?? /^what\s+(?:is|are)\s+(?:the\s+)?(?:current\s+)?(?:values?|types?|configuration|options|output\s+(?:name|variable)s?)\s+of\s+(.+)$/iu.exec(text);
    let subject = (chinese?.[1] ?? english?.[1])?.trim().replace(/的$/u, "").trim();
    if (!subject) return;
    subject = subject.replace(/^(?:当前|现有|已有)?\s*(?:Notebook|笔记本)\s*的?\s*/iu, "");
    const selected = /^(?:当前)?(?:所选|选中)(?:的)?参数(?:单元)?$/u.test(subject)
      || /^(?:the\s+)?(?:currently\s+)?selected\s+parameters?(?:\s+cells?)?$/iu.test(subject);
    const all = /^(?:(?:当前|现在|现有|已有|所有|全部)(?:的)?)?参数(?:单元)?$/u.test(subject)
      || /^(?:the\s+)?(?:(?:current|existing|all)\s+)?parameters?(?:\s+cells?)?$/iu.test(subject);
    if (selected || all) {
      const selectedIds = new Set(notebook.selectedCellIds ?? []);
      const matches = parameters.filter(cell => !selected || selectedIds.has(cell.id));
      if (!matches.length) return;
      for (const cell of matches) ids.add(cell.id);
      continue;
    }
    const named = /^(?:(?:当前|现有|已有)(?:的)?)?参数(?:单元)?\s*(.+)$/u.exec(subject)
      ?? /^(?:the\s+)?(?:(?:current|existing)\s+)?parameter(?:\s+cell)?\s+(.+)$/iu.exec(subject);
    if (!named) return;
    const rawName = named[1].trim(), name = unquote(rawName);
    // Unquoted action-like names must not swallow a second user objective.
    // Quoted exact titles remain metadata, never instructions to the engine.
    if (rawName === name && /并|然后|再|同时|顺便|计算|分析|创建|新增|修改|删除|导出|保存|运行|执行|\b(?:and|then|also|run|execute|calculate|analy[sz]e|create|add|edit|modify|update|delete|remove|export|save)\b/iu.test(name)) return;
    const matches = parameters.filter(cell => cell.id === name || cell.outputName === name || cell.title === name);
    if (matches.length !== 1) return;
    ids.add(matches[0].id);
  }
  return ids.size ? { cellIds: [...ids] } : undefined;
}

export interface DshParameterSourceEvidence {
  baseRevision: number;
  /** Original source captured privately by the engine, not model-supplied data. */
  sourceById: ReadonlyMap<string, string>;
}

/** A summary or a trailing page cannot prove the current value. Match every
 * page against the task's original definition, then require complete coverage.
 * Offsets come from validated tool arguments recorded by the engine. */
export function hasCompleteParameterSources(inspection: DshParameterInspection, evidence: DshParameterSourceEvidence | undefined,
  observations: readonly { toolName: string; data: unknown; sourceOffset?: number }[]): boolean {
  if (!evidence || !inspection.cellIds.length) return false;
  for (const cellId of inspection.cellIds) {
    const expected = evidence.sourceById.get(cellId);
    if (!expected) return false;
    const spans: { start: number; end: number }[] = [];
    for (const observation of observations) {
      const data = observation.data;
      if (observation.toolName !== "cellSearch" || !data || typeof data !== "object"
        || !("sourceCellId" in data) || data.sourceCellId !== cellId) continue;
      const start = observation.sourceOffset;
      if (typeof start !== "number" || !Number.isSafeInteger(start) || start < 0 || start >= expected.length
        || !("editVersion" in data) || data.editVersion !== 0
        || !("baseRevision" in data) || data.baseRevision !== evidence.baseRevision) return false;
      // cellSearch may shorten a page to fit its serialized result budget.
      if (!("source" in data) || typeof data.source !== "string" || !data.source.length || data.source.length > 2_000) return false;
      const end = start + data.source.length, truncated = end < expected.length;
      if (end > expected.length || data.source !== expected.slice(start, end)
        || !("sourceTruncated" in data) || data.sourceTruncated !== truncated
        || !("nextSourceOffset" in data) || data.nextSourceOffset !== (truncated ? end : null)) return false;
      spans.push({ start, end });
    }
    let covered = 0;
    for (const span of spans.sort((left, right) => left.start - right.start)) {
      if (span.start > covered) return false;
      covered = Math.max(covered, span.end);
    }
    if (covered !== expected.length) return false;
  }
  return true;
}
