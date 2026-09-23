import { afterEach, describe, expect, it, vi } from "vitest";
import { demoFixtureResult } from "@/fixtures/demo-product";
import { createToolDiagnosticFixture } from "./dsh-tool-diagnostic-fixture";

afterEach(() => vi.unstubAllGlobals());

function payload() {
  if (!demoFixtureResult.success) throw new Error("Synthetic fixture unavailable");
  return { idempotencyKey: "isolated_submit_diagnostic", instruction: "离线验收：尝试提交未修改的 Notebook 草稿；仅展示拒绝原因，不编辑或采用。",
    pageId: "page_home", recipes: [], appSpec: structuredClone(demoFixtureResult.data.dataProduct.appSpec) };
}

describe("isolated DSH diagnostic fixtures", () => {
  it("executes the canonical no-edit submit guard, emits finite SSE failure, and preserves the formal definitions", async () => {
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Network prohibited in fixture test"); }));
    const request = payload(), before = structuredClone(request);
    const result = await createToolDiagnosticFixture(request, "submit-no-changes");
    expect(result.evidence).toMatchObject({ actualBridgeSubmitValidation: true, fixedDriver: true,
      paidModel: false, notebookExecution: false, safeCodes: ["notebook_submit_no_changes"], formalDocumentUnchanged: true });
    expect(result.task).toMatchObject({ state: "failed", terminationCode: "verificationFailed",
      counters: { modelCallCount: 1, toolCallCount: 1 } });
    expect(result.task.notebookArtifact).toBeUndefined();
    expect(result.task.pendingChangeSet).toBeUndefined();
    expect(result.body).toContain("notebook_submit_no_changes");
    expect(result.task.trace?.filter(event => event.type === "tool_completed")).toEqual([]);
    expect(request).toEqual(before);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([false, true])("retains the existing parameter/unsupported fixture (%s)", async unsupported => {
    const result = await createToolDiagnosticFixture(payload(), unsupported);
    expect(result.evidence).toMatchObject({ paidModel: false, formalDocumentUnchanged: true });
    expect(result.body).toContain(unsupported ? "python_unavailable" : "invalid_tool_arguments");
    if (unsupported) {
      expect(result.task).toMatchObject({ state: "blocked", counters: { modelCallCount: 0, toolCallCount: 0 } });
      expect(result.evidence).toMatchObject({ actualBridgePreflight: true, fixedDriverNeverStarted: true });
    }
  });
});
