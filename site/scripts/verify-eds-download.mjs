import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { dirname, extname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer } from "vite";

const EXPECTED_SOURCE_SHA256 = "F44CD94DECBDF797B0606258CB7DFE704FC34EB68E35FCECBF41D1A5409434C3";
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function requiredEnvironmentPath(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`缺少 ${name}`);
  if (!isAbsolute(value)) throw new Error(`${name} 必须是绝对路径`);
  return resolve(value);
}

async function checkedFile(path, label) {
  const metadata = await stat(path);
  if (!metadata.isFile()) throw new Error(`${label} 不是普通文件`);
  if (extname(path).toLocaleLowerCase("en-US") !== ".xlsx") throw new Error(`${label} 必须是 .xlsx`);
  return readFile(path);
}

export async function verifyEdsDownloadBytes(sourceBytes, downloadedBytes) {
  assert(Buffer.isBuffer(sourceBytes) && Buffer.isBuffer(downloadedBytes), "EDS 独立复核需要两个 Buffer");
  const sourceHash = createHash("sha256").update(sourceBytes).digest("hex").toUpperCase();
  assert(sourceHash === EXPECTED_SOURCE_SHA256, "input.xlsx SHA-256 与固定验收原件不一致");
  assert(downloadedBytes.subarray(0, 2).toString() === "PK", "浏览器下载文件不是 XLSX ZIP");
  const vite = await createServer({
    root: projectRoot,
    configFile: false,
    logLevel: "silent",
    server: { middlewareMode: true },
    resolve: { alias: { "@": projectRoot } },
  });
  try {
    const [{ readEdsXlsx }, { analyzeEdsWorkbook }] = await Promise.all([
      vite.ssrLoadModule("/core/eds/server/workbook.ts"),
      vite.ssrLoadModule("/core/eds/analysis.ts"),
    ]);
    const [source, downloaded] = await Promise.all([
      readEdsXlsx({ buffer: sourceBytes, originalFileName: "input.xlsx" }),
      readEdsXlsx({ buffer: downloadedBytes, originalFileName: "browser-download.xlsx" }),
    ]);
    const result = analyzeEdsWorkbook(source, downloaded);
    assert(result.summary.inputRows === 4_651, `输入行数不一致：${result.summary.inputRows}`);
    assert(result.summary.matchedRows === 293, `命中行数不一致：${result.summary.matchedRows}`);
    assert(result.summary.totalOccurrences === 293, `异常次数不一致：${result.summary.totalOccurrences}`);
    assert(Math.abs(result.summary.totalMinutes - 231.77731666666662) <= 1e-10, `异常分钟不一致：${result.summary.totalMinutes}`);
    assert(result.comparison.coreMatched === 560 && result.comparison.coreTotal === 560, "核心矩阵未达到 560/560");
    assert(result.comparison.reportMatched === 660 && result.comparison.reportTotal === 660, "完整报表未达到 660/660");
    assert(result.comparison.mismatchCount === 0, `下载工作簿存在 ${result.comparison.mismatchCount} 项差异`);
    return {
      inputRows: result.summary.inputRows,
      matchedRows: result.summary.matchedRows,
      totalOccurrences: result.summary.totalOccurrences,
      totalMinutes: result.summary.totalMinutes,
      coreMatched: result.comparison.coreMatched,
      coreTotal: result.comparison.coreTotal,
      reportMatched: result.comparison.reportMatched,
      reportTotal: result.comparison.reportTotal,
      mismatchCount: result.comparison.mismatchCount,
      downloadSizeBytes: downloadedBytes.byteLength,
      downloadSha256: createHash("sha256").update(downloadedBytes).digest("hex").toUpperCase(),
    };
  } finally {
    await vite.close();
  }
}

async function main() {
  const sourcePath = requiredEnvironmentPath("EDS_REAL_SOURCE_PATH");
  const downloadedPath = requiredEnvironmentPath("EDS_BROWSER_DOWNLOADED_PATH");
  const [sourceBytes, downloadedBytes] = await Promise.all([
    checkedFile(sourcePath, "input.xlsx"),
    checkedFile(downloadedPath, "浏览器下载文件"),
  ]);
  const result = await verifyEdsDownloadBytes(sourceBytes, downloadedBytes);
  console.log(JSON.stringify({ sourcePath, downloadedPath, ...result }, null, 2));
}

const invokedUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedUrl === import.meta.url) await main();
