import { describe, expect, it } from "vitest";
import type { DatasetUploadResponse } from "../contracts";
import { parseCsvUpload } from "./csv-dataset";
import { MemoryDatasetRepository } from "./dataset-repository";

function stream(text: string) {
  return new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(text)); controller.close(); } });
}

async function fixture(now: Date, suffix: string): Promise<DatasetUploadResponse> {
  let sequence = 0;
  return parseCsvUpload({
    stream: stream("email,value\nsynthetic@example.invalid,1"),
    originalFileName: `${suffix}.csv`,
    mimeType: "text/csv",
    now: () => now,
    id: () => `${suffix.replace(/[^A-Za-z]/gu, "a")}a${String(++sequence).padStart(30, "0")}`,
  });
}

describe("DatasetRepository", () => {
  it("保存、确认敏感策略并主动删除", async () => {
    const now = new Date("2026-09-02T06:00:00.000Z");
    const repository = new MemoryDatasetRepository({ now: () => now });
    const saved = repository.put(await fixture(now, "first"));
    expect(repository.get(saved.descriptor.datasetId)?.rows).toHaveLength(1);
    expect(repository.setAiAccessPolicy(saved.descriptor.datasetId, "masked").aiAccessPolicy).toBe("masked");
    expect(repository.delete(saved.descriptor.datasetId)).toBe(true);
    expect(repository.get(saved.descriptor.datasetId)).toBeNull();
  });

  it("到期后自动清理且容量有限", async () => {
    let now = new Date("2026-09-02T06:00:00.000Z");
    const repository = new MemoryDatasetRepository({ maxDatasets: 1, now: () => now });
    repository.put(await fixture(now, "first"));
    await expect(async () => repository.put(await fixture(now, "second"))).rejects.toThrow(/数量已达上限/);
    now = new Date(now.getTime() + 31 * 60_000);
    expect(repository.list()).toEqual([]);
    expect(repository.put(await fixture(now, "second")).descriptor.originalFileName).toBe("second.csv");
  });
});
