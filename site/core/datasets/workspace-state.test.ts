import { describe, expect, it } from "vitest";
import { createExecutionState } from "@/core/changesets";
import { demoFixtureResult } from "@/fixtures/demo-product";
import { parseCsvUpload } from "./server/csv-dataset";
import {
  removeUploadedDatasetFromWorkspace,
  synchronizeUploadedDatasetWorkspace,
} from "./workspace-state";

function stream(text: string) {
  return new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(text)); controller.close(); } });
}

describe("上传数据集工作区状态转换", () => {
  it("从响应完成时的最新状态删除目标，同时保留其间无关变更", () => {
    if (!demoFixtureResult.success) throw new Error(demoFixtureResult.error);
    const dataProduct = structuredClone(demoFixtureResult.data.dataProduct);
    const dataRuntime = structuredClone(demoFixtureResult.data.dataRuntime);
    const target = dataProduct.datasets[0].id;
    const execution = createExecutionState(structuredClone(dataProduct.appSpec));
    execution.present.pages[0] = { ...execution.present.pages[0], title: "请求期间的新标题" };
    execution.preview = {
      appSpec: structuredClone(execution.present),
      changeSetId: "changeset_concurrent_preview",
      operationIds: ["operation_concurrent_preview"],
    };
    execution.history = [{
      appSpec: structuredClone(execution.present),
      changeSetId: "changeset_concurrent_history",
      requiredRole: "editor",
    }];
    dataProduct.name = "请求期间的新产品名";
    dataRuntime.rowsByDataSourceId.dataset_unrelated_during_request = [{ retained: true }];

    const result = removeUploadedDatasetFromWorkspace({ execution, dataProduct, dataRuntime }, target);

    expect(result.dataProduct.name).toBe("请求期间的新产品名");
    expect(result.execution.present.pages[0].title).toBe("请求期间的新标题");
    expect(result.execution.preview?.appSpec.pages[0].title).toBe("请求期间的新标题");
    expect(result.execution.history[0].appSpec.pages[0].title).toBe("请求期间的新标题");
    expect(result.dataRuntime.rowsByDataSourceId.dataset_unrelated_during_request).toEqual([{ retained: true }]);
    expect(result.dataProduct.datasets.some((item) => item.id === target)).toBe(false);
    expect(result.dataProduct.recipes.some((recipe) => recipe.sourceDatasetId === target)).toBe(false);
    expect(result.execution.present.dataSources.some((source) => source.id === target)).toBe(false);
    expect(result.execution.preview?.appSpec.dataSources.some((source) => source.id === target)).toBe(false);
    expect(result.execution.history[0].appSpec.dataSources.some((source) => source.id === target)).toBe(false);
    expect(result.dataRuntime.rowsByDataSourceId[target]).toBeUndefined();
  });

  it("按任意完成顺序合并多个服务端权威描述符和行数据", async () => {
    if (!demoFixtureResult.success) throw new Error(demoFixtureResult.error);
    let sequence = 0;
    const create = (name: string) => parseCsvUpload({
      stream: stream("category,value\nA,1"),
      originalFileName: `${name}.csv`,
      mimeType: "text/csv",
      id: () => `${name}${String(++sequence).padStart(32, "0")}`,
    });
    const first = await create("first");
    const second = await create("second");
    let current = {
      execution: createExecutionState(structuredClone(demoFixtureResult.data.dataProduct.appSpec)),
      dataProduct: structuredClone(demoFixtureResult.data.dataProduct),
      dataRuntime: structuredClone(demoFixtureResult.data.dataRuntime),
    };

    current = synchronizeUploadedDatasetWorkspace(current, second.dataset, second.rows);
    current = synchronizeUploadedDatasetWorkspace(current, first.dataset, first.rows);

    for (const uploaded of [first, second]) {
      expect(current.dataProduct.datasets.find((item) => item.id === uploaded.dataset.datasetId))
        .toMatchObject({ expiresAt: uploaded.dataset.expiresAt, aiAccessPolicy: uploaded.dataset.aiAccessPolicy });
      expect(current.execution.present.dataSources.find((source) => source.id === uploaded.dataset.datasetId))
        .toEqual(uploaded.dataset.source);
      expect(current.dataProduct.recipes).toContainEqual(uploaded.dataset.recipe);
      expect(current.dataRuntime.rowsByDataSourceId[uploaded.dataset.datasetId]).toEqual(uploaded.rows);
    }
  });
});
