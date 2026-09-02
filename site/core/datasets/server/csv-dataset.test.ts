import { describe, expect, it } from "vitest";
import { CSV_UPLOAD_LIMITS } from "../contracts";
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
  it("解析 UTF-8、推断类型并建立字段映射", async () => {
    const result = await parseCsvUpload(input("订单号,金额,有效,日期\r\nA-1,12.5,true,2026-09-01\r\nA-2,20,false,2026-09-02"));
    expect(result.dataset.source.rowCount).toBe(2);
    expect(result.dataset.source.columnCount).toBe(4);
    expect(result.dataset.source.fields.map((field) => field.type)).toEqual(["string", "number", "boolean", "date"]);
    expect(result.dataset.fieldMappings.map((mapping) => mapping.originalName)).toEqual(["订单号", "金额", "有效", "日期"]);
    expect(result.dataset.fieldMappings.map((mapping) => mapping.normalizedName)).toEqual(["field_1", "field_2", "field_3", "field_4"]);
    expect(result.rows[0].field_2).toBe(12.5);
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

  it("拒绝非 CSV 扩展名和不受支持 MIME", async () => {
    await expect(parseCsvUpload(input("a\n1", { originalFileName: "macro.xlsm" }))).rejects.toBeInstanceOf(CsvDatasetError);
    await expect(parseCsvUpload(input("a\n1", { mimeType: "application/zip" }))).rejects.toMatchObject({ status: 415 });
  });
});
