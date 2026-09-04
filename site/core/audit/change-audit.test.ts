import { describe, expect, it } from "vitest";
import { applyChangeSet, createExecutionState, undoLastChange } from "@/core/changesets";
import { demoFixtureResult } from "@/fixtures/demo-product";
import { appendChangeSetAuditRecord, createChangeSetAuditRecord } from "./change-audit";

function fixtures() {
  if (!demoFixtureResult.success) throw new Error(demoFixtureResult.error);
  return structuredClone(demoFixtureResult.data);
}

describe("ChangeSet 审计记录", () => {
  it("记录应用、失败和撤销", () => {
    const { dataProduct, repurchaseChangeSet } = fixtures();
    const initial = createExecutionState(dataProduct.appSpec);
    const applied = applyChangeSet(initial, repurchaseChangeSet, "editor");
    const appliedAudit = createChangeSetAuditRecord(repurchaseChangeSet, "editor", "ai", "applied", undefined, () => new Date("2026-08-31T01:00:00.000Z"));
    expect(appliedAudit).toMatchObject({ changeSetId: repurchaseChangeSet.id, role: "editor", source: "ai", status: "applied" });

    let failureMessage = "";
    try {
      applyChangeSet(initial, repurchaseChangeSet, "viewer");
    } catch (error) {
      failureMessage = error instanceof Error ? error.message : "失败";
    }
    const failedAudit = createChangeSetAuditRecord(repurchaseChangeSet, "viewer", "ai", "failed", failureMessage);
    expect(failedAudit.error).toMatch(/查看者无权/);

    expect(undoLastChange(applied, "editor").present).toEqual(initial.present);
    const undoAudit = createChangeSetAuditRecord(repurchaseChangeSet, "editor", "manual", "undone");
    expect(undoAudit.status).toBe("undone");
  });

  it("限制审计记录数量", () => {
    const { repurchaseChangeSet } = fixtures();
    const records = ["previewed", "applied", "undone"].reduce((current, status) => appendChangeSetAuditRecord(
      current,
      createChangeSetAuditRecord(repurchaseChangeSet, "editor", "ai", status as "previewed" | "applied" | "undone"),
      2,
    ), [] as ReturnType<typeof createChangeSetAuditRecord>[]);
    expect(records).toHaveLength(2);
    expect(records[0].status).toBe("undone");
  });

  it("拒绝非法或抛错的审计时钟并返回领域错误", () => {
    const { repurchaseChangeSet } = fixtures();
    for (const clock of [
      () => new Date(Number.NaN),
      () => new Date(8_640_000_000_000_000),
      () => { throw new Error("synthetic clock failure"); },
    ]) {
      expect(() => createChangeSetAuditRecord(
        repurchaseChangeSet,
        "editor",
        "ai",
        "previewed",
        undefined,
        clock,
      )).toThrow(/ChangeSet 审计时钟必须返回有效 Date/);
    }
  });
});
