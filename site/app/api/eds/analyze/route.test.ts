import writeXlsxFile, { type Cell, type SheetData } from "write-excel-file/node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EDS_MAX_RESPONSE_BYTES, EDS_UPLOAD_LIMITS, edsAnalysisResponseSchema, edsSelectionRequiredResponseSchema, type EdsCellValue, type EdsWorkbookSheet } from "@/core/eds";
import { excelExportStore } from "@/core/exports/server/excel-export-store";
import { createSyntheticEdsFixture } from "@/fixtures/eds-synthetic";
import { GET as downloadExport } from "../../exports/[token]/route";
import { EdsConcurrencyGate, POST } from "./route";

function writableCell(value: EdsCellValue): Cell {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return { value, type: Date, format: "yyyy-mm-dd" };
  if (typeof value === "number") return { value, type: Number };
  if (typeof value === "boolean") return { value, type: Boolean };
  return { value: String(value), type: String };
}

async function fileFromSheets(name: string, sheets: EdsWorkbookSheet[]): Promise<File> {
  const buffer = await writeXlsxFile(sheets.map((sheet) => ({
    sheet: sheet.sheet,
    data: sheet.data.map((row) => row.map(writableCell)) as SheetData,
  }))).toBuffer();
  return new File([Uint8Array.from(buffer)], name, { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}

describe("EDS 分析 API", () => {
  beforeEach(() => excelExportStore.clear());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("高级验收上传输入与基准工作簿，返回图表数据、660 项比对和可下载导出", async () => {
    const fixture = createSyntheticEdsFixture();
    const form = new FormData();
    form.set("source", await fileFromSheets("synthetic-input.xlsx", fixture.sourceSheets));
    form.set("template", await fileFromSheets("synthetic-target.xlsx", fixture.templateSheets));
    const response = await POST(new Request("http://localhost/api/eds/analyze", { method: "POST", body: form }));

    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(new TextEncoder().encode(await response.clone().text()).byteLength).toBeLessThanOrEqual(EDS_MAX_RESPONSE_BYTES);
    const result = edsAnalysisResponseSchema.parse(await response.json());
    expect(result.summary).toMatchObject({ issueCount: 14, channelCount: 20 });
    expect(result.issueSummary).toHaveLength(14);
    expect(result.lineSummary).toHaveLength(10);
    expect(result.configuration.comparisonMode).toBe("custom_template");
    expect(result.comparison).toMatchObject({ coreMatched: 560, reportMatched: 660, mismatchCount: 0 });

    const downloaded = await downloadExport(new Request(`http://localhost${result.exportArtifact.downloadUrl}`));
    expect(downloaded.status).toBe(200);
    expect(downloaded.headers.get("content-type")).toContain("spreadsheetml");
    expect(Buffer.from(await downloaded.arrayBuffer()).subarray(0, 2).toString()).toBe("PK");
  });

  it("最终响应校验失败时撤销客户端不可达的下载工件", async () => {
    const fixture = createSyntheticEdsFixture();
    const form = new FormData();
    form.set("source", await fileFromSheets("synthetic-input.xlsx", fixture.sourceSheets));
    form.set("template", await fileFromSheets("synthetic-target.xlsx", fixture.templateSheets));
    const originalPut = excelExportStore.put.bind(excelExportStore);
    vi.spyOn(excelExportStore, "put").mockImplementationOnce((generated, ownership, now) => ({
      ...originalPut(generated, ownership, now),
      rowCount: -1,
    }));

    const response = await POST(new Request("http://localhost/api/eds/analyze", { method: "POST", body: form }));
    expect(response.status).toBe(500);
    expect(excelExportStore.health().count).toBe(0);
  });

  it("最终序列化响应超限时撤销下载工件并安全失败", async () => {
    const fixture = createSyntheticEdsFixture();
    const form = new FormData();
    form.set("source", await fileFromSheets("synthetic-input.xlsx", fixture.sourceSheets));
    form.set("template", await fileFromSheets("synthetic-target.xlsx", fixture.templateSheets));
    const originalParse = edsAnalysisResponseSchema.parse.bind(edsAnalysisResponseSchema);
    vi.spyOn(edsAnalysisResponseSchema, "parse").mockImplementationOnce((value) => ({
      ...originalParse(value),
      warnings: ["x".repeat(EDS_MAX_RESPONSE_BYTES)],
    }));

    const response = await POST(new Request("http://localhost/api/eds/analyze", { method: "POST", body: form }));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: { message: "EDS 分析响应超过安全大小限制" } });
    expect(excelExportStore.health().count).toBe(0);
  });

  it("默认单文件使用内置模板，仍拒绝错误请求类型和空上传", async () => {
    expect((await POST(new Request("http://localhost/api/eds/analyze", { method: "POST", body: "bad" }))).status).toBe(415);

    const empty = new FormData();
    expect((await POST(new Request("http://localhost/api/eds/analyze", { method: "POST", body: empty }))).status).toBe(400);

    const fixture = createSyntheticEdsFixture();
    const sourceOnly = new FormData();
    sourceOnly.set("source", await fileFromSheets("synthetic-input.xlsx", fixture.sourceSheets));
    const sourceOnlyResponse = await POST(new Request("http://localhost/api/eds/analyze", { method: "POST", body: sourceOnly }));
    expect(sourceOnlyResponse.status).toBe(201);
    const sourceOnlyResult = edsAnalysisResponseSchema.parse(await sourceOnlyResponse.json());
    expect(sourceOnlyResult.configuration.comparisonMode).toBe("not_requested");
    expect(sourceOnlyResult.comparison).toBeNull();
    expect(sourceOnlyResult.summary).toMatchObject({ date: "2026-08-25", shift: "白班" });
  });

  it("多班次返回结构化选择项，并按用户选择生成独立报告", async () => {
    const fixture = createSyntheticEdsFixture();
    for (const sheet of fixture.sourceSheets) {
      const night = structuredClone(sheet.data[1]);
      night[5] = "夜班";
      sheet.data.push(night);
    }
    const source = await fileFromSheets("multi-shift.xlsx", fixture.sourceSheets);
    const discovery = new FormData();
    discovery.set("source", source);

    const discoveryResponse = await POST(new Request("http://localhost/api/eds/analyze", { method: "POST", body: discovery }));
    expect(discoveryResponse.status).toBe(409);
    expect(discoveryResponse.headers.get("cache-control")).toContain("no-store");
    const required = edsSelectionRequiredResponseSchema.parse(await discoveryResponse.json());
    expect(required.error.selections).toEqual([
      { date: "2026-08-25", shift: "夜班" },
      { date: "2026-08-25", shift: "白班" },
    ].sort((left, right) => left.shift.localeCompare(right.shift, "zh-CN")));
    expect(excelExportStore.health().count).toBe(0);

    const selected = new FormData();
    selected.set("source", source);
    selected.set("selectionDate", "2026-08-25");
    selected.set("selectionShift", "夜班");
    const selectedResponse = await POST(new Request("http://localhost/api/eds/analyze", { method: "POST", body: selected }));
    expect(selectedResponse.status).toBe(201);
    const result = edsAnalysisResponseSchema.parse(await selectedResponse.json());
    expect(result.summary).toMatchObject({ date: "2026-08-25", shift: "夜班" });
    expect(result.summary.matchedRows).toBeGreaterThan(0);
    expect(excelExportStore.health().count).toBe(1);

    const incompleteSelection = new FormData();
    incompleteSelection.set("source", source);
    incompleteSelection.set("selectionDate", "2026-08-25");
    expect((await POST(new Request("http://localhost/api/eds/analyze", { method: "POST", body: incompleteSelection }))).status).toBe(400);
  });

  it("目标候选记录日期非法时在写出和存储前返回 400", async () => {
    const fixture = createSyntheticEdsFixture();
    fixture.sourceSheets[0].data[1][4] = "2026-08-25garbage";
    const form = new FormData();
    form.set("source", await fileFromSheets("invalid-date-input.xlsx", fixture.sourceSheets));
    form.set("template", await fileFromSheets("synthetic-target.xlsx", fixture.templateSheets));
    const put = vi.spyOn(excelExportStore, "put");

    const response = await POST(new Request("http://localhost/api/eds/analyze", { method: "POST", body: form }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { message: expect.stringMatching(/工作日/u) } });
    expect(put).not.toHaveBeenCalled();
    expect(excelExportStore.health().count).toBe(0);
  });

  it("拒绝无效或超限的 Content-Length 以及格式损坏的 multipart", async () => {
    const invalidLength = await POST(new Request("http://localhost/api/eds/analyze", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=x", "content-length": "not-a-number" },
      body: "",
    }));
    expect(invalidLength.status).toBe(400);

    const oversizedLength = await POST(new Request("http://localhost/api/eds/analyze", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=x", "content-length": String(22 * 1024 * 1024) },
      body: "",
    }));
    expect(oversizedLength.status).toBe(413);

    const malformed = await POST(new Request("http://localhost/api/eds/analyze", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=x" },
      body: "not multipart",
    }));
    expect(malformed.status).toBe(400);
  });

  it("即使没有 Content-Length，也会流式截断超限请求体", async () => {
    const chunk = new Uint8Array(1024 * 1024);
    let emitted = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (emitted >= 22) controller.close();
        else {
          controller.enqueue(chunk);
          emitted += 1;
        }
      },
    });
    const response = await POST(new Request("http://localhost/api/eds/analyze", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=x" },
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" }));
    expect(response.status).toBe(413);
    expect(emitted).toBeLessThanOrEqual(22);
  });

  it("单路请求占用时返回 429，并在请求结束后释放名额", async () => {
    let closeBody!: () => void;
    const stalledBody = new ReadableStream<Uint8Array>({
      start(controller) { closeBody = () => controller.close(); },
    });
    const firstResponse = POST(new Request("http://localhost/api/eds/analyze", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=stalled" },
      body: stalledBody,
      duplex: "half",
    } as RequestInit & { duplex: "half" }));

    const busyForm = new FormData();
    const busyResponse = await POST(new Request("http://localhost/api/eds/analyze", { method: "POST", body: busyForm }));
    expect(busyResponse.status).toBe(429);
    expect(busyResponse.headers.get("retry-after")).toBe("15");
    expect(await busyResponse.json()).toEqual({ error: { message: "EDS 分析正在运行，请稍后重试。" } });

    closeBody();
    expect((await firstResponse).status).toBe(400);
    const afterRelease = await POST(new Request("http://localhost/api/eds/analyze", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=x" },
      body: "not multipart",
    }));
    expect(afterRelease.status).toBe(400);
    expect(afterRelease.headers.get("retry-after")).toBeNull();
  });

  it("软超时响应后等待底层操作结算才释放并发槽", async () => {
    const gate = new EdsConcurrencyGate(1);
    const firstLease = gate.tryAcquire();
    expect(firstLease).not.toBeNull();
    let rejectOperation!: (error: Error) => void;
    const operation = new Promise<void>((_resolve, reject) => { rejectOperation = reject; });
    firstLease?.track(operation);
    firstLease?.releaseWhenIdle();

    expect(gate.tryAcquire()).toBeNull();
    rejectOperation(new Error("late parser rejection"));
    await expect(operation).rejects.toThrow("late parser rejection");
    await Promise.resolve();

    const nextLease = gate.tryAcquire();
    expect(nextLease).not.toBeNull();
    nextLease?.releaseWhenIdle();
    expect(gate.tryAcquire()).not.toBeNull();
  });

  it("请求取消会主动终止挂起读体并立即释放名额", async () => {
    let cancelCalls = 0;
    const stalledBody = new ReadableStream<Uint8Array>({ cancel() { cancelCalls += 1; } });
    const controller = new AbortController();
    const responsePromise = POST(new Request("http://localhost/api/eds/analyze", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=stalled" },
      body: stalledBody,
      duplex: "half",
      signal: controller.signal,
    } as RequestInit & { duplex: "half" }));

    controller.abort();
    const response = await responsePromise;
    expect(response.status).toBe(408);
    expect(await response.json()).toEqual({ error: { message: "EDS 上传请求已取消" } });
    expect(cancelCalls).toBe(1);

    const afterCancel = await POST(new Request("http://localhost/api/eds/analyze", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=x" },
      body: "not multipart",
    }));
    expect(afterCancel.status).toBe(400);
  });

  it("实际请求体超限时不等待永不结算的取消且保留 413", async () => {
    let cancelCalls = 0;
    const oversizedBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(EDS_UPLOAD_LIMITS.maxCombinedBytes + 1024 * 1024 + 1));
      },
      cancel() {
        cancelCalls += 1;
        return new Promise<void>(() => undefined);
      },
    });
    let outcome: Response | undefined;
    void POST(new Request("http://localhost/api/eds/analyze", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=oversized" },
      body: oversizedBody,
      duplex: "half",
    } as RequestInit & { duplex: "half" })).then((response) => { outcome = response; });

    await new Promise<void>((resolveWait) => setImmediate(resolveWait));

    expect(outcome?.status).toBe(413);
    expect(cancelCalls).toBe(1);
    const afterReject = await POST(new Request("http://localhost/api/eds/analyze", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=x" },
      body: "not multipart",
    }));
    expect(afterReject.status).toBe(400);
  });

  it("读体取消先完成时仍稳定返回超时 408", async () => {
    vi.useFakeTimers();
    let cancelCalls = 0;
    const stalledBody = new ReadableStream<Uint8Array>({ cancel() { cancelCalls += 1; } });
    const responsePromise = POST(new Request("http://localhost/api/eds/analyze", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=stalled" },
      body: stalledBody,
      duplex: "half",
    } as RequestInit & { duplex: "half" }));

    await vi.advanceTimersByTimeAsync(15_000);
    const response = await responsePromise;
    expect(response.status).toBe(408);
    expect(await response.json()).toEqual({ error: { message: "EDS 上传请求读取超时" } });
    expect(cancelCalls).toBe(1);
  });

  it("拒绝重复文件字段和未知 multipart 字段", async () => {
    const fixture = createSyntheticEdsFixture();
    const source = await fileFromSheets("synthetic-input.xlsx", fixture.sourceSheets);
    const template = await fileFromSheets("synthetic-target.xlsx", fixture.templateSheets);
    const duplicate = new FormData();
    duplicate.append("source", source);
    duplicate.append("source", source);
    duplicate.append("template", template);
    expect((await POST(new Request("http://localhost/api/eds/analyze", { method: "POST", body: duplicate }))).status).toBe(400);

    const unknown = new FormData();
    unknown.append("source", source);
    unknown.append("template", template);
    unknown.append("unexpected", "value");
    const unknownResponse = await POST(new Request("http://localhost/api/eds/analyze", { method: "POST", body: unknown }));
    expect(unknownResponse.status).toBe(400);
    expect(await unknownResponse.json()).toEqual({ error: { message: "EDS 上传包含不支持的字段" } });
  });

  it("公共错误响应遮蔽用户控制 canary、无堆栈且保持小体积", async () => {
    const fixture = createSyntheticEdsFixture();
    fixture.sourceSheets[0].sheet = "token=EDS_CANARY_105";
    fixture.sourceSheets[0].data[0].push("Line");
    const form = new FormData();
    form.set("source", await fileFromSheets("synthetic-input.xlsx", fixture.sourceSheets));
    form.set("template", await fileFromSheets("synthetic-target.xlsx", fixture.templateSheets));

    const response = await POST(new Request("http://localhost/api/eds/analyze", { method: "POST", body: form }));
    const body = await response.text();
    const payload = JSON.parse(body) as { error: { message: string } };

    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new TextEncoder().encode(body).byteLength).toBeLessThanOrEqual(2 * 1024);
    expect(body).not.toContain("EDS_CANARY_105");
    expect(body).not.toMatch(/stack|at POST|C:\\/iu);
    expect(payload.error.message).toContain("[REDACTED]");
    expect(Object.keys(payload)).toEqual(["error"]);
    expect(Object.keys(payload.error)).toEqual(["message"]);
  });
});
