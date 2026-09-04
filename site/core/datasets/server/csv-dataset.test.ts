import { afterEach, describe, expect, it, vi } from "vitest";
import { CSV_UPLOAD_LIMITS, MAX_DATASET_RESPONSE_BYTES, datasetUploadResponseSchema, type DatasetUploadResponse } from "../contracts";
import { CsvDatasetError, parseCsvUpload } from "./csv-dataset";

function byteStream(bytes: Uint8Array, chunkSize = bytes.length || 1): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += chunkSize) controller.enqueue(bytes.slice(offset, offset + chunkSize));
      controller.close();
    },
  });
}

function ids() {
  let sequence = 0;
  return () => `a${String(++sequence).padStart(31, "0")}`;
}

function input(text: string, overrides: Partial<Parameters<typeof parseCsvUpload>[0]> = {}) {
  return {
    stream: byteStream(new TextEncoder().encode(text), 3),
    originalFileName: "orders.csv",
    mimeType: "text/csv",
    now: () => new Date("2026-09-02T06:00:00.000Z"),
    id: ids(),
    ...overrides,
  };
}

describe("CSV 服务端流式解析", () => {
  afterEach(() => vi.useRealTimers());

  it("超时或调用方取消时恰好取消一次挂起的上传流", async () => {
    vi.useFakeTimers();
    const timeoutCancel = vi.fn(() => new Promise<void>(() => undefined));
    const timed = parseCsvUpload(input("", {
      stream: new ReadableStream<Uint8Array>({ cancel: timeoutCancel }),
      timeoutMs: 25,
    }));
    const timedOutcome = timed.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(25);
    const timedError = await timedOutcome;
    expect(timedError).toMatchObject({ status: 408 });
    expect((timedError as Error).message).toContain("CSV 上传读取超时");
    expect(timeoutCancel).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
    const abortCancel = vi.fn();
    const controller = new AbortController();
    const aborted = parseCsvUpload(input("", {
      stream: new ReadableStream<Uint8Array>({ cancel: abortCancel }),
      signal: controller.signal,
      timeoutMs: 1_000,
    }));
    controller.abort();
    const abortedError = await aborted.catch((error: unknown) => error);
    expect(abortedError).toMatchObject({ status: 408 });
    expect((abortedError as Error).message).toContain("CSV 上传已取消");
    expect(abortCancel).toHaveBeenCalledTimes(1);
  });

  it("解析 UTF-8、推断类型并建立字段映射", async () => {
    const result = await parseCsvUpload(input("订单号,金额,有效,日期\r\nA-1,12.5,true,2026-09-01\r\nA-2,20,false,2026-09-02"));
    expect(result.dataset.source.rowCount).toBe(2);
    expect(result.dataset.source.columnCount).toBe(4);
    expect(result.dataset.source.fields.map((field) => field.type)).toEqual(["string", "number", "boolean", "date"]);
    expect(result.dataset.fieldMappings.map((mapping) => mapping.originalName)).toEqual(["订单号", "金额", "有效", "日期"]);
    expect(result.dataset.fieldMappings.map((mapping) => mapping.normalizedName)).toEqual(["field_1", "field_2", "field_3", "field_4"]);
    expect(result.rows[0].field_2).toBe(12.5);
  });

  it("无效月末日期保持原始字符串而不被静默滚动", async () => {
    const invalid = await parseCsvUpload(input("event_date\n2026-02-31\n2026-09-31"));
    expect(invalid.dataset.source.fields[0].type).toBe("string");
    expect(invalid.rows).toEqual([{ event_date: "2026-02-31" }, { event_date: "2026-09-31" }]);

    const leapYear = await parseCsvUpload(input("event_date\n2024-02-29\n2024-03-01"));
    expect(leapYear.dataset.source.fields[0].type).toBe("date");
    expect(leapYear.rows[0].event_date).toBe("2024-02-29T00:00:00.000Z");
  });

  it("支持 UTF-8 BOM、引号、字段内逗号和多行字段", async () => {
    const result = await parseCsvUpload(input("\uFEFFid,note\n1,\"虚构值,含逗号\"\n2,\"第一行\n第二行\""));
    expect(result.rows).toEqual([
      { id: 1, note: "虚构值,含逗号" },
      { id: 2, note: "第一行\n第二行" },
    ]);
  });

  it("规范化空字段名和重复字段名", async () => {
    const result = await parseCsvUpload(input(",amount,amount\nA,1,2"));
    expect(result.dataset.fieldMappings).toEqual([
      { index: 0, originalName: "", normalizedName: "field_1" },
      { index: 1, originalName: "amount", normalizedName: "amount" },
      { index: 2, originalName: "amount", normalizedName: "amount_2" },
    ]);
  });

  it("预带后缀、空表头与截断后的规范化名称仍全局唯一且不覆盖列值", async () => {
    const longPrefix = "A".repeat(108);
    const result = await parseCsvUpload(input([
      `,field_1,amount,amount_2,amount,${longPrefix}X,${longPrefix}Y`,
      "blank,named,1,2,3,left,right",
    ].join("\n")));
    const names = result.dataset.fieldMappings.map((mapping) => mapping.normalizedName);

    expect(names).toEqual([
      "field_1",
      "field_1_2",
      "amount",
      "amount_2",
      "amount_3",
      longPrefix,
      `${longPrefix}_2`,
    ]);
    expect(new Set(names).size).toBe(names.length);
    expect(names.every((name) => name.length <= 120)).toBe(true);
    expect(result.rows[0]).toMatchObject({
      field_1: "blank",
      field_1_2: "named",
      amount: 1,
      amount_2: 2,
      amount_3: 3,
      [longPrefix]: "left",
      [`${longPrefix}_2`]: "right",
    });
  });

  it("拒绝错误编码、NUL 和二进制伪装", async () => {
    await expect(parseCsvUpload({ ...input("x\n1"), stream: byteStream(new Uint8Array([0xff, 0xfe, 0x78, 0x00])) })).rejects.toThrow(/NUL|编码/);
    await expect(parseCsvUpload({ ...input("x\n1"), stream: byteStream(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4])) })).rejects.toThrow(/压缩|Office/);
    await expect(parseCsvUpload({ ...input("x\n1"), stream: byteStream(new Uint8Array([0xc3, 0x28])) })).rejects.toThrow(/编码/);
  });

  it("在流式解析时执行文件、行、列和单元格限制", async () => {
    await expect(parseCsvUpload(input("a\n12345", { limits: { ...CSV_UPLOAD_LIMITS, maxFileBytes: 3 } }))).rejects.toMatchObject({ status: 413 });
    await expect(parseCsvUpload(input("a\n1\n2", { limits: { ...CSV_UPLOAD_LIMITS, maxRows: 1 } }))).rejects.toMatchObject({ status: 413 });
    await expect(parseCsvUpload(input("a,b\n1,2", { limits: { ...CSV_UPLOAD_LIMITS, maxColumns: 1 } }))).rejects.toMatchObject({ status: 413 });
    await expect(parseCsvUpload(input("a\n12345", { limits: { ...CSV_UPLOAD_LIMITS, maxCellChars: 4 } }))).rejects.toMatchObject({ status: 413 });
    const cellsError = await parseCsvUpload(input("a,b\n1,2\n3,4\n5,6", { limits: { maxCells: 4 } }))
      .catch((error: unknown) => error);
    expect(cellsError).toMatchObject({ status: 413 });
    expect((cellsError as Error).message).toMatch(/^CSV 单元格总量超限/u);
    await expect(parseCsvUpload(input("a\n1\n2\n3\n4", { limits: { maxCells: 4 } }))).resolves.toMatchObject({ rows: { length: 4 } });
    await expect(parseCsvUpload(input("a,b,c,d\n1,2,3,4", { limits: { maxCells: 4 } }))).resolves.toMatchObject({ rows: { length: 1 } });
  });

  it("全局宽长组合与必然超限响应在构建数据集前拒绝", async () => {
    const fieldNames = Array.from({ length: CSV_UPLOAD_LIMITS.maxColumns }, (_, index) => `c${index}`);
    const emptyRowCsvBytes = CSV_UPLOAD_LIMITS.maxColumns - 1;
    const maximumCsvBytes = new TextEncoder().encode(fieldNames.join(",")).byteLength
      + 1
      + CSV_UPLOAD_LIMITS.maxRows * (emptyRowCsvBytes + 1)
      - 1;
    const nullRowJsonBytes = new TextEncoder().encode(JSON.stringify(Object.fromEntries(fieldNames.map((name) => [name, null])))).byteLength;
    expect(maximumCsvBytes).toBeLessThan(CSV_UPLOAD_LIMITS.maxFileBytes);
    expect(CSV_UPLOAD_LIMITS.maxRows * CSV_UPLOAD_LIMITS.maxColumns).toBeGreaterThan(CSV_UPLOAD_LIMITS.maxCells);
    expect(nullRowJsonBytes * CSV_UPLOAD_LIMITS.maxRows).toBeGreaterThan(MAX_DATASET_RESPONSE_BYTES);

    const longHeaders = Array.from({ length: 100 }, (_, index) => `${String.fromCharCode(65 + index % 26)}${index}_${"x".repeat(100)}`);
    const text = `${longHeaders.join(",")}\n${Array.from({ length: 4_000 }, () => Array(100).fill("0").join(",")).join("\n")}`;
    const now = vi.fn(() => new Date("2026-09-02T06:00:00.000Z"));
    const responseError = await parseCsvUpload(input(text, {
      stream: byteStream(new TextEncoder().encode(text)),
      now,
    })).catch((error: unknown) => error);
    expect(responseError).toMatchObject({ status: 413 });
    expect((responseError as Error).message).toMatch(/^CSV 响应体积必然超限/u);
    expect(now).not.toHaveBeenCalled();
  });

  it("上传限制必须是正安全整数且不能放宽全局硬上限", async () => {
    await expect(parseCsvUpload(input("a\n1", { limits: { maxRows: 0 } }))).rejects.toThrow(/限制配置不合法.*maxRows/);
    await expect(parseCsvUpload(input("a\n1", { limits: { maxColumns: 1.5 } }))).rejects.toThrow(/限制配置不合法.*maxColumns/);
    await expect(parseCsvUpload(input("a\n1", { limits: { maxCells: CSV_UPLOAD_LIMITS.maxCells + 1 } })))
      .rejects.toThrow(/限制配置不合法.*maxCells/);
    await expect(parseCsvUpload(input("a\n1", { limits: { maxFileBytes: CSV_UPLOAD_LIMITS.maxFileBytes + 1 } })))
      .rejects.toThrow(/限制配置不合法.*maxFileBytes/);
    await expect(parseCsvUpload(input("a\n1", { limits: { retentionMs: Number.MAX_SAFE_INTEGER + 1 } })))
      .rejects.toThrow(/限制配置不合法.*retentionMs/);
  });

  it("生成空值、重复行、类型冲突、异常值和敏感字段风险摘要", async () => {
    const result = await parseCsvUpload(input("email,amount\nsynthetic-a@example.invalid,10\nsynthetic-a@example.invalid,10\nsynthetic-b@example.invalid,11\n,999\nsynthetic-c@example.invalid,unknown"));
    expect(result.dataset.source.quality?.nullCellCount).toBe(1);
    expect(result.dataset.source.quality?.duplicateRowCount).toBe(1);
    expect(result.dataset.source.quality?.typeConflictCount).toBeGreaterThan(0);
    expect(result.dataset.source.fields.find((field) => field.name === "email")).toMatchObject({ nullCount: 1, uniqueCount: 3 });
    expect(result.dataset.sensitiveFields[0]).toMatchObject({ field: "email", categories: ["email"] });
    expect(result.dataset.aiAccessPolicy).toBe("pending");
  });

  it("字段唯一值按规范类型统计并与重复行保持一致", async () => {
    const numeric = await parseCsvUpload(input("amount\n1\n1.0\n01"));
    expect(numeric.dataset.source.fields[0]).toMatchObject({ type: "number", uniqueCount: 1 });
    expect(numeric.dataset.source.quality?.duplicateRowCount).toBe(2);
    expect(numeric.rows).toEqual([{ amount: 1 }, { amount: 1 }, { amount: 1 }]);

    const text = await parseCsvUpload(input("code\nA\na\nA "));
    expect(text.dataset.source.fields[0]).toMatchObject({ type: "string", uniqueCount: 3 });
    expect(text.rows).toEqual([{ code: "A" }, { code: "a" }, { code: "A " }]);
  });

  it("拒绝描述符、数据源、配方、映射、敏感目录和实际行之间的不一致", async () => {
    const valid = await parseCsvUpload(input("email,amount\nsynthetic@example.invalid,10"));
    expect(datasetUploadResponseSchema.safeParse(valid).success).toBe(true);
    const mutations: Array<[string, (candidate: DatasetUploadResponse) => void]> = [
      ["数据源 ID", (candidate) => { candidate.dataset.source.id = "dataset_upload_1234567890abcdef"; }],
      ["配方数据源", (candidate) => { candidate.dataset.recipe.sourceDatasetId = "dataset_upload_1234567890abcdef"; }],
      ["实际行数", (candidate) => { candidate.dataset.source.rowCount += 1; }],
      ["创建时间", (candidate) => { candidate.dataset.source.updatedAt = "2026-09-02T06:00:01.000Z"; }],
      ["到期时间", (candidate) => { candidate.dataset.source.expiresAt = "2026-09-02T06:31:00.000Z"; }],
      ["AI 策略", (candidate) => { candidate.dataset.aiAccessPolicy = "masked"; }],
      ["保留分钟", (candidate) => { candidate.dataset.retentionMinutes += 1; }],
      ["字段映射", (candidate) => { candidate.dataset.fieldMappings[0].normalizedName = "other"; }],
      ["敏感目录", (candidate) => { candidate.dataset.sensitiveFields[0].categories = ["phone"]; }],
      ["隐藏行字段", (candidate) => { candidate.rows[0].hidden_secret = "不可接受"; }],
      ["字段类型", (candidate) => { candidate.rows[0].amount = "10"; }],
    ];

    for (const [label, mutate] of mutations) {
      const candidate = structuredClone(valid);
      mutate(candidate);
      expect(datasetUploadResponseSchema.safeParse(candidate).success, label).toBe(false);
    }
  });

  it("拒绝非 CSV 扩展名和不受支持 MIME", async () => {
    await expect(parseCsvUpload(input("a\n1", { originalFileName: "macro.xlsm" }))).rejects.toBeInstanceOf(CsvDatasetError);
    await expect(parseCsvUpload(input("a\n1", { mimeType: "application/zip" }))).rejects.toMatchObject({ status: 415 });
  });
});
