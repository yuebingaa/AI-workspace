import { describe, expect, it } from "vitest";
import type { DatasetUploadResponse } from "../contracts";
import { parseCsvUpload } from "./csv-dataset";
import { MemoryDatasetRepository } from "./dataset-repository";

const ownerA = { tenantId: "tenant_a", ownerId: "owner_a" };
const ownerB = { tenantId: "tenant_a", ownerId: "owner_b" };

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
    const saved = await repository.put(ownerA, await fixture(now, "first"));
    expect((await repository.get(ownerA, saved.descriptor.datasetId))?.rows).toHaveLength(1);
    expect((await repository.setAiAccessPolicy(ownerA, saved.descriptor.datasetId, "masked")).aiAccessPolicy).toBe("masked");
    expect(await repository.delete(ownerA, saved.descriptor.datasetId)).toBe(true);
    expect(await repository.get(ownerA, saved.descriptor.datasetId)).toBeNull();
  });

  it("按 tenantId 和 ownerId 隔离读取、列表、更新与删除", async () => {
    const now = new Date("2026-09-02T06:00:00.000Z");
    const repository = new MemoryDatasetRepository({ now: () => now });
    const saved = await repository.put(ownerA, await fixture(now, "owned"));

    expect(await repository.get(ownerB, saved.descriptor.datasetId)).toBeNull();
    expect(await repository.list(ownerB)).toEqual([]);
    await expect(repository.setAiAccessPolicy(ownerB, saved.descriptor.datasetId, "masked")).rejects.toThrow(/不存在或已过期/);
    expect(await repository.delete(ownerB, saved.descriptor.datasetId)).toBe(false);
    expect(await repository.get(ownerA, saved.descriptor.datasetId)).not.toBeNull();
  });

  it("到期后自动清理且容量有限", async () => {
    let now = new Date("2026-09-02T06:00:00.000Z");
    const repository = new MemoryDatasetRepository({ maxDatasets: 1, now: () => now });
    await repository.put(ownerA, await fixture(now, "first"));
    await expect(repository.put(ownerA, await fixture(now, "second"))).rejects.toThrow(/数量已达上限/);
    await expect(repository.put(ownerB, await fixture(now, "second"))).rejects.toThrow(/数量已达上限/);
    now = new Date(now.getTime() + 31 * 60_000);
    expect(await repository.list(ownerA)).toEqual([]);
    expect((await repository.put(ownerA, await fixture(now, "second"))).descriptor.originalFileName).toBe("second.csv");
  });
});
