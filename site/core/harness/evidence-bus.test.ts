import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { HarnessEvidenceBus } from "./evidence-bus";

describe("Harness Evidence Bus", () => {
  it("在任务内共享截图原始字节、公开清单和受预算约束的模型上下文", () => {
    const bus = new HarnessEvidenceBus();
    const bytes = Buffer.from("raw-screenshot");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const screenshot = bus.addScreenshot({
      bytes,
      evidence: {
        viewport: { width: 900, height: 1000 },
        capturePosition: "initial",
        pageUrl: "http://127.0.0.1:3102/",
        mimeType: "image/jpeg",
        byteLength: bytes.byteLength,
        sha256,
      },
    }, "preflight");
    bus.add({
      kind: "domSnapshot",
      stage: "preflight",
      source: "playwright-dom",
      summary: "900px DOM 快照",
      relatedEvidenceIds: [screenshot.id],
      data: { visibleText: "看板".repeat(3_000) },
    });
    bus.addToolObservation({
      toolCallId: "tool_dataset",
      toolName: "inspectDataset",
      summary: "数据集 48 行",
      data: { privateLargeResult: "x".repeat(8_000) },
    });

    expect(bus.screenshotCaptures("preflight")).toEqual([{ bytes, evidence: expect.objectContaining({ sha256 }) }]);
    expect(bus.snapshot()).toMatchObject({
      version: 1,
      records: [
        expect.objectContaining({ id: screenshot.id, kind: "screenshot", sha256 }),
        expect.objectContaining({ kind: "domSnapshot", relatedEvidenceIds: [screenshot.id] }),
        expect.objectContaining({ kind: "toolObservation" }),
      ],
    });
    const modelContext = bus.modelContext();
    expect(JSON.stringify(modelContext).length).toBeLessThan(9_000);
    expect(modelContext.find((record) => record.kind === "toolObservation")).not.toHaveProperty("data");
    expect(JSON.stringify(bus.snapshot())).not.toContain("privateLargeResult");
  });

  it("keeps references while compacting evidence data for an Executor request", () => {
    const bus = new HarnessEvidenceBus();
    bus.add({
      kind: "domSnapshot",
      stage: "preflight",
      source: "playwright-dom",
      summary: "DOM evidence remains traceable",
      data: { visibleText: "x".repeat(3_000) },
    });

    const [record] = bus.modelContext(24, 120);

    expect(record).toMatchObject({ id: "evidence_1_domSnapshot", summary: "DOM evidence remains traceable" });
    expect(JSON.stringify(record.data).length).toBeLessThanOrEqual(140);
    expect(bus.snapshot().records).toHaveLength(1);
  });
});
