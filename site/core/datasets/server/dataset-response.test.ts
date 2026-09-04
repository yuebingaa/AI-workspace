import { describe, expect, it } from "vitest";
import { demoFixtureResult } from "@/fixtures/demo-product";
import { DatasetResponseTooLargeError, serializeDatasetResponse } from "./dataset-response";

describe("数据集 JSON 响应边界", () => {
  it("序列化后按 UTF-8 实际字节拒绝膨胀结果", () => {
    if (!demoFixtureResult.success) throw new Error(demoFixtureResult.error);
    const source = demoFixtureResult.data.dataProduct.appSpec.dataSources[0];
    const recipe = demoFixtureResult.data.dataProduct.recipes[0];
    const dataset = {
      dataset: {
        datasetId: "dataset_upload_1234567890123456",
        originalFileName: "synthetic.csv",
        source,
        recipe,
        fieldMappings: [],
        sensitiveFields: [],
        aiAccessPolicy: "not-required" as const,
        createdAt: "2026-09-04T00:00:00.000Z",
        expiresAt: "2026-09-04T00:30:00.000Z",
        retentionMinutes: 30,
        persistenceNotice: "测试",
      },
      rows: [{ note: "中文响应膨胀" }],
    };

    expect(() => serializeDatasetResponse(dataset, 16)).toThrow(DatasetResponseTooLargeError);
    expect(JSON.parse(serializeDatasetResponse(dataset))).toMatchObject({ dataset: { datasetId: dataset.dataset.datasetId } });
    expect(() => serializeDatasetResponse(dataset, 0)).toThrow(/不可放宽/);
  });
});
