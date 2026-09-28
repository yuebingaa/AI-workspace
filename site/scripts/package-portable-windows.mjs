import { createHash } from "node:crypto";
import { createReadStream, writeSync } from "node:fs";
import { access, open, readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createDeflateRaw } from "node:zlib";
import { Zip, ZipPassThrough } from "fflate";
import { assertCompleteContents, inspectDistributionTree, MAX_ZIP_BYTES } from "./portable-build-utils.mjs";
export { validateArchiveName } from "./portable-build-utils.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultSource = resolve(projectRoot, "..", "portable-release", "AgentCanvas");
const defaultOutput = resolve(projectRoot, "..", "AgentCanvas-Windows-compatible.zip");

export async function packagePortableWindows(source = defaultSource, output = defaultOutput) {
  const sourceRoot = resolve(source);
  const outputPath = resolve(output);
  const outputRelative = relative(sourceRoot, outputPath);
  if (!isAbsolute(outputRelative) && outputRelative !== ".." && !outputRelative.startsWith(`..${sep}`)) {
    throw new Error("ZIP 输出必须位于便携包源目录之外。");
  }
  try {
    await access(outputPath);
    throw new Error(`输出文件已存在，为避免覆盖已停止：${outputPath}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const tree = await inspectDistributionTree(sourceRoot);
  assertCompleteContents(tree);
  const manifest = JSON.parse(await readFile(resolve(sourceRoot, "portable-manifest.json"), "utf8"));
  if (manifest.schemaVersion !== 2 || manifest.profile !== "windows-x64-complete") {
    throw new Error("需要经过完整依赖构建的 schemaVersion 2 便携清单。");
  }
  // Stream one file at a time with bounded chunks; do not retain a >1 GiB input
  // tree and its compressed copy simultaneously. STORE/DEFLATE + data descriptors
  // are standard ZIP, with DOS directory bits and UTF-8 names (never ZIP64).
  const outputFile = await open(outputPath, "wx");
  const hash = createHash("sha256");
  let zipBytes = 0;
  let finished = false;
  const zip = new Zip((error, chunk, final) => {
    if (error) throw error;
    zipBytes += chunk.length;
    if (zipBytes > MAX_ZIP_BYTES) throw new Error("ZIP 必须小于 2 GiB。");
    hash.update(chunk);
    let offset = 0;
    while (offset < chunk.length) offset += writeSync(outputFile.fd, chunk, offset, chunk.length - offset);
    if (final) finished = true;
  });
  try {
    for (const entry of tree.entries) {
      const file = new ZipPassThrough(entry.name);
      if (!entry.directory) {
        file.compression = 8;
        // Keep fflate's ZIP framing and CRC over raw bytes, but compress using
        // Node zlib. fflate's streaming Deflate produced invalid back-references
        // for a bundled KaTeX font (Windows/.NET and zlib both rejected it).
        file.process = () => {};
      }
      Object.assign(file, { os: 0, attrs: entry.directory ? 0x10 : 0x20, mtime: entry.mtime });
      zip.add(file);
      if (!entry.directory) {
        let readBytes = 0;
        await pipeline(
          createReadStream(entry.diskPath, { highWaterMark: 256 * 1024 }),
          new Transform({
            transform(chunk, encoding, done) {
              readBytes += chunk.length;
              if (readBytes > entry.size) return done(new Error(`压缩期间文件发生变化：${entry.name}`));
              file.push(chunk, false);
              done(null, chunk);
            },
            flush(done) {
              if (readBytes !== entry.size) return done(new Error(`压缩期间文件发生变化：${entry.name}`));
              file.push(new Uint8Array(), true);
              done();
            },
          }),
          createDeflateRaw({ level: 6 }),
          new Writable({
            write(chunk, encoding, done) {
              try { file.ondata(null, chunk, false); done(); } catch (error) { done(error); }
            },
            final(done) {
              try { file.ondata(null, new Uint8Array(), true); done(); } catch (error) { done(error); }
            },
          }),
        );
      } else file.push(new Uint8Array(), true);
    }
    zip.end();
    if (!finished) throw new Error("ZIP 流未正常结束。");
    await outputFile.sync();
  } catch (error) {
    zip.terminate();
    // Retain failed output for inspection; never silently overwrite/remove it.
    throw error;
  } finally { await outputFile.close(); }
  return { output: outputPath, fileCount: tree.entries.filter((entry) => !entry.directory).length,
    directoryCount: tree.entries.filter((entry) => entry.directory).length,
    totalBytes: tree.totalBytes, zipBytes, longestPath: tree.longestPath,
    maxArchiveRelativePathChars: tree.maxArchiveRelativePathChars, sha256: hash.digest("hex") };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    console.log(JSON.stringify(await packagePortableWindows(process.argv[2], process.argv[3]), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
