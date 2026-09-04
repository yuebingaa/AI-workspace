import { inflateSync } from "fflate";
import { EdsAnalysisError } from "../analysis";
import { EDS_UPLOAD_LIMITS } from "../contracts";
import { parseStrictIsoDateKey } from "../date";

const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const CENTRAL_DIRECTORY_ENTRY_SIGNATURE = 0x02014b50;
const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const DATA_DESCRIPTOR_SIGNATURE = 0x08074b50;
const MIN_END_RECORD_BYTES = 22;
const MAX_ZIP_COMMENT_BYTES = 65_535;
const MAX_ZIP_ENTRY_NAME_BYTES = 1_024;
const SUPPORTED_GENERAL_PURPOSE_FLAGS = 0x080e;
const XML_DOCTYPE_BYTES = Buffer.from("<!DOCTYPE", "utf8");
const SUPPORTED_CELL_TYPES = new Set(["b", "d", "e", "inlineStr", "n", "s", "str"]);

const CRC32_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) !== 0 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});

function malformedArchive(): never {
  throw new EdsAnalysisError("XLSX/ZIP 目录结构无效或不受支持", 400);
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  const firstCandidate = Math.max(0, buffer.length - MIN_END_RECORD_BYTES - MAX_ZIP_COMMENT_BYTES);
  for (let offset = buffer.length - MIN_END_RECORD_BYTES; offset >= firstCandidate; offset -= 1) {
    if (buffer.readUInt32LE(offset) === END_OF_CENTRAL_DIRECTORY_SIGNATURE) return offset;
  }
  return malformedArchive();
}

function calculateCrc32(buffer: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function findXmlTagEnd(xml: string, start: number): number {
  let quote: '"' | "'" | undefined;
  for (let index = start + 1; index < xml.length; index += 1) {
    const character = xml[index];
    if (quote) {
      if (character === quote) quote = undefined;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === ">") {
      return index;
    }
  }
  return -1;
}

function validateBoundedRowNumber(value: string): number {
  if (!/^\d+$/u.test(value) || Number(value) < 1) throw new EdsAnalysisError("XLSX 工作表包含无效行列坐标", 400);
  const row = Number(value);
  if (row > EDS_UPLOAD_LIMITS.maxRowsPerSheet) {
    throw new EdsAnalysisError("XLSX 工作表行列坐标超过安全限制", 413);
  }
  return row;
}

function validateBoundedCellReference(value: string): { column: number; row: number } {
  const match = /^([A-Z]+)([1-9]\d*)$/u.exec(value);
  if (!match) throw new EdsAnalysisError("XLSX 工作表包含无效行列坐标", 400);
  const row = validateBoundedRowNumber(match[2]);
  let column = 0;
  for (const letter of match[1]) {
    column = column * 26 + letter.charCodeAt(0) - 64;
    if (column > EDS_UPLOAD_LIMITS.maxColumns) {
      throw new EdsAnalysisError("XLSX 工作表行列坐标超过安全限制", 413);
    }
  }
  return { column, row };
}

function validateBoundedStyleId(value: string): void {
  if (!/^\d+$/u.test(value)) throw new EdsAnalysisError("XLSX 包含无效样式索引", 400);
  if (Number(value) > EDS_UPLOAD_LIMITS.maxStyles) {
    throw new EdsAnalysisError("XLSX 样式索引超过安全限制", 413);
  }
}

function validateBoundedSharedStringIndex(value: string): void {
  if (!/^(?:0|[1-9]\d*)$/u.test(value)) {
    throw new EdsAnalysisError("XLSX 工作表包含无效共享字符串索引", 400);
  }
  if (Number(value) >= EDS_UPLOAD_LIMITS.maxSharedStrings) {
    throw new EdsAnalysisError("XLSX 共享字符串索引超过安全限制", 413);
  }
}

function decodedXmlTextLength(value: string): number {
  let length = 0;
  let cursor = 0;
  while (cursor < value.length) {
    const entityStart = value.indexOf("&", cursor);
    if (entityStart < 0) return length + value.length - cursor;
    length += entityStart - cursor;
    const entityEnd = value.indexOf(";", entityStart + 1);
    if (entityEnd < 0) return length + value.length - entityStart;
    const entity = value.slice(entityStart + 1, entityEnd);
    if (entity === "amp" || entity === "lt" || entity === "gt" || entity === "quot" || entity === "apos") {
      length += 1;
    } else {
      const numeric = /^#(?:x([\da-f]+)|(\d+))$/iu.exec(entity);
      const codePoint = numeric ? Number.parseInt(numeric[1] ?? numeric[2], numeric[1] ? 16 : 10) : Number.NaN;
      length += Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint).length
        : entityEnd + 1 - entityStart;
    }
    cursor = entityEnd + 1;
  }
  return length;
}

function validateSpreadsheetXmlLimits(data: Uint8Array): void {
  const xml = new TextDecoder().decode(data);
  let cursor = 0;
  let rootName: string | undefined;
  let inSheetData = false;
  let currentRow = 0;
  let currentColumn = 0;
  let currentCellType: string | undefined;
  let currentValidatedCellType: "b" | "d" | "s" | undefined;
  let currentCellHasValue = false;
  let cellValueStart: number | undefined;
  let currentStringChars: number | undefined;
  let currentStringTextElement: "t" | "v" | undefined;
  let rowElements = 0;
  let cellElements = 0;
  let sharedStrings = 0;
  let styleRecords = 0;
  const addStringText = (value: string, literal = false) => {
    if (currentStringChars === undefined || currentStringTextElement === undefined) return;
    currentStringChars += literal ? value.length : decodedXmlTextLength(value);
    if (currentStringChars > EDS_UPLOAD_LIMITS.maxCellChars) {
      throw new EdsAnalysisError("XLSX 包含超长文本单元格", 413);
    }
  };
  while (cursor < xml.length) {
    const start = xml.indexOf("<", cursor);
    if (start < 0) {
      addStringText(xml.slice(cursor));
      return;
    }
    addStringText(xml.slice(cursor, start));
    if (xml.startsWith("<!--", start)) {
      const end = xml.indexOf("-->", start + 4);
      cursor = end < 0 ? xml.length : end + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", start)) {
      const end = xml.indexOf("]]>", start + 9);
      addStringText(xml.slice(start + 9, end < 0 ? xml.length : end), true);
      cursor = end < 0 ? xml.length : end + 3;
      continue;
    }
    if (xml.startsWith("<?", start)) {
      const end = xml.indexOf("?>", start + 2);
      cursor = end < 0 ? xml.length : end + 2;
      continue;
    }
    const end = findXmlTagEnd(xml, start);
    if (end < 0) return;
    const tag = xml.slice(start + 1, end).trim();
    cursor = end + 1;
    if (!tag || tag.startsWith("!")) continue;
    const closing = tag.startsWith("/");
    const tagBody = closing ? tag.slice(1).trimStart() : tag;
    const qualifiedName = tagBody.slice(0, tagBody.search(/[\s/]/u) < 0 ? tagBody.length : tagBody.search(/[\s/]/u));
    const localName = qualifiedName.slice(qualifiedName.lastIndexOf(":") + 1);
    if (closing) {
      if (currentStringTextElement === localName) currentStringTextElement = undefined;
      if (rootName === "worksheet" && inSheetData && localName === "v" && cellValueStart !== undefined) {
        const value = xml.slice(cellValueStart, start).trim();
        if (currentValidatedCellType === "s") validateBoundedSharedStringIndex(value);
        if (currentValidatedCellType === "b" && value !== "0" && value !== "1") {
          throw new EdsAnalysisError("XLSX 工作表包含无效布尔值", 400);
        }
        if (currentValidatedCellType === "d" && (!value || !parseStrictIsoDateKey(value))) {
          throw new EdsAnalysisError("XLSX 工作表包含无效 ISO 日期", 400);
        }
        currentCellHasValue = true;
        cellValueStart = undefined;
        if (currentCellType === "str" || currentCellType === "e") currentStringChars = undefined;
      }
      if (rootName === "worksheet" && inSheetData && localName === "c") {
        if ((currentValidatedCellType === "s" || currentValidatedCellType === "b") && !currentCellHasValue) {
          const message = currentValidatedCellType === "s" ? "XLSX 工作表包含无效共享字符串索引" : "XLSX 工作表包含无效布尔值";
          throw new EdsAnalysisError(message, 400);
        }
        currentCellType = undefined;
        currentValidatedCellType = undefined;
        currentCellHasValue = false;
        cellValueStart = undefined;
        currentStringChars = undefined;
        currentStringTextElement = undefined;
      }
      if ((rootName === "sst" && localName === "si") || (rootName === "worksheet" && localName === "is")) {
        currentStringChars = undefined;
        currentStringTextElement = undefined;
      }
      if (rootName === "worksheet" && localName === "sheetData") inSheetData = false;
      continue;
    }
    if (!rootName) {
      rootName = localName;
      if (rootName !== "worksheet" && rootName !== "sst" && rootName !== "styleSheet") return;
    }
    const selfClosing = tagBody.trimEnd().endsWith("/");
    if (rootName === "sst") {
      if (localName === "si") {
        sharedStrings += 1;
        if (sharedStrings > EDS_UPLOAD_LIMITS.maxSharedStrings) {
          throw new EdsAnalysisError("XLSX 共享字符串数量超过安全限制", 413);
        }
        currentStringChars = selfClosing ? undefined : 0;
        currentStringTextElement = undefined;
      } else if (localName === "t" && currentStringChars !== undefined) {
        currentStringTextElement = selfClosing ? undefined : "t";
      }
      continue;
    }
    if (rootName === "styleSheet") {
      if (localName === "xf" || localName === "numFmt") {
        styleRecords += 1;
        if (styleRecords > EDS_UPLOAD_LIMITS.maxStyles) {
          throw new EdsAnalysisError("XLSX 样式条目数量超过安全限制", 413);
        }
      }
      for (const attribute of tag.matchAll(/(?:^|\s)(?:[A-Za-z_][\w.-]*:)?(?:numFmtId|xfId)\s*=\s*(["'])(.*?)\1/gu)) {
        validateBoundedStyleId(attribute[2]);
      }
      continue;
    }
    if (localName === "sheetData") {
      inSheetData = !tagBody.trimEnd().endsWith("/");
      continue;
    }
    if (!inSheetData) continue;
    if (localName === "is" && currentCellType === "inlineStr") {
      currentStringChars = selfClosing ? undefined : 0;
      currentStringTextElement = undefined;
      continue;
    }
    if (localName === "t" && currentCellType === "inlineStr" && currentStringChars !== undefined) {
      currentStringTextElement = selfClosing ? undefined : "t";
      continue;
    }
    if (localName === "v" && currentCellType) {
      if (selfClosing) {
        const message = currentValidatedCellType === "s" ? "XLSX 工作表包含无效共享字符串索引" : "XLSX 工作表包含无效布尔值";
        if (currentValidatedCellType) throw new EdsAnalysisError(message, 400);
      } else {
        cellValueStart = cursor;
        if (currentCellType === "str" || currentCellType === "e") {
          currentStringChars = 0;
          currentStringTextElement = "v";
        }
      }
      continue;
    }
    if (localName !== "row" && localName !== "c") continue;
    if (localName === "row") {
      rowElements += 1;
      if (rowElements > EDS_UPLOAD_LIMITS.maxRowsPerSheet) {
        throw new EdsAnalysisError("XLSX 工作表行数超过安全限制", 413);
      }
      const attributes = [...tag.matchAll(/(?:^|\s)(?:[A-Za-z_][\w.-]*:)?r\s*=\s*(["'])(.*?)\1/gu)];
      if (attributes.length > 1) throw new EdsAnalysisError("XLSX 工作表包含重复或乱序的显式坐标", 400);
      if (attributes.length === 0) throw new EdsAnalysisError("XLSX 工作表缺少显式行列坐标", 400);
      const nextRow = validateBoundedRowNumber(attributes[0][2]);
      if (nextRow <= currentRow) throw new EdsAnalysisError("XLSX 工作表包含重复或乱序的显式坐标", 400);
      currentRow = nextRow;
      currentColumn = 0;
      continue;
    }
    if (localName === "c") {
      cellElements += 1;
      if (cellElements > EDS_UPLOAD_LIMITS.maxCellsPerSheet) {
        throw new EdsAnalysisError("XLSX 工作表单元格数量超过安全限制", 413);
      }
      if (currentRow === 0) throw new EdsAnalysisError("XLSX 工作表包含无效行列坐标", 400);
      const references = [...tag.matchAll(/(?:^|\s)(?:[A-Za-z_][\w.-]*:)?r\s*=\s*(["'])(.*?)\1/gu)];
      if (references.length > 1) throw new EdsAnalysisError("XLSX 工作表包含重复或乱序的显式坐标", 400);
      if (references.length === 0) throw new EdsAnalysisError("XLSX 工作表缺少显式行列坐标", 400);
      const reference = validateBoundedCellReference(references[0][2]);
      if (reference.row !== currentRow || reference.column <= currentColumn) {
        throw new EdsAnalysisError("XLSX 工作表包含重复或乱序的显式坐标", 400);
      }
      if (reference.column > EDS_UPLOAD_LIMITS.maxColumns) {
        throw new EdsAnalysisError("XLSX 工作表行列坐标超过安全限制", 413);
      }
      currentColumn = reference.column;
      const cellTypes = [...tag.matchAll(/(?:^|\s)(?:[A-Za-z_][\w.-]*:)?t\s*=\s*(["'])(.*?)\1/gu)];
      if (cellTypes.length > 1 || (cellTypes[0] && !SUPPORTED_CELL_TYPES.has(cellTypes[0][2]))) {
        throw new EdsAnalysisError("XLSX 工作表包含不支持的单元格类型", 400);
      }
      const cellType = cellTypes[0]?.[2];
      currentCellType = cellType;
      currentValidatedCellType = cellType === "s" || cellType === "b" || cellType === "d" ? cellType : undefined;
      currentCellHasValue = false;
      cellValueStart = undefined;
      if ((currentValidatedCellType === "s" || currentValidatedCellType === "b") && tagBody.trimEnd().endsWith("/")) {
        const message = currentValidatedCellType === "s" ? "XLSX 工作表包含无效共享字符串索引" : "XLSX 工作表包含无效布尔值";
        throw new EdsAnalysisError(message, 400);
      }
      for (const attribute of tag.matchAll(/(?:^|\s)(?:[A-Za-z_][\w.-]*:)?s\s*=\s*(["'])(.*?)\1/gu)) {
        validateBoundedStyleId(attribute[2]);
      }
    }
  }
}

/**
 * Checks the ZIP structure and entry integrity before XML parsing. Expansion is
 * bounded before deflation, and encrypted, split and ZIP64 archives are rejected.
 */
export function validateXlsxArchive(buffer: Buffer): void {
  const endOffset = findEndOfCentralDirectory(buffer);
  const diskNumber = buffer.readUInt16LE(endOffset + 4);
  const centralDirectoryDisk = buffer.readUInt16LE(endOffset + 6);
  const entriesOnDisk = buffer.readUInt16LE(endOffset + 8);
  const totalEntries = buffer.readUInt16LE(endOffset + 10);
  const centralDirectoryBytes = buffer.readUInt32LE(endOffset + 12);
  const centralDirectoryOffset = buffer.readUInt32LE(endOffset + 16);
  const commentBytes = buffer.readUInt16LE(endOffset + 20);

  if (endOffset + MIN_END_RECORD_BYTES + commentBytes !== buffer.length) malformedArchive();
  if (diskNumber !== 0 || centralDirectoryDisk !== 0 || entriesOnDisk !== totalEntries) malformedArchive();
  if (totalEntries === 0 || totalEntries === 0xffff || totalEntries > EDS_UPLOAD_LIMITS.maxArchiveEntries) {
    throw new EdsAnalysisError(`XLSX 压缩包条目数量必须为 1–${EDS_UPLOAD_LIMITS.maxArchiveEntries}`, 413);
  }
  if (centralDirectoryBytes === 0xffffffff || centralDirectoryOffset === 0xffffffff) malformedArchive();
  if (centralDirectoryOffset + centralDirectoryBytes !== endOffset) malformedArchive();

  let offset = centralDirectoryOffset;
  let totalUncompressedBytes = 0;
  let hasContentTypes = false;
  let hasRootRelationships = false;
  let hasWorkbook = false;
  let hasWorkbookRelationships = false;
  const entryNames = new Set<string>();
  const localRanges: Array<{ start: number; end: number }> = [];
  for (let entryIndex = 0; entryIndex < totalEntries; entryIndex += 1) {
    if (offset + 46 > endOffset || buffer.readUInt32LE(offset) !== CENTRAL_DIRECTORY_ENTRY_SIGNATURE) malformedArchive();
    const flags = buffer.readUInt16LE(offset + 8);
    const compressionMethod = buffer.readUInt16LE(offset + 10);
    const crc32 = buffer.readUInt32LE(offset + 16);
    const compressedBytes = buffer.readUInt32LE(offset + 20);
    const uncompressedBytes = buffer.readUInt32LE(offset + 24);
    const fileNameBytes = buffer.readUInt16LE(offset + 28);
    const extraFieldBytes = buffer.readUInt16LE(offset + 30);
    const entryCommentBytes = buffer.readUInt16LE(offset + 32);
    const diskStart = buffer.readUInt16LE(offset + 34);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const nextOffset = offset + 46 + fileNameBytes + extraFieldBytes + entryCommentBytes;

    if (fileNameBytes === 0 || fileNameBytes > MAX_ZIP_ENTRY_NAME_BYTES) {
      throw new EdsAnalysisError(`XLSX 压缩包条目名称必须为 1–${MAX_ZIP_ENTRY_NAME_BYTES} 字节`, 413);
    }
    if (nextOffset > endOffset || diskStart !== 0 || localHeaderOffset === 0xffffffff) malformedArchive();
    if ((flags & 0x0001) !== 0) throw new EdsAnalysisError("EDS 不支持加密 XLSX 工作簿", 415);
    if ((flags & ~SUPPORTED_GENERAL_PURPOSE_FLAGS) !== 0) throw new EdsAnalysisError("XLSX 包含不支持的 ZIP 标志", 415);
    if (compressionMethod !== 0 && compressionMethod !== 8) throw new EdsAnalysisError("XLSX 包含不支持的压缩方法", 415);
    if (compressionMethod === 0 && (flags & 0x0006) !== 0) malformedArchive();
    if (compressedBytes === 0xffffffff || uncompressedBytes === 0xffffffff) malformedArchive();
    if (uncompressedBytes > EDS_UPLOAD_LIMITS.maxArchiveEntryBytes) {
      throw new EdsAnalysisError("XLSX 压缩包中的单个条目展开后过大", 413);
    }
    if (uncompressedBytes > 0 && compressedBytes === 0) malformedArchive();

    totalUncompressedBytes += uncompressedBytes;
    if (totalUncompressedBytes > EDS_UPLOAD_LIMITS.maxArchiveUncompressedBytes) {
      throw new EdsAnalysisError("XLSX 压缩包展开后超过安全大小限制", 413);
    }

    const centralNameBytes = buffer.subarray(offset + 46, offset + 46 + fileNameBytes);
    let entryName: string;
    try {
      entryName = new TextDecoder("utf-8", { fatal: true }).decode(centralNameBytes);
    } catch {
      return malformedArchive();
    }
    const segments = entryName.split("/");
    if (
      !entryName
      || entryName.startsWith("/")
      || entryName.includes("\\")
      || /[\u0000-\u001f\u007f]/u.test(entryName)
      || entryName.includes(":")
      || segments.some((segment, index) => segment === "." || segment === ".." || (segment === "" && index < segments.length - 1))
    ) malformedArchive();
    if (entryNames.has(entryName)) throw new EdsAnalysisError("XLSX 压缩包包含重复条目名称", 400);
    entryNames.add(entryName);

    if (localHeaderOffset + 30 > centralDirectoryOffset || buffer.readUInt32LE(localHeaderOffset) !== LOCAL_FILE_HEADER_SIGNATURE) malformedArchive();
    const localFlags = buffer.readUInt16LE(localHeaderOffset + 6);
    const localCompressionMethod = buffer.readUInt16LE(localHeaderOffset + 8);
    const localCrc32 = buffer.readUInt32LE(localHeaderOffset + 14);
    const localCompressedBytes = buffer.readUInt32LE(localHeaderOffset + 18);
    const localUncompressedBytes = buffer.readUInt32LE(localHeaderOffset + 22);
    const localNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28);
    const localNameStart = localHeaderOffset + 30;
    const localNameEnd = localNameStart + localNameLength;
    const dataStart = localNameEnd + localExtraLength;
    const dataEnd = dataStart + compressedBytes;
    if (dataStart > centralDirectoryOffset || dataEnd > centralDirectoryOffset) malformedArchive();
    const localNameBytes = buffer.subarray(localNameStart, localNameEnd);
    if (!localNameBytes.equals(centralNameBytes) || localFlags !== flags || localCompressionMethod !== compressionMethod) malformedArchive();
    let localRangeEnd = dataEnd;
    if ((flags & 0x0008) === 0) {
      if (localCrc32 !== crc32 || localCompressedBytes !== compressedBytes || localUncompressedBytes !== uncompressedBytes) {
        malformedArchive();
      }
    } else {
      if (
        (localCrc32 !== 0 && localCrc32 !== crc32)
        || (localCompressedBytes !== 0 && localCompressedBytes !== compressedBytes)
        || (localUncompressedBytes !== 0 && localUncompressedBytes !== uncompressedBytes)
      ) malformedArchive();
      if (dataEnd + 12 > centralDirectoryOffset) malformedArchive();
      const descriptorValuesOffset = buffer.readUInt32LE(dataEnd) === DATA_DESCRIPTOR_SIGNATURE ? dataEnd + 4 : dataEnd;
      if (descriptorValuesOffset + 12 > centralDirectoryOffset) malformedArchive();
      if (
        buffer.readUInt32LE(descriptorValuesOffset) !== crc32
        || buffer.readUInt32LE(descriptorValuesOffset + 4) !== compressedBytes
        || buffer.readUInt32LE(descriptorValuesOffset + 8) !== uncompressedBytes
      ) malformedArchive();
      localRangeEnd = descriptorValuesOffset + 12;
    }

    const compressedData = buffer.subarray(dataStart, dataEnd);
    let uncompressedData: Uint8Array;
    if (compressionMethod === 0) {
      if (compressedBytes !== uncompressedBytes) malformedArchive();
      uncompressedData = compressedData;
    } else {
      try {
        uncompressedData = inflateSync(compressedData, { out: new Uint8Array(uncompressedBytes + 1) });
      } catch {
        throw new EdsAnalysisError("XLSX 压缩包条目无法解压", 400);
      }
    }
    if (uncompressedData.byteLength !== uncompressedBytes || calculateCrc32(uncompressedData) !== crc32) {
      throw new EdsAnalysisError("XLSX 压缩包条目内容校验失败", 400);
    }
    if (
      (entryName.endsWith(".xml") || entryName.endsWith(".rels"))
      && Buffer.from(uncompressedData.buffer, uncompressedData.byteOffset, uncompressedData.byteLength).includes(XML_DOCTYPE_BYTES)
    ) {
      throw new EdsAnalysisError("XLSX XML 不允许 DTD 或外部实体声明", 400);
    }
    if (entryName.endsWith(".xml")) validateSpreadsheetXmlLimits(uncompressedData);
    localRanges.push({ start: localHeaderOffset, end: localRangeEnd });

    hasContentTypes ||= entryName === "[Content_Types].xml";
    hasRootRelationships ||= entryName === "_rels/.rels";
    hasWorkbook ||= entryName === "xl/workbook.xml";
    hasWorkbookRelationships ||= entryName === "xl/_rels/workbook.xml.rels";
    offset = nextOffset;
  }

  if (offset !== centralDirectoryOffset + centralDirectoryBytes) malformedArchive();
  localRanges.sort((left, right) => left.start - right.start);
  for (let index = 1; index < localRanges.length; index += 1) {
    if (localRanges[index - 1].end > localRanges[index].start) malformedArchive();
  }
  if (!hasContentTypes || !hasRootRelationships || !hasWorkbook || !hasWorkbookRelationships) {
    throw new EdsAnalysisError("ZIP 文件不是有效的 XLSX 工作簿", 415);
  }
}
