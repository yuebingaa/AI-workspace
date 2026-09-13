import {
  harnessEvidenceSnapshotSchema,
  type HarnessEvidenceKind,
  type HarnessEvidenceManifest,
  type HarnessEvidenceSnapshot,
  type HarnessObservation,
  type HarnessVisualScreenshotEvidence,
} from "./contracts";
import { sanitizeHarnessText } from "./security";

export interface HarnessEvidenceRecordInput {
  kind: HarnessEvidenceKind;
  stage: HarnessEvidenceManifest["stage"];
  source: string;
  summary: string;
  capturedAt?: string;
  sha256?: string;
  byteLength?: number;
  mimeType?: HarnessEvidenceManifest["mimeType"];
  relatedEvidenceIds?: string[];
  data?: unknown;
  bytes?: Buffer;
  screenshot?: HarnessVisualScreenshotEvidence;
}

interface HarnessEvidenceRecord {
  manifest: HarnessEvidenceManifest;
  data?: unknown;
  bytes?: Buffer;
  screenshot?: HarnessVisualScreenshotEvidence;
}

function boundedEvidenceData(value: unknown): unknown {
  if (value === undefined) return undefined;
  try {
    const serialized = JSON.stringify(value);
    if (serialized.length <= 4_000) return value;
    return `${serialized.slice(0, 3_940)}…[证据内容已按上下文预算截断]`;
  } catch {
    return sanitizeHarnessText(value).slice(0, 4_000);
  }
}

export class HarnessEvidenceBus {
  constructor(private readonly namespace = "") {
    if (namespace && !/^[A-Za-z0-9_-]{1,70}$/.test(namespace)) throw new Error("证据命名空间无效。");
  }
  private sequence = 0;
  private readonly records: HarnessEvidenceRecord[] = [];

  add(input: HarnessEvidenceRecordInput): HarnessEvidenceManifest {
    const capturedAt = input.capturedAt ?? new Date().toISOString();
    const id = `${this.namespace ? `${this.namespace}_` : ""}evidence_${++this.sequence}_${input.kind}`;
    const manifest = harnessEvidenceSnapshotSchema.shape.records.element.parse({
      id,
      kind: input.kind,
      stage: input.stage,
      source: sanitizeHarnessText(input.source).slice(0, 120),
      summary: sanitizeHarnessText(input.summary).slice(0, 600),
      capturedAt,
      ...(input.sha256 ? { sha256: input.sha256 } : {}),
      ...(input.byteLength ? { byteLength: input.byteLength } : {}),
      ...(input.mimeType ? { mimeType: input.mimeType } : {}),
      relatedEvidenceIds: input.relatedEvidenceIds ?? [],
    });
    this.records.push({
      manifest,
      ...(input.data !== undefined ? { data: boundedEvidenceData(input.data) } : {}),
      ...(input.bytes ? { bytes: input.bytes } : {}),
      ...(input.screenshot ? { screenshot: input.screenshot } : {}),
    });
    return manifest;
  }

  addScreenshot(
    capture: { bytes: Buffer; evidence: HarnessVisualScreenshotEvidence },
    stage: HarnessEvidenceManifest["stage"],
  ): HarnessEvidenceManifest {
    const position = capture.evidence.capturePosition === "horizontalEnd" ? "横向末端" : "初始位置";
    return this.add({
      kind: "screenshot",
      stage,
      source: "playwright",
      summary: `${capture.evidence.viewport.width}×${capture.evidence.viewport.height} ${position}页面截图`,
      capturedAt: new Date().toISOString(),
      sha256: capture.evidence.sha256,
      byteLength: capture.evidence.byteLength,
      mimeType: capture.evidence.mimeType,
      data: {
        viewport: capture.evidence.viewport,
        capturePosition: capture.evidence.capturePosition ?? "initial",
        layout: capture.evidence.layout,
        pageUrl: capture.evidence.pageUrl,
      },
      bytes: capture.bytes,
      screenshot: capture.evidence,
    });
  }

  addToolObservation(observation: HarnessObservation): HarnessEvidenceManifest {
    return this.add({
      kind: "toolObservation",
      stage: "execution",
      source: observation.toolName,
      summary: observation.summary,
      data: {
        toolCallId: observation.toolCallId,
        toolName: observation.toolName,
        result: observation.data,
      },
    });
  }

  snapshot(): HarnessEvidenceSnapshot {
    return harnessEvidenceSnapshotSchema.parse({
      version: 1,
      records: this.records.map(({ manifest }) => manifest).slice(-48),
    });
  }

  modelContext(limit = 24, maxDataChars = 6_000): Array<{
    id: string;
    kind: HarnessEvidenceKind;
    source: string;
    summary: string;
    data?: unknown;
  }> {
    let remainingDataChars = Math.max(0, Math.min(6_000, maxDataChars));
    return this.records.slice(-Math.max(1, Math.min(48, limit))).map(({ manifest, data }) => {
      let contextData: unknown;
      if (data !== undefined && manifest.kind !== "toolObservation" && remainingDataChars > 0) {
        const serialized = JSON.stringify(data);
        const allowance = Math.min(1_500, remainingDataChars);
        contextData = serialized.length <= allowance ? data : `${serialized.slice(0, Math.max(0, allowance - 24))}…[证据摘录已截断]`;
        remainingDataChars -= Math.min(serialized.length, allowance);
      }
      return {
        id: manifest.id,
        kind: manifest.kind,
        source: manifest.source,
        summary: manifest.summary,
        ...(contextData !== undefined ? { data: contextData } : {}),
      };
    });
  }

  screenshotCaptures(stage: HarnessEvidenceManifest["stage"]): Array<{
    bytes: Buffer;
    evidence: HarnessVisualScreenshotEvidence;
  }> {
    return this.records.flatMap((record) => (
      record.manifest.kind === "screenshot"
      && record.manifest.stage === stage
      && record.bytes
      && record.screenshot
        ? [{ bytes: record.bytes, evidence: record.screenshot }]
        : []
    ));
  }
}
