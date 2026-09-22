import { describe, expect, it, vi } from "vitest";
import type { DataTable } from "@/core/datasets/table-contracts";
import type { NotebookCell } from "./definition";
import type { NotebookDocument, NotebookRun } from "./contracts";
import { notebookFingerprint } from "./client-state";
import { selectParameterRecompute } from "./parameter-recompute";
import { cacheNotebookRun, invalidateNotebookCachedResults, isNotebookCachedResultFresh, type NotebookResultCache } from "./result-cache";
import { executeNotebook } from "./server/execution";
import { executeNotebookSql } from "./server/query-engine";

const parameter = (value = 1): Extract<NotebookCell, { kind: "parameter" }> => ({ id: "minimum", kind: "parameter", title: "参数", outputName: "minimum", parameter: { type: "number", value } });
const shared: NotebookCell = { id: "shared", kind: "warehouseSql", title: "共享输入", connectionId: "authorized", outputName: "shared", sql: "SELECT value FROM synthetic" };
const table = (values: number[]): DataTable => ({ fields: [{ name: "value", label: "value", type: "number" }], rows: values.map((value) => ({ value })), truncated: false });
function document(value = 1): NotebookDocument {
  return { name: "合成缓存", revision: value, cells: [
    parameter(value), shared,
    { id: "changed", kind: "sql", title: "受影响", inputCellIds: ["shared", "minimum"], outputName: "changed", sql: "SELECT SUM(s.value) + MAX(p.value) AS value FROM shared s CROSS JOIN minimum p" },
    { id: "text", kind: "text", title: "受控说明", markdown: "合计 {{total}}", references: [{ key: "total", cellId: "changed", field: "value" }] },
    { id: "sibling", kind: "table", title: "独立消费分支", inputCellId: "shared", columns: ["value"] },
    { id: "standalone", kind: "text", title: "静态说明", markdown: "保持原样" },
  ] };
}
const fingerprint = (doc: NotebookDocument) => (id: string) => notebookFingerprint(doc, id, [], []);
async function run(doc: NotebookDocument, values = [10], targetCellId?: string) {
  return executeNotebook({ document: doc, sources: [], targetCellId, connectionQuery: async () => table(values) }, { query: executeNotebookSql, log: vi.fn() });
}
const fresh = (id: string, cache: NotebookResultCache, doc: NotebookDocument) => isNotebookCachedResultFresh(id, cache, { fingerprint: fingerprint(doc) });

describe("Notebook 有界运行缓存", () => {
  it("从真实SQL运行的同批回执绑定直接输入，不保存历史表或递归复制祖先", async () => {
    const doc = document(); const receipt = await run(doc); const original = structuredClone(receipt);
    const cached = cacheNotebookRun(doc, receipt, fingerprint(doc));
    expect(cached.changed.inputs).toEqual([
      { cellId: "shared", runId: receipt.runId, resultId: `${receipt.runId}:shared`, dataSignature: receipt.cells[1].resultRef!.dataSignature, complete: true },
      { cellId: "minimum", runId: receipt.runId, resultId: `${receipt.runId}:minimum`, dataSignature: receipt.cells[0].resultRef!.dataSignature, complete: true },
    ]);
    expect(cached.text.inputs).toHaveLength(1);
    expect(cached.text.inputs[0]).toMatchObject({ cellId: "changed", complete: true });
    expect(cached.text.result.text).toBe("合计 11");
    expect(cached.text.result).not.toHaveProperty("table");
    for (const item of Object.values(cached)) {
      expect(fresh(item.result.cellId, cached, doc)).toBe(true);
      expect(item.inputs.length).toBeLessThanOrEqual(10);
      for (const witness of item.inputs) expect(Object.keys(witness).sort()).toEqual(["cellId", "complete", "dataSignature", "resultId", "runId"]);
    }
    expect(receipt).toEqual(original);
  }, 15_000);

  it("参数改变后共享祖先runId变化但完整内容相同，保留独立分支；受控文本使用新结果", async () => {
    const initial = document(); const initialRun = await run(initial);
    const oldCache = cacheNotebookRun(initial, initialRun, fingerprint(initial)); const oldSnapshot = structuredClone(oldCache);
    const next = document(2); const selected = selectParameterRecompute(next, ["minimum"]);
    expect(selected.executionCellIds).toEqual(["minimum", "shared", "changed", "text"]);
    const invalidated = invalidateNotebookCachedResults(oldCache, selected.affectedCellIds);
    expect(fresh("changed", invalidated, next)).toBe(false);
    expect(fresh("sibling", invalidated, next)).toBe(true);
    const nextRun = await run(selected.document);
    const merged = { ...invalidated, ...cacheNotebookRun(selected.document, nextRun, fingerprint(next)) };
    expect(merged.shared.result.resultRef!.resultId).not.toBe(oldCache.shared.result.resultRef!.resultId);
    expect(merged.shared.result.resultRef!.dataSignature).toBe(oldCache.shared.result.resultRef!.dataSignature);
    expect(merged.sibling).toBe(oldCache.sibling);
    for (const id of ["minimum", "shared", "changed", "text", "sibling", "standalone"]) expect(fresh(id, merged, next)).toBe(true);
    expect(merged.text.result.text).toBe("合计 12");
    expect(merged.sibling.identity.runId).toBe(initialRun.runId);
    expect(Object.keys(merged)).toHaveLength(initial.cells.length);
    expect(oldCache).toEqual(oldSnapshot);
  }, 15_000);

  it("完整输入真实变化，即使前1000行预览相同，未执行的共享分支也必须过期", async () => {
    const values = Array.from({ length: 1001 }, (_, index) => index);
    const first = document(); const initialRun = await run(first, values);
    const initial = cacheNotebookRun(first, initialRun, fingerprint(first));
    const next = document(2), selected = selectParameterRecompute(next, ["minimum"]);
    const changedValues = [...values]; changedValues[1000] = 99999;
    const nextRun = await run(selected.document, changedValues);
    const updated = cacheNotebookRun(selected.document, nextRun, fingerprint(next));
    expect(updated.shared.result.table).toEqual(initial.shared.result.table);
    expect(updated.shared.result.resultRef!.dataSignature).not.toBe(initial.shared.result.resultRef!.dataSignature);
    const merged = { ...invalidateNotebookCachedResults(initial, selected.affectedCellIds), ...updated };
    expect(fresh("text", merged, next)).toBe(true);
    expect(fresh("sibling", merged, next)).toBe(false);
    expect(fresh("standalone", merged, next)).toBe(true);
  }, 15_000);

  it("手动明确失效的兄弟不会因新祖先内容相同自动复活", async () => {
    const doc = document(); const initial = cacheNotebookRun(doc, await run(doc), fingerprint(doc));
    const invalidated = invalidateNotebookCachedResults(initial, ["shared", "changed", "text", "sibling"]);
    const selected = selectParameterRecompute(doc, ["minimum"]);
    const merged = { ...invalidated, ...cacheNotebookRun(selected.document, await run(selected.document), fingerprint(doc)) };
    expect(fresh("changed", merged, doc)).toBe(true);
    expect(fresh("sibling", merged, doc)).toBe(false);
    expect(initial.sibling).not.toHaveProperty("invalidated");
  }, 15_000);

  it("同一结果直接依赖去重，文本复用同一输入不同字段不扩大历史", async () => {
    const doc: NotebookDocument = { name: "文本", revision: 0, cells: [parameter(), {
      id: "note", title: "note", kind: "text", markdown: "{{a}} / {{b}}",
      references: [{ key: "a", cellId: "minimum", field: "value" }, { key: "b", cellId: "minimum", field: "value" }],
    }] };
    const receipt = await run(doc); const cached = cacheNotebookRun(doc, receipt, fingerprint(doc));
    expect(cached.note.inputs).toHaveLength(1);
    expect(fresh("note", cached, doc)).toBe(true);
    expect(fresh("note", invalidateNotebookCachedResults(cached, ["minimum"]), doc)).toBe(false);
  });

  it("本次失败与blocked仍可显示，但不可作为成功依赖；参数定义变化使旧错误过期", async () => {
    const doc = document(); const bad = doc.cells.find((cell) => cell.id === "changed")!;
    if (bad.kind === "sql") bad.sql = "SELECT missing FROM shared";
    const cached = cacheNotebookRun(doc, await run(doc), fingerprint(doc));
    expect(cached.changed.result.status).toBe("failure");
    expect(cached.text.result.status).toBe("blocked");
    expect(fresh("changed", cached, doc)).toBe(true);
    expect(fresh("text", cached, doc)).toBe(true);
    const next = structuredClone(doc); next.cells[0] = parameter(2);
    expect(fresh("changed", cached, next)).toBe(false);
    expect(fresh("text", cached, next)).toBe(false);
  }, 15_000);

  it("旧的无resultRef回执仅可在同次运行中使用，不凭预览猜测跨run相等", async () => {
    const doc = document(); const receipt = await run(doc);
    const legacy = structuredClone(receipt); legacy.cells.forEach((cell) => { delete cell.resultRef; });
    const cached = cacheNotebookRun(doc, legacy, fingerprint(doc));
    expect(fresh("sibling", cached, doc)).toBe(true);
    const later = { ...legacy, runId: "legacy_later" };
    const updated = cacheNotebookRun(doc, later, fingerprint(doc));
    expect(fresh("sibling", { ...cached, shared: updated.shared }, doc)).toBe(false);
  }, 15_000);
});

describe("缓存回执一致性与保守失效", () => {
  async function fixture() {
    const doc: NotebookDocument = { name: "纯参数依赖", revision: 0, cells: [parameter(), {
      id: "child", kind: "table", title: "child", inputCellId: "minimum", columns: ["value"],
    }] };
    const receipt = await executeNotebook({ document: doc, sources: [] }, { query: vi.fn(), log: vi.fn() });
    return { doc, receipt, cache: cacheNotebookRun(doc, receipt, fingerprint(doc)) };
  }
  it.each([
    ["revision", (receipt: NotebookRun) => { receipt.revision += 1; }],
    ["缺少单元", (receipt: NotebookRun) => { receipt.cells.pop(); }],
    ["顺序", (receipt: NotebookRun) => { receipt.cells.reverse(); }],
    ["错误权限", (receipt: NotebookRun) => { receipt.cells[0].resultRef!.accessMode = "ai"; }],
    ["错误runId", (receipt: NotebookRun) => { receipt.cells[0].resultRef!.runId = "other"; }],
    ["输入引用", (receipt: NotebookRun) => { receipt.cells[1].resultRef!.inputResultIds = ["other:minimum"]; }],
    ["上游缺失引用", (receipt: NotebookRun) => { delete receipt.cells[0].resultRef; }],
  ] as const)("拒绝%s不一致回执，不混合当前缓存和来历不明结果", async (_, mutate) => {
    const { doc, receipt } = await fixture(); mutate(receipt);
    expect(() => cacheNotebookRun(doc, receipt, fingerprint(doc))).toThrow();
  });
  it("不存在、已过期、已删除、显式失效或上游失败均不借用旧成功", async () => {
    const { doc, cache } = await fixture();
    expect(fresh("missing", cache, doc)).toBe(false);
    expect(fresh("constructor", cache, doc)).toBe(false);
    expect(isNotebookCachedResultFresh("child", cache, { fingerprint: fingerprint(doc), isExpired: (id) => id === "minimum" })).toBe(false);
    expect(fresh("child", cache, { ...doc, cells: [parameter()] })).toBe(false);
    expect(fresh("child", invalidateNotebookCachedResults(cache, ["minimum"]), doc)).toBe(false);
    expect(fresh("child", { ...cache, minimum: { ...cache.minimum, result: { cellId: "minimum", status: "failure", durationMs: 0 } } }, doc)).toBe(false);
    expect(fresh("child", { child: cache.child }, doc)).toBe(false);
  });
  it.each([
    ["不完整", { complete: false }], ["未知签名", { dataSignature: "opaque_not_full_hash" }],
    ["签名变化", { dataSignature: "b".repeat(64) }],
  ] as const)("跨run%s时不保留旧依赖", async (_, overrides) => {
    const { doc, cache } = await fixture();
    const replacement = { ...cache.minimum, identity: { ...cache.minimum.identity, runId: "new" },
      result: { ...cache.minimum.result, resultRef: { ...cache.minimum.result.resultRef!, runId: "new", resultId: "new:minimum", ...overrides } } };
    expect(fresh("child", { ...cache, minimum: replacement }, doc)).toBe(false);
  });
  it("来自不同权限、身份不一致、指纹计算异常或损坏循环不被认可", async () => {
    const { doc, cache } = await fixture();
    const ai = { ...cache.minimum, identity: { ...cache.minimum.identity, accessMode: "ai" as const },
      result: { ...cache.minimum.result, resultRef: { ...cache.minimum.result.resultRef!, accessMode: "ai" as const } } };
    expect(fresh("child", { ...cache, minimum: ai }, doc)).toBe(false);
    expect(fresh("child", { ...cache, minimum: { ...cache.minimum, identity: { ...cache.minimum.identity, revision: 999 } } }, doc)).toBe(false);
    expect(isNotebookCachedResultFresh("child", cache, { fingerprint: () => { throw new Error("deleted"); } })).toBe(false);
    const cyclic = { ...cache, minimum: { ...cache.minimum, inputs: [{ cellId: "child", runId: cache.child.identity.runId, resultId: cache.child.result.resultRef!.resultId }] } };
    expect(fresh("child", cyclic, doc)).toBe(false);
  });
  it("合法constructor单元只通过自有属性读取，缺项不读取原型", async () => {
    const doc: NotebookDocument = { name: "特殊ID", revision: 0, cells: [{ ...parameter(), id: "constructor", outputName: "constructor" }] };
    const receipt = await executeNotebook({ document: doc, sources: [] }, { query: vi.fn(), log: vi.fn() });
    const cached = cacheNotebookRun(doc, receipt, fingerprint(doc));
    expect(Object.hasOwn(cached, "constructor")).toBe(true);
    expect(fresh("constructor", cached, doc)).toBe(true);
    expect(fresh("toString", cached, doc)).toBe(false);
  });
  it("同一run/result ID也不能掩盖输入内容签名变化", async () => {
    const { doc, cache } = await fixture();
    const replacement = { ...cache.minimum, result: { ...cache.minimum.result,
      resultRef: { ...cache.minimum.result.resultRef!, dataSignature: "a".repeat(64) } } };
    expect(fresh("child", { ...cache, minimum: replacement }, doc)).toBe(false);
  });
  it("成功子结果不能引用同次失败输入，即使外层failure与单元计数相符", async () => {
    const { doc, receipt } = await fixture();
    receipt.status = "failure";
    receipt.cells[0] = { cellId: "minimum", status: "failure", durationMs: 0 };
    expect(() => cacheNotebookRun(doc, receipt, fingerprint(doc))).toThrow("成功结果缺少本次成功的上游回执");
  });
  it("回执校验后缓存不与原始响应共享可变表和输入数组", async () => {
    const { doc, receipt, cache } = await fixture();
    receipt.cells[0].table!.rows[0].value = 999;
    receipt.cells[1].resultRef!.inputResultIds.length = 0;
    expect(cache.minimum.result.table!.rows[0].value).toBe(1);
    expect(cache.child.inputs).toHaveLength(1);
    expect(fresh("child", cache, doc)).toBe(true);
  });
  it("多次重算只替换当前项与直接见证，不累积旧run IDs", async () => {
    const { doc } = await fixture();
    let current: NotebookResultCache = {};
    let firstId = "";
    for (let index = 0; index < 12; index += 1) {
      const receipt = await executeNotebook({ document: doc, sources: [] }, { query: vi.fn(), log: vi.fn() });
      if (index === 0) firstId = receipt.runId;
      current = { ...current, ...cacheNotebookRun(doc, receipt, fingerprint(doc)) };
      expect(Object.keys(current)).toHaveLength(2);
      expect(current.child.inputs).toHaveLength(1);
      if (index > 0) expect(JSON.stringify(current)).not.toContain(firstId);
    }
  });
  it("已取消运行不产生可复用成功结果，旧缓存保持不可变", async () => {
    const { doc, cache } = await fixture();
    const before = structuredClone(cache);
    const cancelled = await executeNotebook({ document: doc, sources: [], signal: AbortSignal.abort() }, { query: vi.fn(), log: vi.fn() });
    const received = cacheNotebookRun(doc, cancelled, fingerprint(doc));
    expect(Object.values(received).every((item) => item.result.status !== "success")).toBe(true);
    expect(received.child.inputs[0]).not.toHaveProperty("dataSignature");
    expect(cache).toEqual(before);
  });
});
