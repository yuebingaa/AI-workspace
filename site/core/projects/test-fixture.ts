import { randomUUID } from "node:crypto";
import { createExecutionState } from "@/core/changesets";
import { parseCsvUpload } from "@/core/datasets/server/csv-dataset";
import { synchronizeUploadedDatasetWorkspace } from "@/core/datasets/workspace-state";
import type { DatasetUploadResponse } from "@/core/datasets/contracts";
import { createStudioSnapshot } from "@/core/repository/studio-repository";
import { ensureInitialBlankWorkspaceInProduct, INITIAL_WORKSPACE_PAGE_ID } from "@/core/workspaces";
import { demoFixtureResult } from "@/fixtures/demo-product";

export async function projectUpload(text = "category,amount\nAlpha,10\nBeta,20\nAlpha,5") {
  return parseCsvUpload({ stream: new Response(text).body!, originalFileName: "synthetic.csv", mimeType: "text/csv",
    now: () => new Date("2020-01-01T00:00:00.000Z"), id: () => randomUUID().replaceAll("-", "") });
}
export function projectState(upload?: DatasetUploadResponse) {
  if (!demoFixtureResult.success) throw new Error("Invalid fixture");
  const product = ensureInitialBlankWorkspaceInProduct(structuredClone(demoFixtureResult.data.dataProduct));
  product.datasets = []; product.recipes = []; product.notebooks = {};
  product.semanticLayer = { models: [], selectedByWorkspace: {} };
  product.appSpec.dataSources = [];
  product.appSpec.pages = product.appSpec.pages.filter((page) => page.id === INITIAL_WORKSPACE_PAGE_ID);
  product.appSpec.navigation = product.appSpec.navigation.filter((entry) => entry.pageId === INITIAL_WORKSPACE_PAGE_ID);
  let workspace = { dataProduct: product, execution: createExecutionState(product.appSpec), dataRuntime: { rowsByDataSourceId: {} } };
  if (upload) workspace = synchronizeUploadedDatasetWorkspace(workspace, upload.dataset, upload.rows);
  return createStudioSnapshot(workspace.dataProduct, workspace.execution, [], []);
}
