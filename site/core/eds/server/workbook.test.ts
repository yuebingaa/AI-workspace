import writeXlsxFile, { type Cell, type SheetData } from "write-excel-file/node";
import { inflateRawSync } from "node:zlib";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { describe, expect, it, vi } from "vitest";
import { analyzeEdsWorkbook, type EdsCellValue, type EdsWorkbookSheet } from "@/core/eds";
import { EDS_UPLOAD_LIMITS } from "@/core/eds/contracts";
import { createSyntheticEdsFixture } from "@/fixtures/eds-synthetic";
import { generateEdsReportExcel, readEdsXlsx } from "./workbook";
import { validateXlsxArchive } from "./xlsx-archive";

function writableCell(value: EdsCellValue): Cell {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return { value, type: Date, format: "yyyy-mm-dd" };
  if (typeof value === "number") return { value, type: Number };
  if (typeof value === "boolean") return { value, type: Boolean };
  return { value: String(value), type: String };
}

async function workbookBuffer(sheets: EdsWorkbookSheet[]): Promise<Buffer> {
  return writeXlsxFile(sheets.map((sheet) => ({
    sheet: sheet.sheet,
    data: sheet.data.map((row) => row.map(writableCell)) as SheetData,
  }))).toBuffer();
}

function zipEntryText(buffer: Buffer, entryName: string): string {
  const nameBytes = Buffer.from(entryName, "utf8");
  const nameOffset = buffer.lastIndexOf(nameBytes);
  const centralOffset = nameOffset - 46;
  if (nameOffset < 46 || buffer.readUInt32LE(centralOffset) !== 0x02014b50) throw new Error(`ZIP entry not found: ${entryName}`);
  const compressionMethod = buffer.readUInt16LE(centralOffset + 10);
  const compressedBytes = buffer.readUInt32LE(centralOffset + 20);
  const localOffset = buffer.readUInt32LE(centralOffset + 42);
  if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`ZIP local entry invalid: ${entryName}`);
  const localNameBytes = buffer.readUInt16LE(localOffset + 26);
  const localExtraBytes = buffer.readUInt16LE(localOffset + 28);
  const dataOffset = localOffset + 30 + localNameBytes + localExtraBytes;
  const compressed = buffer.subarray(dataOffset, dataOffset + compressedBytes);
  if (compressionMethod === 0) return compressed.toString("utf8");
  if (compressionMethod === 8) return inflateRawSync(compressed).toString("utf8");
  throw new Error(`Unsupported ZIP compression method: ${compressionMethod}`);
}

function rewriteZipEntryText(buffer: Buffer, entryName: string, transform: (value: string) => string): Buffer {
  const entries = unzipSync(buffer);
  const entry = entries[entryName];
  if (!entry) throw new Error(`ZIP entry not found: ${entryName}`);
  entries[entryName] = strToU8(transform(strFromU8(entry)));
  return Buffer.from(zipSync(entries));
}

function centralEntries(buffer: Buffer) {
  const endOffset = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (endOffset < 0) throw new Error("ZIP end record not found");
  const count = buffer.readUInt16LE(endOffset + 10);
  const directoryOffset = buffer.readUInt32LE(endOffset + 16);
  const entries: Array<{
    offset: number;
    nameStart: number;
    nameLength: number;
    localOffset: number;
    flags: number;
    crc32: number;
    compressedBytes: number;
    uncompressedBytes: number;
  }> = [];
  let offset = directoryOffset;
  for (let index = 0; index < count; index += 1) {
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    entries.push({
      offset,
      nameStart: offset + 46,
      nameLength,
      localOffset: buffer.readUInt32LE(offset + 42),
      flags: buffer.readUInt16LE(offset + 8),
      crc32: buffer.readUInt32LE(offset + 16),
      compressedBytes: buffer.readUInt32LE(offset + 20),
      uncompressedBytes: buffer.readUInt32LE(offset + 24),
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return { directoryOffset, entries };
}

function withSignedDataDescriptor(buffer: Buffer): { buffer: Buffer; centralOffset: number; descriptorOffset: number } {
  const { entries } = centralEntries(buffer);
  const descriptorEntries = entries.filter(({ flags }) => (flags & 0x0008) !== 0);
  if (descriptorEntries.length === 0) throw new Error("Fixture ZIP has no data descriptor entries");
  const entry = descriptorEntries.reduce((latest, candidate) => candidate.localOffset > latest.localOffset ? candidate : latest);
  const localNameLength = buffer.readUInt16LE(entry.localOffset + 26);
  const localExtraLength = buffer.readUInt16LE(entry.localOffset + 28);
  const descriptorOffset = entry.localOffset + 30 + localNameLength + localExtraLength + entry.compressedBytes;
  if (
    buffer.readUInt32LE(descriptorOffset) !== 0x08074b50
    || buffer.readUInt32LE(descriptorOffset + 4) !== entry.crc32
    || buffer.readUInt32LE(descriptorOffset + 8) !== entry.compressedBytes
    || buffer.readUInt32LE(descriptorOffset + 12) !== entry.uncompressedBytes
  ) throw new Error("Fixture ZIP has an unexpected data descriptor layout");
  return { buffer: Buffer.from(buffer), centralOffset: entry.offset, descriptorOffset };
}

describe("EDS XLSX 读写", () => {
  it("读取多工作表并把确定性结果导出为可重新读取的 XLSX", async () => {
    const fixture = createSyntheticEdsFixture();
    const source = await readEdsXlsx({ buffer: await workbookBuffer(fixture.sourceSheets), originalFileName: "合成输入.xlsx" });
    const template = await readEdsXlsx({ buffer: await workbookBuffer(fixture.templateSheets), originalFileName: "合成目标.xlsx" });
    const analysis = analyzeEdsWorkbook(source, template);
    const generated = await generateEdsReportExcel(analysis, new Date("2026-09-04T00:00:00.000Z"));
    const exported = await readEdsXlsx({ buffer: generated.buffer, originalFileName: generated.fileName });
    const roundTrip = analyzeEdsWorkbook(source, exported);

    expect(generated.fileName).toBe("EDS飞达异常统计_2026-08-25_白班.xlsx");
    expect(generated.buffer.subarray(0, 2).toString()).toBe("PK");
    expect(roundTrip.comparison).toMatchObject({ coreMatched: 560, reportMatched: 660, mismatchCount: 0 });
    const sheetXml = zipEntryText(generated.buffer, "xl/worksheets/sheet1.xml");
    expect(sheetXml).toMatch(/<col[^>]*min="1"[^>]*hidden="1"/u);
    expect(sheetXml).toMatch(/<col[^>]*min="2"[^>]*hidden="1"/u);
    for (const row of [2, 3, 4]) expect(sheetXml).toMatch(new RegExp(`<row[^>]*r="${row}"[^>]*hidden="1"`, "u"));
    const rowTags = [...sheetXml.matchAll(/<row\b[^>]*\br="(\d+)"[^>]*>/gu)];
    expect(rowTags).toHaveLength(36);
    const specialHeights = new Map([[1, 20.4], [3, 52.2], [4, 34.8], [6, 18.15]]);
    for (const rowTag of rowTags) {
      const row = Number(rowTag[1]);
      expect(rowTag[0]).toMatch(new RegExp(`\\bht="${specialHeights.get(row) ?? 17.4}"`, "u"));
      expect(rowTag[0]).toMatch(/\bcustomHeight="1"/u);
    }
  });

  it("公式目标单元格只使用缓存值，缺失或错误缓存会形成明确差异", async () => {
    const fixture = createSyntheticEdsFixture();
    const source = await readEdsXlsx({ buffer: await workbookBuffer(fixture.sourceSheets), originalFileName: "合成输入.xlsx" });
    const templateBuffer = await workbookBuffer(fixture.templateSheets);
    const cellPattern = /<c\b([^>]*\br="E7"[^>]*)>([\s\S]*?)<\/c>/u;
    const cell = cellPattern.exec(zipEntryText(templateBuffer, "xl/worksheets/sheet1.xml"));
    expect(cell).not.toBeNull();
    const attributes = cell?.[1].replace(/\s+t="[^"]*"/gu, "");
    const cachedValue = /<v>([^<]+)<\/v>/u.exec(cell?.[2] ?? "")?.[1];
    if (!attributes || !cachedValue) throw new Error("Fixture E7 must contain attributes and a cached numeric value");

    const rewriteCell = (body: string, type?: string) => rewriteZipEntryText(
      templateBuffer,
      "xl/worksheets/sheet1.xml",
      (xml) => xml.replace(cellPattern, `<c${attributes}${type ? ` t="${type}"` : ""}>${body}</c>`),
    );
    const dynamicArray = rewriteCell(`<f t="array" ref="E7">SUM(E7)</f><v>${cachedValue}</v>`);
    const missingCache = rewriteCell("<f>SUM(E7)</f>");
    const errorCache = rewriteCell("<f>SUM(E7)</f><v>#DIV/0!</v>", "e");

    const dynamicTemplate = await readEdsXlsx({ buffer: dynamicArray, originalFileName: "dynamic-array.xlsx" });
    expect(analyzeEdsWorkbook(source, dynamicTemplate).comparison.mismatchCount).toBe(0);
    for (const mutated of [missingCache, errorCache]) {
      const template = await readEdsXlsx({ buffer: mutated, originalFileName: "invalid-formula-cache.xlsx" });
      const comparison = analyzeEdsWorkbook(source, template).comparison;
      expect(comparison.mismatchCount).toBe(1);
      expect(comparison.mismatches[0]).toMatchObject({ cell: "E7", expected: null });
    }
  });

  it("1900 与 1904 日期系统解析为相同 UTC 工作日", async () => {
    const original = await workbookBuffer([{ sheet: "日期", data: [[new Date("2026-08-25T00:00:00.000Z")]] }]);
    const originalDate = (await readEdsXlsx({ buffer: original, originalFileName: "epoch-1900.xlsx" }))[0].data[0][0];
    const with1904Workbook = rewriteZipEntryText(original, "xl/workbook.xml", (xml) => (
      xml.replace(/<workbook\b[^>]*>/u, (tag) => `${tag}<workbookPr date1904="1"/>`)
    ));
    const with1904Date = rewriteZipEntryText(with1904Workbook, "xl/worksheets/sheet1.xml", (xml) => (
      xml.replace(/(<c\b[^>]*\br="A1"[^>]*>[\s\S]*?<v>)(-?\d+(?:\.\d+)?)(<\/v>)/u, (_, before: string, serial: string, after: string) => (
        `${before}${Number(serial) - 1_462}${after}`
      ))
    ));
    const convertedDate = (await readEdsXlsx({ buffer: with1904Date, originalFileName: "epoch-1904.xlsx" }))[0].data[0][0];

    expect(originalDate).toBeInstanceOf(Date);
    expect(convertedDate).toBeInstanceOf(Date);
    expect((originalDate as Date).toISOString()).toBe("2026-08-25T00:00:00.000Z");
    expect((convertedDate as Date).toISOString()).toBe((originalDate as Date).toISOString());
  });

  it("兼容 ISO 日期单元格并拒绝非法日期和样式索引语法", async () => {
    const fixture = createSyntheticEdsFixture();
    const original = await workbookBuffer(fixture.sourceSheets);
    const withIsoDate = rewriteZipEntryText(original, "xl/worksheets/sheet1.xml", (xml) => (
      xml.replace(
        /<c\b([^>]*\br="E2"[^>]*)>[\s\S]*?<\/c>/u,
        (_, rawAttributes: string) => `<c${rawAttributes.replace(/\s+(?:s|t)="[^"]*"/gu, "")} t="d"><v>2026-08-25T00:00:00.000Z</v></c>`,
      )
    ));
    const source = await readEdsXlsx({ buffer: withIsoDate, originalFileName: "iso-date.xlsx" });
    const template = await readEdsXlsx({ buffer: await workbookBuffer(fixture.templateSheets), originalFileName: "template.xlsx" });
    expect(analyzeEdsWorkbook(source, template).comparison)
      .toMatchObject({ coreMatched: 560, reportMatched: 660, mismatchCount: 0 });

    const invalidIsoDate = rewriteZipEntryText(withIsoDate, "xl/worksheets/sheet1.xml", (xml) => (
      xml.replace("2026-08-25T00:00:00.000Z", "not-a-date")
    ));
    expect(() => validateXlsxArchive(invalidIsoDate)).toThrow("XLSX 工作表包含无效 ISO 日期");
    await expect(readEdsXlsx({ buffer: invalidIsoDate, originalFileName: "invalid-iso-date.xlsx" }))
      .rejects.toMatchObject({ status: 400, message: "XLSX 工作表包含无效 ISO 日期" });

    for (const invalidValue of [
      "2026-02-29T00:00:00.000Z",
      "2026-02-31T00:00:00.000Z",
      "2026-09-31T00:00:00.000Z",
      "2026-08-25T00:00:00.000Zgarbage",
    ]) {
      const invalidCalendarDate = rewriteZipEntryText(withIsoDate, "xl/worksheets/sheet1.xml", (xml) => (
        xml.replace("2026-08-25T00:00:00.000Z", invalidValue)
      ));
      expect(() => validateXlsxArchive(invalidCalendarDate)).toThrow("XLSX 工作表包含无效 ISO 日期");
    }

    const validLeapDate = rewriteZipEntryText(withIsoDate, "xl/worksheets/sheet1.xml", (xml) => (
      xml.replace("2026-08-25T00:00:00.000Z", "2024-02-29T00:00:00.000Z")
    ));
    expect(() => validateXlsxArchive(validLeapDate)).not.toThrow();
    expect(((await readEdsXlsx({ buffer: validLeapDate, originalFileName: "valid-leap-date.xlsx" }))[0].data[1][4] as Date).toISOString())
      .toBe("2024-02-29T00:00:00.000Z");

    for (const styleId of ["-1", "1.5"]) {
      const invalidStyle = rewriteZipEntryText(original, "xl/worksheets/sheet1.xml", (xml) => (
        xml.replace(/(<c\b[^>]*\br="E2")/u, `$1 s="${styleId}"`)
      ));
      expect(() => validateXlsxArchive(invalidStyle)).toThrow("XLSX 包含无效样式索引");
      await expect(readEdsXlsx({ buffer: invalidStyle, originalFileName: "invalid-style-index.xlsx" }))
        .rejects.toMatchObject({ status: 400, message: "XLSX 包含无效样式索引" });
    }
  });

  it("超大有限时长以科学计数法导出后仍可零差异回读", async () => {
    const fixture = createSyntheticEdsFixture();
    const matchingRow = fixture.sourceSheets.flatMap((sheet) => sheet.data).find((row) => (
      row[4] instanceof Date
      && row[4].toISOString().startsWith("2026-08-25")
      && row[5] === "白班"
      && row[2] === fixture.templateSheets[0].data[6][0]
    ));
    if (!matchingRow) throw new Error("Fixture must contain a matching EDS row");
    matchingRow[3] = 1e120;
    const analysis = analyzeEdsWorkbook(fixture.sourceSheets, fixture.templateSheets);
    expect(Number.isFinite(analysis.summary.totalMinutes)).toBe(true);
    const generated = await generateEdsReportExcel(analysis, new Date("2026-09-04T00:00:00.000Z"));
    expect(generated.buffer.byteLength).toBeLessThanOrEqual(EDS_UPLOAD_LIMITS.maxFileBytes);
    expect(zipEntryText(generated.buffer, "xl/worksheets/sheet1.xml")).toMatch(/\d(?:\.\d+)?e\+\d+/iu);

    const exported = await readEdsXlsx({ buffer: generated.buffer, originalFileName: generated.fileName });
    const roundTrip = analyzeEdsWorkbook(fixture.sourceSheets, exported);
    expect(roundTrip.comparison).toMatchObject({ coreMatched: 560, reportMatched: 660, mismatchCount: 0 });
    expect(Number.isFinite(roundTrip.summary.totalMinutes)).toBe(true);
  });

  it("拒绝由恶意数值缓存产生的 Infinity", async () => {
    const fixture = createSyntheticEdsFixture();
    const original = await workbookBuffer(fixture.sourceSheets);
    const mutated = rewriteZipEntryText(original, "xl/worksheets/sheet1.xml", (xml) => {
      const durationCell = /(<c\b[^>]*\br="D2"[^>]*>[\s\S]*?<v>)[^<]+(<\/v>)/u;
      expect(xml).toMatch(durationCell);
      return xml.replace(durationCell, "$1Infinity$2");
    });
    expect(() => validateXlsxArchive(mutated)).not.toThrow();
    await expect(readEdsXlsx({ buffer: mutated, originalFileName: "non-finite.xlsx" }))
      .rejects.toMatchObject({ status: 400, message: expect.stringMatching(/包含非有限数值/u) });
  });

  it("隐藏行与 autoFilter 只改变显示状态而不改变 EDS 统计", async () => {
    const fixture = createSyntheticEdsFixture();
    const original = await workbookBuffer(fixture.sourceSheets);
    const mutated = rewriteZipEntryText(original, "xl/worksheets/sheet1.xml", (xml) => (
      xml
        .replace(/<row\b([^>]*)\br="2"/u, '<row$1r="2" hidden="1"')
        .replace("</sheetData>", '</sheetData><autoFilter ref="A1:G2"/>')
    ));
    const [source, template] = await Promise.all([
      readEdsXlsx({ buffer: mutated, originalFileName: "hidden-filtered.xlsx" }),
      readEdsXlsx({ buffer: await workbookBuffer(fixture.templateSheets), originalFileName: "target.xlsx" }),
    ]);
    const result = analyzeEdsWorkbook(source, template);
    expect(result.comparison).toMatchObject({ coreMatched: 560, reportMatched: 660, mismatchCount: 0 });
    expect(result.summary.matchedRows).toBe(analyzeEdsWorkbook(fixture.sourceSheets, fixture.templateSheets).summary.matchedRows);
  });

  it("导出不复制模板外部链接并把危险前缀标签保持为普通字符串", async () => {
    const fixture = createSyntheticEdsFixture();
    const source = await readEdsXlsx({ buffer: await workbookBuffer(fixture.sourceSheets), originalFileName: "合成输入.xlsx" });
    const template = await readEdsXlsx({ buffer: await workbookBuffer(fixture.templateSheets), originalFileName: "合成目标.xlsx" });
    const analysis = analyzeEdsWorkbook(source, template);
    analysis.template.issues[0].raw = "+SUM(A1:A2)";
    analysis.template.issues[0].display = "=1+1";
    analysis.template.channels[0].displayLine = "-1+2";
    analysis.template.channels[0].displayChannel = "@SUM(A1:A2)";
    const generated = await generateEdsReportExcel(analysis, new Date("2026-09-04T00:00:00.000Z"));

    const entryNames = centralEntries(generated.buffer).entries.map(({ nameStart, nameLength }) => (
      generated.buffer.subarray(nameStart, nameStart + nameLength).toString("utf8")
    ));
    expect(entryNames.some((name) => name.includes("externalLinks"))).toBe(false);
    expect(zipEntryText(generated.buffer, "xl/_rels/workbook.xml.rels")).not.toContain("externalLink");
    expect(zipEntryText(generated.buffer, "xl/worksheets/sheet1.xml")).not.toMatch(/<f(?:\s|>)/u);
    const sharedStrings = zipEntryText(generated.buffer, "xl/sharedStrings.xml");
    for (const label of ["+SUM(A1:A2)", "=1+1", "-1+2", "@SUM(A1:A2)"]) expect(sharedStrings).toContain(label);
  });

  it("拒绝错误扩展名、MIME、文件头和超过大小限制的内容", async () => {
    const tiny = Buffer.from("not xlsx");
    await expect(readEdsXlsx({ buffer: tiny, originalFileName: "bad.xls" })).rejects.toThrow(/仅支持/);
    await expect(readEdsXlsx({ buffer: tiny, originalFileName: "bad.xlsx", mimeType: "text/plain; token=secret" }))
      .rejects.toThrow(/^XLSX MIME 类型不支持$/);
    await expect(readEdsXlsx({ buffer: tiny, originalFileName: "bad.xlsx" })).rejects.toThrow(/文件头/);
  });

  it("在解压前拒绝会展开为超大内容的 XLSX", async () => {
    const fixture = createSyntheticEdsFixture();
    const buffer = await workbookBuffer(fixture.sourceSheets);
    const centralSignature = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
    const centralOffset = buffer.indexOf(centralSignature);
    expect(centralOffset).toBeGreaterThanOrEqual(0);
    buffer.writeUInt32LE(EDS_UPLOAD_LIMITS.maxArchiveEntryBytes + 1, centralOffset + 24);

    await expect(readEdsXlsx({ buffer, originalFileName: "expansion-bomb.xlsx" }))
      .rejects.toThrow(/单个条目展开后过大/);
  });

  it("拒绝只有 ZIP 外壳、但缺少 XLSX 核心条目的文件", async () => {
    const fixture = createSyntheticEdsFixture();
    const buffer = await workbookBuffer(fixture.sourceSheets);
    const replacement = Buffer.from("[Content_Other].xml", "utf8");
    const entry = centralEntries(buffer).entries.find(({ nameStart, nameLength }) => (
      buffer.subarray(nameStart, nameStart + nameLength).toString("utf8") === "[Content_Types].xml"
    ));
    expect(entry).toBeDefined();
    buffer.set(replacement, entry!.nameStart);
    buffer.set(replacement, entry!.localOffset + 30);

    await expect(readEdsXlsx({ buffer, originalFileName: "not-an-xlsx.xlsx" }))
      .rejects.toThrow(/不是有效的 XLSX/);

    const missingRelationships = await workbookBuffer(fixture.sourceSheets);
    const relationshipReplacement = Buffer.from("xl/_rels/workbook.xml.fail", "utf8");
    const relationshipEntry = centralEntries(missingRelationships).entries.find(({ nameStart, nameLength }) => (
      missingRelationships.subarray(nameStart, nameStart + nameLength).toString("utf8") === "xl/_rels/workbook.xml.rels"
    ));
    expect(relationshipEntry).toBeDefined();
    expect(relationshipReplacement).toHaveLength(relationshipEntry!.nameLength);
    missingRelationships.set(relationshipReplacement, relationshipEntry!.nameStart);
    missingRelationships.set(relationshipReplacement, relationshipEntry!.localOffset + 30);

    expect(() => validateXlsxArchive(missingRelationships)).toThrow(/不是有效的 XLSX/);
    await expect(readEdsXlsx({ buffer: missingRelationships, originalFileName: "missing-relationships.xlsx" }))
      .rejects.toThrow(/不是有效的 XLSX/);

    const missingRootRelationships = await workbookBuffer(fixture.sourceSheets);
    const rootRelationshipReplacement = Buffer.from("_rels/.fail", "utf8");
    const rootRelationshipEntry = centralEntries(missingRootRelationships).entries.find(({ nameStart, nameLength }) => (
      missingRootRelationships.subarray(nameStart, nameStart + nameLength).toString("utf8") === "_rels/.rels"
    ));
    expect(rootRelationshipEntry).toBeDefined();
    expect(rootRelationshipReplacement).toHaveLength(rootRelationshipEntry!.nameLength);
    missingRootRelationships.set(rootRelationshipReplacement, rootRelationshipEntry!.nameStart);
    missingRootRelationships.set(rootRelationshipReplacement, rootRelationshipEntry!.localOffset + 30);

    expect(() => validateXlsxArchive(missingRootRelationships)).toThrow(/不是有效的 XLSX/);
    await expect(readEdsXlsx({ buffer: missingRootRelationships, originalFileName: "missing-root-relationships.xlsx" }))
      .rejects.toThrow(/不是有效的 XLSX/);
  });

  it("关系目标为外部 URL 或路径上跳时失败闭合且不发出网络请求", async () => {
    const fixture = createSyntheticEdsFixture();
    const original = await workbookBuffer(fixture.sourceSheets);
    const targetPattern = /Target="[^"]*worksheets\/sheet1\.xml"/u;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected external request"));
    try {
      for (const replacement of [
        'Target="https://example.invalid/sheet1.xml" TargetMode="External"',
        'Target="../workbook.xml"',
      ]) {
        const mutated = rewriteZipEntryText(original, "xl/_rels/workbook.xml.rels", (xml) => {
          expect(xml).toMatch(targetPattern);
          return xml.replace(targetPattern, replacement);
        });
        expect(() => validateXlsxArchive(mutated)).not.toThrow();
        await expect(readEdsXlsx({ buffer: mutated, originalFileName: "unsafe-relationship.xlsx" }))
          .rejects.toMatchObject({ status: 400, message: "XLSX 工作簿无法解析或内容已损坏" });
      }
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("在 XML 解析前拒绝 DTD 与外部实体声明", async () => {
    const fixture = createSyntheticEdsFixture();
    const original = await workbookBuffer(fixture.sourceSheets);
    const mutated = rewriteZipEntryText(original, "xl/worksheets/sheet1.xml", (xml) => {
      const declarationEnd = xml.indexOf("?>");
      expect(declarationEnd).toBeGreaterThanOrEqual(0);
      return `${xml.slice(0, declarationEnd + 2)}<!DOCTYPE worksheet [<!ENTITY xxe SYSTEM "https://example.invalid/xxe">]>${xml.slice(declarationEnd + 2)}`;
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected external request"));
    try {
      expect(() => validateXlsxArchive(mutated)).toThrow("XLSX XML 不允许 DTD 或外部实体声明");
      await expect(readEdsXlsx({ buffer: mutated, originalFileName: "external-entity.xlsx" }))
        .rejects.toMatchObject({ status: 400, message: "XLSX XML 不允许 DTD 或外部实体声明" });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("深层且未闭合的 XML 结构快速归一为解析错误", async () => {
    const fixture = createSyntheticEdsFixture();
    const original = await workbookBuffer(fixture.sourceSheets);
    const mutated = rewriteZipEntryText(original, "xl/worksheets/sheet1.xml", (xml) => {
      const worksheetStart = xml.indexOf("<worksheet");
      const worksheetTagEnd = xml.indexOf(">", worksheetStart);
      expect(worksheetStart).toBeGreaterThanOrEqual(0);
      expect(worksheetTagEnd).toBeGreaterThan(worksheetStart);
      const deepMalformedXml = `${"<x>".repeat(4_096)}${"</x>".repeat(4_095)}`;
      return `${xml.slice(0, worksheetTagEnd + 1)}${deepMalformedXml}${xml.slice(worksheetTagEnd + 1)}`;
    });
    expect(() => validateXlsxArchive(mutated)).not.toThrow();
    await expect(readEdsXlsx({ buffer: mutated, originalFileName: "deep-malformed.xml.xlsx" }))
      .rejects.toMatchObject({ status: 400, message: "XLSX 工作簿无法解析或内容已损坏" });
  });

  it("在稀疏行列坐标触发解析器补空数组前执行既有限额", async () => {
    const fixture = createSyntheticEdsFixture();
    const original = await workbookBuffer(fixture.sourceSheets);
    const oversizedRow = rewriteZipEntryText(original, "xl/worksheets/sheet1.xml", (xml) => (
      xml.replace(/<row\b([^>]*)\br="\d+"/u, `<row$1r="${EDS_UPLOAD_LIMITS.maxRowsPerSheet + 1}"`)
    ));
    const oversizedColumn = rewriteZipEntryText(original, "xl/worksheets/sheet1.xml", (xml) => (
      xml.replace(/<c\b([^>]*)\br="[A-Z]+\d+"/u, '<c$1r="ZZ1"')
    ));
    const malformedCoordinate = rewriteZipEntryText(original, "xl/worksheets/sheet1.xml", (xml) => (
      xml.replace(/<c\b([^>]*)\br="[A-Z]+\d+"/u, '<c$1r="A-1"')
    ));
    const tooManyRows = rewriteZipEntryText(original, "xl/worksheets/sheet1.xml", (xml) => (
      xml.replace("<sheetData>", `<sheetData>${Array.from(
        { length: EDS_UPLOAD_LIMITS.maxRowsPerSheet + 1 },
        (_, index) => `<row r="${index + 1}"/>`,
      ).join("")}`)
    ));

    for (const mutated of [oversizedRow, oversizedColumn, tooManyRows]) {
      expect(() => validateXlsxArchive(mutated)).toThrow(/超过安全限制/);
      await expect(readEdsXlsx({ buffer: mutated, originalFileName: "oversized-coordinate.xlsx" }))
        .rejects.toMatchObject({ status: 413 });
    }
    expect(() => validateXlsxArchive(malformedCoordinate)).toThrow("XLSX 工作表包含无效行列坐标");
    await expect(readEdsXlsx({ buffer: malformedCoordinate, originalFileName: "malformed-coordinate.xlsx" }))
      .rejects.toMatchObject({ status: 400, message: "XLSX 工作表包含无效行列坐标" });
  });

  it("拒绝重复、乱序或缺失的显式坐标", async () => {
    const fixture = createSyntheticEdsFixture();
    const original = await workbookBuffer(fixture.sourceSheets);
    const duplicateCell = rewriteZipEntryText(original, "xl/worksheets/sheet1.xml", (xml) => (
      xml.replace(/\br="B1"/u, 'r="A1"')
    ));
    const duplicateRow = rewriteZipEntryText(original, "xl/worksheets/sheet1.xml", (xml) => (
      xml.replace(/(<row\b[^>]*\br=")2("[^>]*>)/u, (_, before: string, after: string) => `${before}1${after}`)
    ));
    const reversedCells = rewriteZipEntryText(original, "xl/worksheets/sheet1.xml", (xml) => {
      let references = 0;
      return xml.replace(/\br="(?:A1|B1)"/gu, (reference) => {
        references += 1;
        if (references === 1) return 'r="B1"';
        if (references === 2) return 'r="A1"';
        return reference;
      });
    });
    for (const mutated of [duplicateCell, duplicateRow, reversedCells]) {
      expect(() => validateXlsxArchive(mutated)).toThrow("XLSX 工作表包含重复或乱序的显式坐标");
      await expect(readEdsXlsx({ buffer: mutated, originalFileName: "ambiguous-coordinates.xlsx" }))
        .rejects.toMatchObject({ status: 400, message: "XLSX 工作表包含重复或乱序的显式坐标" });
    }

    const omittedCoordinates = rewriteZipEntryText(original, "xl/worksheets/sheet1.xml", (xml) => (
      xml
        .replace(/<row\b[^>]*>/u, (tag) => tag.replace(/\s+r="1"/u, ""))
        .replace(/<c\b[^>]*>/u, (tag) => tag.replace(/\s+r="A1"/u, ""))
    ));
    expect(() => validateXlsxArchive(omittedCoordinates)).toThrow("XLSX 工作表缺少显式行列坐标");
    await expect(readEdsXlsx({ buffer: omittedCoordinates, originalFileName: "omitted-coordinates.xlsx" }))
      .rejects.toMatchObject({ status: 400, message: "XLSX 工作表缺少显式行列坐标" });
  });

  it("在第三方解析前限制单工作表显式单元格数量", async () => {
    const fixture = createSyntheticEdsFixture();
    const original = await workbookBuffer(fixture.sourceSheets);
    const columnName = (column: number) => {
      let value = column;
      let name = "";
      while (value > 0) {
        value -= 1;
        name = String.fromCharCode(65 + (value % 26)) + name;
        value = Math.floor(value / 26);
      }
      return name;
    };
    let remainingCells = EDS_UPLOAD_LIMITS.maxCellsPerSheet + 1;
    const rows: string[] = [];
    for (let row = 1; remainingCells > 0; row += 1) {
      const cellsInRow = Math.min(EDS_UPLOAD_LIMITS.maxColumns, remainingCells);
      const cells = Array.from({ length: cellsInRow }, (_, index) => `<c r="${columnName(index + 1)}${row}"/>`).join("");
      rows.push(`<row r="${row}">${cells}</row>`);
      remainingCells -= cellsInRow;
    }
    const tooManyCells = rewriteZipEntryText(original, "xl/worksheets/sheet1.xml", (xml) => (
      xml.replace(/<sheetData>[\s\S]*?<\/sheetData>/u, `<sheetData>${rows.join("")}</sheetData>`)
    ));

    expect(() => validateXlsxArchive(tooManyCells)).toThrow("XLSX 工作表单元格数量超过安全限制");
    await expect(readEdsXlsx({ buffer: tooManyCells, originalFileName: "too-many-cells.xlsx" }))
      .rejects.toMatchObject({ status: 413, message: "XLSX 工作表单元格数量超过安全限制" });
  });

  it("在第三方解析前限制共享、富文本和内联字符串长度", async () => {
    const fixture = createSyntheticEdsFixture();
    const original = await workbookBuffer(fixture.sourceSheets);
    const tooManySharedStrings = rewriteZipEntryText(original, "xl/sharedStrings.xml", () => (
      `<?xml version="1.0" encoding="UTF-8"?><sst>${"<si/>".repeat(EDS_UPLOAD_LIMITS.maxSharedStrings + 1)}</sst>`
    ));
    expect(() => validateXlsxArchive(tooManySharedStrings)).toThrow("XLSX 共享字符串数量超过安全限制");
    await expect(readEdsXlsx({ buffer: tooManySharedStrings, originalFileName: "too-many-shared-strings.xlsx" }))
      .rejects.toMatchObject({ status: 413, message: "XLSX 共享字符串数量超过安全限制" });

    const firstSharedString = /<si\b[^>]*>[\s\S]*?<\/si>/u;
    const withSharedString = (body: string) => rewriteZipEntryText(original, "xl/sharedStrings.xml", (xml) => {
      expect(xml).toMatch(firstSharedString);
      return xml.replace(firstSharedString, `<si>${body}</si>`);
    });
    const boundaryCellText = withSharedString(`<t>${"x".repeat(EDS_UPLOAD_LIMITS.maxCellChars)}</t>`);
    const oversizedCellText = withSharedString(`<t>${"x".repeat(EDS_UPLOAD_LIMITS.maxCellChars + 1)}</t>`);
    const oversizedRichText = withSharedString(
      `<r><t>${"x".repeat(10_000)}</t></r><r><t>${"y".repeat(10_001)}</t></r>`,
    );
    const decodedEntityBoundary = withSharedString(`<t>${"&amp;".repeat(EDS_UPLOAD_LIMITS.maxCellChars)}</t>`);
    const decodedSurrogateOverflow = withSharedString(
      `<t>${"&amp;".repeat(EDS_UPLOAD_LIMITS.maxCellChars - 1)}&#x1F600;</t>`,
    );

    expect(() => validateXlsxArchive(boundaryCellText)).not.toThrow();
    expect(() => validateXlsxArchive(decodedEntityBoundary)).not.toThrow();
    for (const oversized of [oversizedCellText, oversizedRichText, decodedSurrogateOverflow]) {
      expect(() => validateXlsxArchive(oversized)).toThrow("XLSX 包含超长文本单元格");
    }
    await expect(readEdsXlsx({ buffer: oversizedCellText, originalFileName: "oversized-cell-text.xlsx" }))
      .rejects.toMatchObject({ status: 413, message: expect.stringMatching(/超长文本单元格/u) });

    const firstCell = /<c\b([^>]*\br="A1"[^>]*)>[\s\S]*?<\/c>/u;
    const withInlineString = (body: string) => rewriteZipEntryText(original, "xl/worksheets/sheet1.xml", (xml) => (
      xml.replace(firstCell, (_, rawAttributes: string) => {
        const attributes = rawAttributes.replace(/\s+t="[^"]*"/gu, "");
        return `<c${attributes} t="inlineStr"><is>${body}</is></c>`;
      })
    ));
    const boundaryInline = withInlineString(`<t>${"x".repeat(EDS_UPLOAD_LIMITS.maxCellChars)}</t>`);
    const oversizedInline = withInlineString(
      `<r><t>${"x".repeat(EDS_UPLOAD_LIMITS.maxCellChars / 2)}</t></r>`
      + `<r><t>${"y".repeat(EDS_UPLOAD_LIMITS.maxCellChars / 2 + 1)}</t></r>`,
    );
    expect(() => validateXlsxArchive(boundaryInline)).not.toThrow();
    expect(() => validateXlsxArchive(oversizedInline)).toThrow("XLSX 包含超长文本单元格");
  });

  it("在第三方查表前校验共享字符串索引语法与上界", async () => {
    const fixture = createSyntheticEdsFixture();
    const original = await workbookBuffer(fixture.sourceSheets);
    const withFirstSharedStringIndex = (value: string) => rewriteZipEntryText(
      original,
      "xl/worksheets/sheet1.xml",
      (xml) => xml.replace(
        /(<c\b[^>]*\bt="s"[^>]*>[\s\S]*?<v>)[\s\S]*?(<\/v>)/u,
        `$1${value}$2`,
      ),
    );

    for (const value of ["-1", "1.5", ""]) {
      const invalid = withFirstSharedStringIndex(value);
      expect(() => validateXlsxArchive(invalid)).toThrow("XLSX 工作表包含无效共享字符串索引");
      await expect(readEdsXlsx({ buffer: invalid, originalFileName: "invalid-shared-string-index.xlsx" }))
        .rejects.toMatchObject({ status: 400, message: "XLSX 工作表包含无效共享字符串索引" });
    }

    const oversized = withFirstSharedStringIndex(String(EDS_UPLOAD_LIMITS.maxSharedStrings));
    expect(() => validateXlsxArchive(oversized)).toThrow("XLSX 共享字符串索引超过安全限制");
    await expect(readEdsXlsx({ buffer: oversized, originalFileName: "oversized-shared-string-index.xlsx" }))
      .rejects.toMatchObject({ status: 413, message: "XLSX 共享字符串索引超过安全限制" });
  });

  it("拒绝非法布尔及未知类型并兼容等价内联字符串", async () => {
    const fixture = createSyntheticEdsFixture();
    const original = await workbookBuffer(fixture.sourceSheets);
    const firstCell = /<c\b([^>]*\br="A1"[^>]*)>[\s\S]*?<\/c>/u;
    const rewriteFirstCell = (type: string, body: string) => rewriteZipEntryText(
      original,
      "xl/worksheets/sheet1.xml",
      (xml) => xml.replace(firstCell, (_, rawAttributes: string) => {
        const attributes = rawAttributes.replace(/\s+t="[^"]*"/gu, "");
        return `<c${attributes} t="${type}">${body}</c>`;
      }),
    );

    for (const body of ["<v>2</v>", "<v></v>"]) {
      const invalidBoolean = rewriteFirstCell("b", body);
      expect(() => validateXlsxArchive(invalidBoolean)).toThrow("XLSX 工作表包含无效布尔值");
      await expect(readEdsXlsx({ buffer: invalidBoolean, originalFileName: "invalid-boolean.xlsx" }))
        .rejects.toMatchObject({ status: 400, message: "XLSX 工作表包含无效布尔值" });
    }

    const unknownType = rewriteFirstCell("opaque", "<v>0</v>");
    expect(() => validateXlsxArchive(unknownType)).toThrow("XLSX 工作表包含不支持的单元格类型");
    await expect(readEdsXlsx({ buffer: unknownType, originalFileName: "unknown-cell-type.xlsx" }))
      .rejects.toMatchObject({ status: 400, message: "XLSX 工作表包含不支持的单元格类型" });

    const inlineString = rewriteFirstCell("inlineStr", "<is><t>Line</t></is>");
    expect(() => validateXlsxArchive(inlineString)).not.toThrow();
    const source = await readEdsXlsx({ buffer: inlineString, originalFileName: "inline-string.xlsx" });
    const template = await readEdsXlsx({ buffer: await workbookBuffer(fixture.templateSheets), originalFileName: "template.xlsx" });
    expect(analyzeEdsWorkbook(source, template).comparison)
      .toMatchObject({ coreMatched: 560, reportMatched: 660, mismatchCount: 0 });
  });

  it("在样式解析前限制条目数量与稀疏数字索引", async () => {
    const fixture = createSyntheticEdsFixture();
    const original = await workbookBuffer(fixture.sourceSheets);
    const tooManyStyles = rewriteZipEntryText(original, "xl/styles.xml", () => (
      `<?xml version="1.0" encoding="UTF-8"?><styleSheet><cellXfs>${"<xf/>".repeat(EDS_UPLOAD_LIMITS.maxStyles + 1)}</cellXfs></styleSheet>`
    ));
    const sparseNumberFormat = rewriteZipEntryText(original, "xl/styles.xml", () => (
      `<?xml version="1.0" encoding="UTF-8"?><styleSheet><numFmts><numFmt numFmtId="${EDS_UPLOAD_LIMITS.maxStyles + 1}" formatCode="0"/></numFmts></styleSheet>`
    ));
    const sparseCellStyle = rewriteZipEntryText(original, "xl/worksheets/sheet1.xml", (xml) => (
      xml.replace(/<c\b/u, `<c s="${EDS_UPLOAD_LIMITS.maxStyles + 1}"`)
    ));

    expect(() => validateXlsxArchive(tooManyStyles)).toThrow("XLSX 样式条目数量超过安全限制");
    for (const mutated of [sparseNumberFormat, sparseCellStyle]) {
      expect(() => validateXlsxArchive(mutated)).toThrow("XLSX 样式索引超过安全限制");
      await expect(readEdsXlsx({ buffer: mutated, originalFileName: "sparse-style-index.xlsx" }))
        .rejects.toMatchObject({ status: 413 });
    }
  });

  it("workbook 引用缺失或重复的 worksheet 关系 ID 时不返回部分工作表", async () => {
    const fixture = createSyntheticEdsFixture();
    const original = await workbookBuffer(fixture.sourceSheets);
    await expect(readEdsXlsx({ buffer: original, originalFileName: "valid-relations.xlsx" }))
      .resolves.toHaveLength(fixture.sourceSheets.length);

    const relationshipPattern = /<Relationship\b[^>]*Type="[^"]*\/worksheet"[^>]*\/>/gu;
    const relationshipXml = zipEntryText(original, "xl/_rels/workbook.xml.rels");
    const relationships = relationshipXml.match(relationshipPattern) ?? [];
    expect(relationships.length).toBeGreaterThanOrEqual(2);
    const [firstRelationship, secondRelationship] = relationships;
    if (!firstRelationship || !secondRelationship) throw new Error("Fixture must contain at least two worksheet relationships");
    const firstId = firstRelationship.match(/\bId="([^"]+)"/u)?.[1];
    expect(firstId).toBeTruthy();
    if (!firstId) throw new Error("Fixture worksheet relationship must contain an ID");

    const missing = rewriteZipEntryText(original, "xl/_rels/workbook.xml.rels", (xml) => (
      xml.replace(firstRelationship, "")
    ));
    const duplicate = rewriteZipEntryText(original, "xl/_rels/workbook.xml.rels", (xml) => (
      xml.replace(secondRelationship, secondRelationship.replace(/\bId="[^"]+"/u, `Id="${firstId}"`))
    ));
    for (const mutated of [missing, duplicate]) {
      expect(() => validateXlsxArchive(mutated)).not.toThrow();
      await expect(readEdsXlsx({ buffer: mutated, originalFileName: "invalid-relation-map.xlsx" }))
        .rejects.toMatchObject({ status: 400, message: "XLSX 工作簿无法解析或内容已损坏" });
    }
  });

  it("解压前拒绝重复、异常路径及中央目录与本地头不一致", async () => {
    const fixture = createSyntheticEdsFixture();
    const original = await workbookBuffer(fixture.sourceSheets);
    const { directoryOffset, entries } = centralEntries(original);

    const duplicate = Buffer.from(original);
    const sameLengthPair = entries.flatMap((left, leftIndex) => (
      entries.slice(leftIndex + 1).map((right) => ({ left, right })).filter(({ right }) => right.nameLength === left.nameLength)
    ))[0];
    expect(sameLengthPair).toBeDefined();
    duplicate.copy(
      duplicate,
      sameLengthPair!.right.nameStart,
      sameLengthPair!.left.nameStart,
      sameLengthPair!.left.nameStart + sameLengthPair!.left.nameLength,
    );
    expect(() => validateXlsxArchive(duplicate)).toThrow(/重复条目名称/);

    const abnormalPath = Buffer.from(original);
    abnormalPath.write("../", entries[0].nameStart, "ascii");
    expect(() => validateXlsxArchive(abnormalPath)).toThrow(/目录结构无效/);

    const controlCharacter = Buffer.from(original);
    controlCharacter[entries[0].nameStart] = 0x0a;
    expect(() => validateXlsxArchive(controlCharacter)).toThrow(/目录结构无效/);

    const oversizedName = Buffer.from(original);
    oversizedName.writeUInt16LE(1_025, entries[0].offset + 28);
    expect(() => validateXlsxArchive(oversizedName)).toThrow(/条目名称必须为 1–1024 字节/);

    const localNameMismatch = Buffer.from(original);
    const localNameStart = entries[0].localOffset + 30;
    localNameMismatch[localNameStart] ^= 0x01;
    expect(() => validateXlsxArchive(localNameMismatch)).toThrow(/目录结构无效/);

    const methodMismatch = Buffer.from(original);
    const centralMethod = methodMismatch.readUInt16LE(entries[0].offset + 10);
    methodMismatch.writeUInt16LE(centralMethod === 0 ? 8 : 0, entries[0].localOffset + 8);
    expect(() => validateXlsxArchive(methodMismatch)).toThrow(/目录结构无效/);

    const dataOutOfBounds = Buffer.from(original);
    dataOutOfBounds.writeUInt32LE(directoryOffset, entries[0].offset + 20);
    expect(() => validateXlsxArchive(dataOutOfBounds)).toThrow(/目录结构无效/);
  });

  it("校验数据描述符、实际 CRC 与受支持的 ZIP 标志", async () => {
    const fixture = createSyntheticEdsFixture();
    const original = await workbookBuffer(fixture.sourceSheets);
    const signedDescriptor = withSignedDataDescriptor(original);

    expect(() => validateXlsxArchive(signedDescriptor.buffer)).not.toThrow();
    await expect(readEdsXlsx({ buffer: signedDescriptor.buffer, originalFileName: "descriptor.xlsx" })).resolves.toHaveLength(2);

    const badDescriptor = Buffer.from(signedDescriptor.buffer);
    badDescriptor.writeUInt32LE((badDescriptor.readUInt32LE(signedDescriptor.descriptorOffset + 4) ^ 1) >>> 0, signedDescriptor.descriptorOffset + 4);
    expect(() => validateXlsxArchive(badDescriptor)).toThrow(/目录结构无效/);

    const badCrc = Buffer.from(signedDescriptor.buffer);
    const wrongCrc = (badCrc.readUInt32LE(signedDescriptor.centralOffset + 16) ^ 1) >>> 0;
    badCrc.writeUInt32LE(wrongCrc, signedDescriptor.centralOffset + 16);
    badCrc.writeUInt32LE(wrongCrc, signedDescriptor.descriptorOffset + 4);
    expect(() => validateXlsxArchive(badCrc)).toThrow(/内容校验失败/);

    const understatedSize = Buffer.from(signedDescriptor.buffer);
    const declaredSize = understatedSize.readUInt32LE(signedDescriptor.centralOffset + 24) - 1;
    understatedSize.writeUInt32LE(declaredSize, signedDescriptor.centralOffset + 24);
    understatedSize.writeUInt32LE(declaredSize, signedDescriptor.descriptorOffset + 12);
    expect(() => validateXlsxArchive(understatedSize)).toThrow(/内容校验失败/);

    const unsupportedFlag = Buffer.from(original);
    const firstEntry = centralEntries(unsupportedFlag).entries[0];
    unsupportedFlag.writeUInt16LE(unsupportedFlag.readUInt16LE(firstEntry.offset + 8) | 0x0020, firstEntry.offset + 8);
    unsupportedFlag.writeUInt16LE(unsupportedFlag.readUInt16LE(firstEntry.localOffset + 6) | 0x0020, firstEntry.localOffset + 6);
    expect(() => validateXlsxArchive(unsupportedFlag)).toThrow(/不支持的 ZIP 标志/);

    const corruptCompressedData = Buffer.from(original);
    const compressedEntry = centralEntries(corruptCompressedData).entries.find(({ offset, compressedBytes }) => (
      corruptCompressedData.readUInt16LE(offset + 10) === 8 && compressedBytes > 2
    ));
    expect(compressedEntry).toBeDefined();
    const compressedDataStart = compressedEntry!.localOffset
      + 30
      + corruptCompressedData.readUInt16LE(compressedEntry!.localOffset + 26)
      + corruptCompressedData.readUInt16LE(compressedEntry!.localOffset + 28);
    corruptCompressedData[compressedDataStart] = 0x07;
    expect(() => validateXlsxArchive(corruptCompressedData)).toThrow(/^XLSX 压缩包条目无法解压$/);
  });
});
