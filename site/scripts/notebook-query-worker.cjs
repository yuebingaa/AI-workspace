// No NODE_RUNTIME: Wasm sees only explicitly inserted Arrow tables. It is not
// given Node filesystem, HTTP, UDF, extension loading or environment callbacks.
// A fresh process/runtime is used for each query; the parent owns its deadline.
const { createDuckDB, getPlatformFeatures, ConsoleLogger, LogLevel, DEFAULT_RUNTIME } = require('@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs');
const arrow = require('apache-arrow');
const path = require('node:path');

const quote = (name) => '"' + name.replaceAll('"', '""') + '"';
const fail = (message) => { process.stdout.write(JSON.stringify({ error: String(message).slice(0, 900) })); process.exitCode = 1; };
async function run(input) {
  const wasmPath = process.env.NOTEBOOK_WASM_PATH || require.resolve('@duckdb/duckdb-wasm/dist/duckdb-eh.wasm');
  if (!path.isAbsolute(wasmPath)) throw new Error('Invalid trusted runtime location');
  if (!(await getPlatformFeatures()).wasmExceptions) throw new Error('本地 Notebook 需要支持 WebAssembly 异常处理的 Node.js 22 或更新版本');
  const db = await createDuckDB({ mvp: { mainModule: wasmPath }, eh: { mainModule: wasmPath } }, new ConsoleLogger(LogLevel.NONE), { ...DEFAULT_RUNTIME, _udfFunctions: new Map() });
  await db.instantiate(() => {});
  db.open({ path: ':memory:', maximumThreads: 1, allowUnsignedExtensions: false });
  const connection = db.connect();
  try {
    connection.query("SET autoinstall_known_extensions=false; SET autoload_known_extensions=false; SET enable_external_access=false; SET memory_limit='128MB'; SET threads=1; SET max_temp_directory_size='0B'");
    for (const table of input.tables) {
      const columns = {};
      for (const field of table.fields) {
        const type = field.type === 'number' ? new arrow.Float64() : field.type === 'boolean' ? new arrow.Bool() : new arrow.Utf8();
        Object.defineProperty(columns, field.name, { value: arrow.vectorFromArray(table.rows.map((row) => row[field.name] ?? null), type), enumerable: true });
      }
      connection.insertArrowTable(new arrow.Table(columns), { name: table.name });
    }
    connection.query('SET lock_configuration=true');
    connection.query('BEGIN TRANSACTION READ ONLY');
    // Parent accepts a single query. The engine parses a subquery, not a script.
    const source = '(' + input.sql + '\n) AS notebook_query';
    const described = connection.query('DESCRIBE SELECT * FROM ' + source).toArray();
    if (!described.length || described.length > 30) throw new Error('查询结果必须包含 1–30 列');
    const used = new Set();
    const fields = described.map((column, index) => {
      const label = String(column.column_name);
      if (label.length > 160) throw new Error('列名超过 160 字符，请设置简短别名');
      const name = /^[A-Za-z][A-Za-z0-9_]{0,109}$/.test(label) ? label : 'field_' + (index + 1);
      let unique = name;
      while (used.has(unique)) unique += '_';
      used.add(unique);
      const sqlType = String(column.column_type).toUpperCase();
      const type = sqlType === 'BOOLEAN' ? 'boolean'
        : /^(TINYINT|SMALLINT|INTEGER|UTINYINT|USMALLINT|UINTEGER|FLOAT|DOUBLE)$/.test(sqlType) ? 'number' : 'string';
      return { name: unique, label, type };
    });
    // BIGINT / DECIMAL / timestamps stay lossless strings rather than being
    // silently rounded to JavaScript doubles or browser-local dates.
    const projection = fields.map((field) => (field.type === 'string' ? 'CAST(' + quote(field.label) + ' AS VARCHAR)' : quote(field.label)) + ' AS ' + quote(field.name)).join(', ');
    const output = connection.query('SELECT ' + projection + ' FROM ' + source + ' LIMIT 1001');
    const rows = [];
    let byteCount = Buffer.byteLength(JSON.stringify(fields));
    for (let index = 0; index < Math.min(output.numRows, 1000); index++) {
      const original = output.get(index);
      const row = Object.fromEntries(fields.map((field) => [field.name, original[field.name] ?? null]));
      if (Object.values(row).some((value) => typeof value === 'number' && !Number.isFinite(value))) throw new Error('结果包含 NaN 或 Infinity，请在 SQL 中显式处理；未将它们静默替换为 NULL');
      if (Object.values(row).some((value) => typeof value === 'string' && value.length > 20000)) throw new Error('结果单元格超过 20000 字符');
      const serialized = JSON.stringify(row);
      byteCount += Buffer.byteLength(serialized);
      if (byteCount > 2 * 1024 * 1024 - 4096) throw new Error('查询结果超过 2 MiB，请缩小查询范围');
      rows.push(row);
    }
    fields.forEach((field, index) => {
      if (/^(BIGINT|UBIGINT|HUGEINT|UHUGEINT)$/.test(String(described[index].column_type))
        && rows.every((row) => row[field.name] === null || Number.isSafeInteger(Number(row[field.name])))) {
        field.type = 'number';
        rows.forEach((row) => { if (row[field.name] !== null) row[field.name] = Number(row[field.name]); });
      }
    });
    connection.query('ROLLBACK');
    process.stdout.write(JSON.stringify({ fields, rows, truncated: output.numRows > 1000 }));
  } finally { connection.close(); }
}
let size = 0;
const chunks = [];
process.stdin.on('data', (chunk) => {
  size += chunk.length;
  if (size > 16 * 1024 * 1024) { fail('查询输入超过 16 MiB'); process.stdin.destroy(); return; }
  chunks.push(chunk);
});
process.stdin.on('end', () => {
  Promise.resolve().then(() => run(JSON.parse(Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, '')))).catch((error) => fail(error.message));
});
