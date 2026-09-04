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

async function nonSensitiveFixture(now: Date, suffix: string): Promise<DatasetUploadResponse> {
  let sequence = 0;
  return parseCsvUpload({
    stream: stream("category,value\nA,1"),
    originalFileName: `${suffix}.csv`,
    mimeType: "text/csv",
    now: () => now,
    id: () => `${suffix.replace(/[^A-Za-z]/gu, "a")}a${String(++sequence).padStart(30, "0")}`,
  });
}

describe("DatasetRepository", () => {
  it("拒绝无效仓库时钟，持久化失败时保留原始磁盘错误", async () => {
    expect(() => new MemoryDatasetRepository({ now: () => new Date(Number.NaN) })).toThrow(/时钟.*有效 Date/);

    const operationTime = new Date("2026-09-02T06:00:00.000Z");
    let clockBroken = false;
    const persistence = {
      mode: "json-file" as const,
      load: () => null,
      save: () => {
        clockBroken = true;
        throw new Error("synthetic disk failure");
      },
      backup: () => null,
      restore: () => { throw new Error("not used"); },
      describe: () => ({ mode: "json-file" as const, configured: true as const, snapshotExists: false }),
    };
    const repository = new MemoryDatasetRepository({
      now: () => clockBroken ? new Date(Number.NaN) : operationTime,
      persistence,
    });

    await expect(repository.put(ownerA, await fixture(operationTime, "clock-error"))).rejects.toThrow(/synthetic disk failure/);
    clockBroken = false;
    expect(repository.health()).toMatchObject({
      persistenceHealthy: false,
      lastPersistenceErrorAt: operationTime.toISOString(),
      count: 0,
    });
  });

  it("保存、确认敏感策略并主动删除", async () => {
    const now = new Date("2026-09-02T06:00:00.000Z");
    const repository = new MemoryDatasetRepository({ now: () => now });
    const saved = await repository.put(ownerA, await fixture(now, "first"));
    expect((await repository.get(ownerA, saved.descriptor.datasetId))?.rows).toHaveLength(1);
    expect((await repository.setAiAccessPolicy(ownerA, saved.descriptor.datasetId, "masked")).aiAccessPolicy).toBe("masked");
    expect(await repository.delete(ownerA, saved.descriptor.datasetId)).toBe(true);
    expect(await repository.get(ownerA, saved.descriptor.datasetId)).toBeNull();
  });

  it("只允许 pending 首次确认，同策略重放幂等且冲突重放不改写", async () => {
    const now = new Date("2026-09-02T06:00:00.000Z");
    let saveCount = 0;
    const persistence = {
      mode: "json-file" as const,
      load: () => null,
      save: () => { saveCount += 1; },
      backup: () => null,
      restore: () => { throw new Error("not used"); },
      describe: () => ({ mode: "json-file" as const, configured: true as const, snapshotExists: false }),
    };
    const repository = new MemoryDatasetRepository({ now: () => now, persistence });
    const saved = await repository.put(ownerA, await fixture(now, "state"));
    const confirmed = await repository.setAiAccessPolicy(ownerA, saved.descriptor.datasetId, "masked");
    const confirmedSaveCount = saveCount;

    expect((await repository.setAiAccessPolicy(ownerA, saved.descriptor.datasetId, "masked")).aiAccessPolicy).toBe("masked");
    expect(saveCount).toBe(confirmedSaveCount);
    await expect(repository.setAiAccessPolicy(ownerA, saved.descriptor.datasetId, "exclude-sensitive-samples"))
      .rejects.toThrow(/已经确认/);
    expect((await repository.get(ownerA, saved.descriptor.datasetId))?.descriptor).toEqual(confirmed);
  });

  it("无敏感字段的数据集不能伪造已确认策略", async () => {
    const now = new Date("2026-09-02T06:00:00.000Z");
    const repository = new MemoryDatasetRepository({ now: () => now });
    const saved = await repository.put(ownerA, await nonSensitiveFixture(now, "ordinary"));

    expect(saved.descriptor.aiAccessPolicy).toBe("not-required");
    await expect(repository.setAiAccessPolicy(ownerA, saved.descriptor.datasetId, "masked"))
      .rejects.toThrow(/没有需要确认/);
    expect((await repository.get(ownerA, saved.descriptor.datasetId))?.descriptor.aiAccessPolicy).toBe("not-required");
  });

  it("模型调用边界校验会拒绝已删除或过期的数据快照", async () => {
    let now = new Date("2026-09-02T06:00:00.000Z");
    const repository = new MemoryDatasetRepository({ now: () => now });
    const deleted = await repository.put(ownerA, await nonSensitiveFixture(now, "revoked"));
    const deletedExpectation = [{ datasetId: deleted.descriptor.datasetId, policy: deleted.descriptor.aiAccessPolicy }];
    repository.assertAiAccessPolicies(ownerA, deletedExpectation);
    await repository.delete(ownerA, deleted.descriptor.datasetId);
    expect(() => repository.assertAiAccessPolicies(ownerA, deletedExpectation)).toThrow(/已被删除、过期或更改/);

    const expiring = await repository.put(ownerA, await nonSensitiveFixture(now, "expiring"));
    const expiringExpectation = [{ datasetId: expiring.descriptor.datasetId, policy: expiring.descriptor.aiAccessPolicy }];
    now = new Date(now.getTime() + 31 * 60_000);
    expect(() => repository.assertAiAccessPolicies(ownerA, expiringExpectation)).toThrow(/已被删除、过期或更改/);
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

  it("拒绝同一所有者 ID 碰撞且存取副本不能反向修改内部数据", async () => {
    const now = new Date("2026-09-02T06:00:00.000Z");
    const repository = new MemoryDatasetRepository({ now: () => now });
    const input = await fixture(now, "immutable");
    const expectedValue = input.rows[0].value;
    const saved = await repository.put(ownerA, input);
    input.rows[0].value = 999;
    saved.rows[0].value = 888;

    expect((await repository.get(ownerA, saved.descriptor.datasetId))?.rows[0].value).toBe(expectedValue);
    await expect(repository.put(ownerA, await fixture(now, "immutable"))).rejects.toThrow(/标识冲突/);
    expect((await repository.get(ownerA, saved.descriptor.datasetId))?.rows[0].value).toBe(expectedValue);
  });

  it("恢复时拒绝会静默覆盖的重复所有权与数据集标识", async () => {
    const now = new Date("2026-09-02T06:00:00.000Z");
    const payload = await fixture(now, "duplicate");
    const duplicateSnapshot = {
      version: 1 as const,
      datasets: [
        { ownership: ownerA, payload },
        { ownership: ownerA, payload: structuredClone(payload) },
      ],
    };
    const persistence = {
      mode: "json-file" as const,
      load: () => structuredClone(duplicateSnapshot) as never,
      save: () => undefined,
      backup: () => null,
      restore: () => structuredClone(duplicateSnapshot) as never,
      describe: () => ({ mode: "json-file" as const, configured: true as const, snapshotExists: true }),
    };

    expect(() => new MemoryDatasetRepository({ now: () => now, persistence })).toThrow(/重复的所有权与标识/);
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

  it("通过可替换快照适配器在进程重建后恢复，并报告容量预警", async () => {
    const now = new Date("2026-09-02T06:00:00.000Z");
    let snapshot: unknown = null;
    const persistence = {
      mode: "json-file" as const,
      load: () => structuredClone(snapshot) as never,
      save: (value: unknown) => { snapshot = structuredClone(value); },
      backup: () => null,
      restore: () => { throw new Error("not used"); },
      describe: () => ({ mode: "json-file" as const, configured: true as const, snapshotExists: snapshot !== null }),
    };
    const firstProcess = new MemoryDatasetRepository({ maxDatasets: 2, now: () => now, persistence });
    const saved = await firstProcess.put(ownerA, await fixture(now, "restart"));
    expect(firstProcess.health()).toMatchObject({ mode: "json-file", count: 1, capacity: 2, warning: null });

    const secondProcess = new MemoryDatasetRepository({ maxDatasets: 2, now: () => now, persistence });
    expect((await secondProcess.get(ownerA, saved.descriptor.datasetId))?.rows).toHaveLength(1);
    await secondProcess.put(ownerA, await fixture(now, "capacity"));
    expect(secondProcess.health()).toMatchObject({ count: 2, utilization: 1 });
    expect(secondProcess.health().warning).toContain("100%");
  });

  it("持久化写入失败时回滚内存变更，避免返回失败后仍可见", async () => {
    let now = new Date("2026-09-02T06:00:00.000Z");
    let snapshot: unknown = null;
    let failWrites = false;
    const persistence = {
      mode: "json-file" as const,
      load: () => structuredClone(snapshot) as never,
      save: (value: unknown) => {
        if (failWrites) throw new Error("synthetic disk failure");
        snapshot = structuredClone(value);
      },
      backup: () => null,
      restore: () => { throw new Error("not used"); },
      describe: () => ({ mode: "json-file" as const, configured: true as const, snapshotExists: snapshot !== null }),
    };
    const repository = new MemoryDatasetRepository({ now: () => now, persistence });
    const saved = await repository.put(ownerA, await fixture(now, "rollback"));
    failWrites = true;

    await expect(repository.setAiAccessPolicy(ownerA, saved.descriptor.datasetId, "masked"))
      .rejects.toThrow(/disk failure/);
    expect((await repository.get(ownerA, saved.descriptor.datasetId))?.descriptor.aiAccessPolicy).not.toBe("masked");
    await expect(repository.delete(ownerA, saved.descriptor.datasetId)).rejects.toThrow(/disk failure/);
    expect(await repository.get(ownerA, saved.descriptor.datasetId)).not.toBeNull();
    expect(() => repository.clear()).toThrow(/disk failure/);
    expect(repository.health()).toMatchObject({ count: 1, persistenceHealthy: false });
    expect(repository.health().lastPersistenceErrorAt).not.toBeNull();

    failWrites = false;
    await repository.setAiAccessPolicy(ownerA, saved.descriptor.datasetId, "masked");
    expect(repository.health()).toMatchObject({ persistenceHealthy: true, lastPersistenceErrorAt: null });

    failWrites = true;
    now = new Date(now.getTime() + 31 * 60_000);
    expect(repository.health()).toMatchObject({ count: 0, persistenceHealthy: false });
  });
});
