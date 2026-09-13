import { describe, expect, it } from "vitest";
import { createExecutionState } from "@/core/changesets";
import { demoFixtureResult } from "@/fixtures/demo-product";
import {
  assignDatasetToWorkspace,
  createBlankWorkspaceInAppSpec,
  datasetsForWorkspace,
  ensureInitialBlankWorkspaceInExecution,
  ensureInitialBlankWorkspaceInProduct,
  INITIAL_WORKSPACE_PAGE_ID,
  reconcileDataProductWorkspaces,
  workspaceInterfaceSummaries,
} from "./workspace-manager";

function fixture() {
  if (!demoFixtureResult.success) throw new Error(demoFixtureResult.error);
  return structuredClone(demoFixtureResult.data.dataProduct);
}

describe("workspace manager", () => {
  it("adds one deterministic blank workspace to the initial product", () => {
    const once = ensureInitialBlankWorkspaceInProduct(fixture());
    const twice = ensureInitialBlankWorkspaceInProduct(once);
    expect(twice.appSpec.pages.filter((page) => page.id === INITIAL_WORKSPACE_PAGE_ID)).toHaveLength(1);
    expect(twice.appSpec.pages.find((page) => page.id === INITIAL_WORKSPACE_PAGE_ID)?.root.children).toEqual([]);
  });

  it("creates additional empty workspaces without resetting execution history", () => {
    const product = ensureInitialBlankWorkspaceInProduct(fixture());
    const created = createBlankWorkspaceInAppSpec(product.appSpec, "营销分析", () => "marketing");
    const execution = ensureInitialBlankWorkspaceInExecution(createExecutionState(created.appSpec));
    expect(created.page).toMatchObject({ id: "page_workspace_marketing", title: "营销分析" });
    expect(created.page.root.children).toEqual([]);
    expect(execution.present.pages).toContainEqual(created.page);
  });

  it("assigns datasets to separate workspaces and reports scoped counts", () => {
    const product = ensureInitialBlankWorkspaceInProduct(fixture());
    const assigned = assignDatasetToWorkspace(product, product.datasets[0].id, INITIAL_WORKSPACE_PAGE_ID);
    expect(datasetsForWorkspace(assigned.datasets, INITIAL_WORKSPACE_PAGE_ID)).toHaveLength(1);
    expect(workspaceInterfaceSummaries(assigned.appSpec, assigned.datasets))
      .toContainEqual(expect.objectContaining({ id: INITIAL_WORKSPACE_PAGE_ID, dataSourceCount: 1 }));
  });

  it("deleting a workspace keeps its datasets and moves them to a remaining workspace", () => {
    const product = ensureInitialBlankWorkspaceInProduct(fixture());
    const created = createBlankWorkspaceInAppSpec(product.appSpec, "临时分析", () => "temporary");
    const assigned = assignDatasetToWorkspace({ ...product, appSpec: created.appSpec }, product.datasets[0].id, created.page.id);
    const appSpec = {
      ...created.appSpec,
      pages: created.appSpec.pages.filter((page) => page.id !== created.page.id),
      navigation: created.appSpec.navigation.filter((item) => item.pageId !== created.page.id),
    };
    const reconciled = reconcileDataProductWorkspaces(assigned, appSpec);
    expect(reconciled.datasets).toContainEqual(expect.objectContaining({
      id: product.datasets[0].id,
      workspaceId: INITIAL_WORKSPACE_PAGE_ID,
    }));
  });
});
