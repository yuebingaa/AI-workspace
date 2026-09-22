import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { OwnershipScope } from "@/core/identity/ownership";
import type { requestDatasetRepository } from "@/core/projects/server/request";
import { LocalProjectStore, ProjectError } from "@/core/projects/server/store";
import { parseCsvUpload } from "./server/csv-dataset";
import {
  MemoryDatasetRepository,
  DatasetAiAccessPolicyConflictError as LegacyConflictError,
  DatasetAiAccessRevokedError as LegacyRevokedError,
} from "./server/dataset-repository";
import { DatasetAiAccessPolicyConflictError, DatasetAiAccessRevokedError, type DatasetRepository } from "./repository";

const owner = { tenantId: "dataset-port-test", ownerId: "owner-a" };
const now = new Date("2026-09-16T00:00:00.000Z");
const roots: string[] = [];
const prefix = "agentcanvas-dataset-port-";

afterEach(() => {
  for (const root of roots.splice(0)) {
    // Delete only this test's mkdtemp directory, never a configured/user project.
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.startsWith(join(tmpdir(), prefix))) {
      throw new Error("Unsafe Dataset contract fixture cleanup");
    }
    rmSync(root, { recursive: true, force: true });
  }
});

async function upload() {
  return parseCsvUpload({
    stream: new Response("email,value\nsynthetic@example.invalid,10\nsecond@example.invalid,20").body!,
    originalFileName: "synthetic-port.csv", mimeType: "text/csv", now: () => now,
    id: () => randomUUID().replaceAll("-", ""),
  });
}

const adapters: Array<{ name: string; rejectsForeignScope: boolean; create(): DatasetRepository }> = [
  { name: "temporary memory adapter", rejectsForeignScope: false, create: () => new MemoryDatasetRepository({ now: () => now }) },
  { name: "local project adapter", rejectsForeignScope: true, create: () => {
    const root = mkdtempSync(join(tmpdir(), prefix)); roots.push(root);
    return LocalProjectStore.create(join(root, "project"), "合成仓库契约验收").datasets(owner);
  } },
];

/** A consumer uses only the public port, including its synchronous authorization boundary. */
function guardedAction(repository: DatasetRepository, expected: Parameters<DatasetRepository["assertAiAccessPolicies"]>[1], action: () => void) {
  repository.assertAiAccessPolicies(owner, expected);
  action();
}

describe.each(adapters)("Dataset repository contract: $name", ({ create, rejectsForeignScope }) => {
  let repository: DatasetRepository;
  beforeEach(() => { repository = create(); });

  it("supports injected CRUD and preserves the adapter's canonical descriptor without exposing mutable rows", async () => {
    const input = await upload();
    const expectedRows = structuredClone(input.rows);
    const stored = await repository.put(owner, input);
    const id = stored.descriptor.datasetId;
    expect(stored.ownership).toEqual(owner);
    expect(stored.rows).toEqual(expectedRows);
    expect(await repository.get(owner, id)).toEqual(stored);
    expect(await repository.list(owner)).toEqual([stored.descriptor]);
    input.rows[0].value = 999; stored.rows[0].value = 888;
    expect((await repository.get(owner, id))?.rows).toEqual(expectedRows);
    expect(await repository.delete(owner, id)).toBe(true);
    expect(await repository.get(owner, id)).toBeNull();
    expect(await repository.list(owner)).toEqual([]);
    expect(await repository.delete(owner, id)).toBe(false);
  });

  it("keeps pending consent blocked, same-policy replay idempotent and conflicts in the shared error class", async () => {
    const stored = await repository.put(owner, await upload()), id = stored.descriptor.datasetId;
    expect(stored.descriptor.aiAccessPolicy).toBe("pending");
    const action = vi.fn();
    expect(() => guardedAction(repository, [{ datasetId: id, policy: "pending" }], action)).toThrow(DatasetAiAccessRevokedError);
    expect(action).not.toHaveBeenCalled();
    const confirmed = await repository.setAiAccessPolicy(owner, id, "masked");
    expect(confirmed.aiAccessPolicy).toBe("masked");
    expect(confirmed.source.aiAccessPolicy).toBe("masked");
    expect(await repository.setAiAccessPolicy(owner, id, "masked")).toEqual(confirmed);
    await expect(repository.setAiAccessPolicy(owner, id, "exclude-sensitive-samples")).rejects.toThrow(DatasetAiAccessPolicyConflictError);
    expect((await repository.get(owner, id))?.descriptor).toEqual(confirmed);
    guardedAction(repository, [{ datasetId: id, policy: "masked" }], action);
    expect(action).toHaveBeenCalledOnce();
    expect(() => guardedAction(repository, [{ datasetId: id, policy: "exclude-sensitive-samples" }], action)).toThrow(DatasetAiAccessRevokedError);
    expect(action).toHaveBeenCalledOnce();
  });

  it("rejects a deleted snapshot synchronously before an injected action can execute", async () => {
    const stored = await repository.put(owner, await upload()), id = stored.descriptor.datasetId;
    await repository.setAiAccessPolicy(owner, id, "exclude-sensitive-samples");
    const expected = [{ datasetId: id, policy: "exclude-sensitive-samples" as const }];
    expect(repository.assertAiAccessPolicies(owner, expected)).toBeUndefined();
    await repository.delete(owner, id);
    const action = vi.fn();
    expect(() => guardedAction(repository, expected, action)).toThrow(DatasetAiAccessRevokedError);
    expect(action).not.toHaveBeenCalled();
  });

  it.each([
    { tenantId: owner.tenantId, ownerId: "different-owner" },
    { tenantId: "different-tenant", ownerId: owner.ownerId },
  ])("isolates both ownership keys without changing existing foreign-scope semantics: %j", async (foreign: OwnershipScope) => {
    const stored = await repository.put(owner, await upload()), id = stored.descriptor.datasetId;
    if (rejectsForeignScope) {
      // Local projects are bound to the current owner; they reject a mismatched scope.
      await expect(repository.get(foreign, id)).rejects.toThrow(ProjectError);
      await expect(repository.list(foreign)).rejects.toThrow(ProjectError);
      await expect(repository.delete(foreign, id)).rejects.toThrow(ProjectError);
      await expect(repository.setAiAccessPolicy(foreign, id, "masked")).rejects.toThrow(ProjectError);
      expect(() => repository.assertAiAccessPolicies(foreign, [{ datasetId: id, policy: "masked" }])).toThrow(ProjectError);
    } else {
      // The shared temporary repository returns an empty namespace for another owner.
      expect(await repository.get(foreign, id)).toBeNull();
      expect(await repository.list(foreign)).toEqual([]);
      expect(await repository.delete(foreign, id)).toBe(false);
      await expect(repository.setAiAccessPolicy(foreign, id, "masked")).rejects.toThrow(/不存在或已过期/);
      expect(() => repository.assertAiAccessPolicies(foreign, [{ datasetId: id, policy: "masked" }])).toThrow(DatasetAiAccessRevokedError);
    }
    expect(await repository.get(owner, id)).toEqual(stored);
    expect(await repository.list(owner)).toEqual([stored.descriptor]);
  });
});

describe("Dataset repository compatibility", () => {
  it("keeps both existing server error exports identical to the public constructors", () => {
    expect(LegacyConflictError).toBe(DatasetAiAccessPolicyConflictError);
    expect(LegacyRevokedError).toBe(DatasetAiAccessRevokedError);
    expect(new DatasetAiAccessPolicyConflictError("synthetic")).toBeInstanceOf(LegacyConflictError);
    const error = new DatasetAiAccessRevokedError("synthetic-id");
    expect(error).toBeInstanceOf(LegacyRevokedError);
    expect(error.name).toBe("DatasetAiAccessRevokedError");
    expect(error.message).toBe("上传数据集 synthetic-id 已被删除、过期或更改 AI 数据处理方式");
  });

  it("declares the authorization check as synchronous in both public repository selection paths", () => {
    expectTypeOf<ReturnType<DatasetRepository["assertAiAccessPolicies"]>>().toEqualTypeOf<void>();
    expectTypeOf<ReturnType<LocalProjectStore["datasets"]>>().toEqualTypeOf<DatasetRepository>();
    expectTypeOf<ReturnType<typeof requestDatasetRepository>>().toEqualTypeOf<DatasetRepository>();
  });
});
