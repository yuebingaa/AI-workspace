import { cp, lstat, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function notebookPythonBuildEnabled(environment = process.env) {
  const raw = environment.NOTEBOOK_PYTHON_ENABLED;
  if (raw === undefined) return true;
  if (typeof raw === 'string') {
    const normalized = raw.trim().toLowerCase();
    if (['1', 'true', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'off'].includes(normalized)) return false;
  }
  throw new Error('NOTEBOOK_PYTHON_ENABLED 配置无效：只能使用 true/1/on 或 false/0/off');
}

async function exists(path) {
  try { await lstat(path); return true; }
  catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
}

export async function copyNotebookRuntime(source, destination, { pythonEnabled = true } = {}) {
  if (typeof pythonEnabled !== 'boolean') throw new Error('copyNotebookRuntime pythonEnabled must be a boolean.');
  const sourceRoot = resolve(source), destinationRoot = resolve(destination);
  const pythonSource = join(sourceRoot, 'vendor/python'), pythonTarget = join(destinationRoot, 'vendor/python');
  // Never report an optional build as Python-free while retaining an older payload.
  // Refuse before any writes, including a dangling link; callers must use a fresh output.
  if (!pythonEnabled && await exists(pythonTarget)) {
    throw new Error('Python-disabled output already contains vendor/python; use a fresh build destination. Existing files were not changed.');
  }
  if (pythonEnabled && !await exists(pythonSource)) {
    throw new Error('Python assets missing: run npm run python:setup before building.');
  }
  const require = createRequire(join(sourceRoot, 'package.json'));
  const viteRequire = createRequire(require.resolve('vite/package.json'));
  const { build } = viteRequire('esbuild');
  const target = join(destinationRoot, 'vendor/notebook');
  await mkdir(target, { recursive: true });
  await build({ entryPoints: [join(sourceRoot, 'scripts/notebook-query-worker.cjs')], outfile: join(target, 'query-worker.cjs'),
    bundle: true, platform: 'node', format: 'cjs', target: 'node22', minify: true, logLevel: 'warning', external: ['@duckdb/duckdb-wasm/dist/*.wasm'] });
  await cp(require.resolve('@duckdb/duckdb-wasm/dist/duckdb-eh.wasm'), join(target, 'duckdb-eh.wasm'));
  // The npm DuckDB package omits LICENSE; keep the version-matched upstream copy.
  await cp(join(sourceRoot, 'scripts/notebook-DuckDB-LICENSE.txt'), join(target, 'DuckDB-LICENSE.txt'));
  await cp(join(sourceRoot, 'node_modules/apache-arrow/LICENSE.txt'), join(target, 'Arrow-LICENSE.txt'));
  await cp(join(sourceRoot, 'node_modules/apache-arrow/NOTICE.txt'), join(target, 'Arrow-NOTICE.txt'));
  // Python uses only these pinned offline assets; no machine Python installation is copied.
  if (pythonEnabled) {
    try { await cp(pythonSource, pythonTarget, { recursive: true }); }
    catch (error) { throw new Error('Python assets missing: run npm run python:setup before building.', { cause: error }); }
  }
  // Shared by screenshot capture as well as Python: do not remove this dependency.
  await cp(dirname(require.resolve('playwright-core/package.json')), join(destinationRoot, 'node_modules/playwright-core'), { recursive: true, dereference: true });
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await copyNotebookRuntime(process.cwd(), resolve('dist/standalone'), { pythonEnabled: notebookPythonBuildEnabled() });
}
