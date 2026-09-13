import { cp, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function copyNotebookRuntime(source, destination) {
  const require = createRequire(join(resolve(source), 'package.json'));
  const viteRequire = createRequire(require.resolve('vite/package.json'));
  const { build } = viteRequire('esbuild');
  const target = join(resolve(destination), 'vendor/notebook');
  await mkdir(target, { recursive: true });
  await build({ entryPoints: [join(source, 'scripts/notebook-query-worker.cjs')], outfile: join(target, 'query-worker.cjs'),
    bundle: true, platform: 'node', format: 'cjs', target: 'node22', minify: true, logLevel: 'warning', external: ['@duckdb/duckdb-wasm/dist/*.wasm'] });
  await cp(require.resolve('@duckdb/duckdb-wasm/dist/duckdb-eh.wasm'), join(target, 'duckdb-eh.wasm'));
  // The npm DuckDB package omits LICENSE; keep the version-matched upstream copy.
  await cp(join(source, 'scripts/notebook-DuckDB-LICENSE.txt'), join(target, 'DuckDB-LICENSE.txt'));
  await cp(join(source, 'node_modules/apache-arrow/LICENSE.txt'), join(target, 'Arrow-LICENSE.txt'));
  await cp(join(source, 'node_modules/apache-arrow/NOTICE.txt'), join(target, 'Arrow-NOTICE.txt'));
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await copyNotebookRuntime(process.cwd(), resolve('dist/standalone'));
}
