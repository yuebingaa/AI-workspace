// Offline build evidence only. Never starts a server or changes installed assets.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, openSync, closeSync } from 'node:fs';
import { cp, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const evidence = join(source, '.runtime/hex-python-optional-runtime-2026-09-21', `build-${Date.now()}`);
// Keep copied TS sources outside site so normal typecheck never scans duplicates.
const snapshot = resolve(source, '../artifacts/hex-python-optional-build-2026-09-21', basename(evidence), 'source');
const report = { passed: false, checks: [], startedAt: new Date().toISOString() };
const sourceFolders = ['app', 'adapters', 'components', 'core', 'fixtures', 'public', 'scripts', 'docs', '.openai'];
const sourceFiles = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'vite.config.ts', 'next.config.ts', 'tsconfig.json', 'next-env.d.ts', 'eslint.config.mjs', 'vitest.config.ts'];

async function pythonHashes() {
  const root = join(source, 'vendor/python');
  const hashes = {};
  for (const name of (await readdir(root)).sort()) {
    const bytes = await readFile(join(root, name));
    hashes[name] = createHash('sha256').update(bytes).digest('hex');
  }
  return hashes;
}

function command(args, logName, { cwd = snapshot, env = {}, input } = {}) {
  // Exclude model/database credentials and inherited preload switches.
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    /^(?:PATH|PATHEXT|SYSTEMROOT|WINDIR|TEMP|TMP|LOCALAPPDATA|APPDATA|USERPROFILE|PROGRAMFILES|PROGRAMFILES\(X86\))$/iu.test(key)));
  const fd = openSync(join(evidence, logName), 'w');
  const child = spawn(process.execPath, args, { cwd, windowsHide: true,
    env: { ...environment, NODE_ENV: 'production', NOTEBOOK_PYTHON_ENABLED: 'false',
      STUDIO_LOCAL_STATE_DIR: join(evidence, 'state'), WRANGLER_WRITE_LOGS: 'false', ...env },
    stdio: [input === undefined ? 'ignore' : 'pipe', fd, fd] });
  closeSync(fd);
  if (input !== undefined) child.stdin.end(JSON.stringify(input));
  return new Promise((fulfill, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 && !signal ? fulfill() : reject(new Error(`${logName}: exit ${code}, signal ${signal}`)));
  });
}

await mkdir(evidence, { recursive: true });
await mkdir(snapshot, { recursive: true });
const before = await pythonHashes();
try {
  for (const folder of sourceFolders) await cp(join(source, folder), join(snapshot, folder), { recursive: true,
    filter: (path) => !path.split(/[\\/]/u).some((part) => part === 'node_modules' || part === '.runtime' || part === 'dist' || part === '.env' || part.startsWith('.env.')) });
  for (const file of sourceFiles) if (existsSync(join(source, file))) await cp(join(source, file), join(snapshot, file));
  // Only build-time dependencies are shared read-only; output and assets are separate.
  await symlink(join(source, 'node_modules'), join(snapshot, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(existsSync(join(snapshot, 'vendor/python')), false);
  report.checks.push('isolated source has no Python assets or private environment files');
  await command(['scripts/check-agent-architecture.mjs'], 'architecture.log');
  await command([join(snapshot, 'node_modules/vinext/dist/cli.js'), 'build'], 'build.log');
  await command(['scripts/copy-wecom-cli.mjs'], 'wecom.log');
  await command(['scripts/copy-notebook-runtime.mjs'], 'notebook-runtime.log');
  const output = join(snapshot, 'dist/standalone');
  assert.equal(existsSync(join(output, 'vendor/python')), false);
  for (const name of ['server.js', 'vendor/notebook/query-worker.cjs', 'vendor/notebook/duckdb-eh.wasm', 'node_modules/playwright-core/package.json']) {
    assert.equal(existsSync(join(output, name)), true, name);
  }
  report.checks.push('full vinext build and both runtime copy steps passed without Python assets');
  await command([join(output, 'vendor/notebook/query-worker.cjs')], 'sql.json', { cwd: output,
    env: { NOTEBOOK_WASM_PATH: join(output, 'vendor/notebook/duckdb-eh.wasm') },
    input: { sql: 'SELECT 150 AS east, 80 AS south, 150 + 80 AS total', tables: [] } });
  const result = JSON.parse(await readFile(join(evidence, 'sql.json'), 'utf8'));
  assert.deepEqual(result.rows, [{ east: 150, south: 80, total: 230 }]);
  assert.equal(result.truncated, false);
  report.checks.push('actual packaged DuckDB worker produced 150 / 80 / 230; no Python files present');
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? error.message.replaceAll(source, '<workspace>') : 'Build validation failed';
  process.exitCode = 1;
} finally {
  report.originalPythonUnchanged = JSON.stringify(before) === JSON.stringify(await pythonHashes());
  if (!report.originalPythonUnchanged) { report.passed = false; process.exitCode = 1; }
  report.completedAt = new Date().toISOString();
  await writeFile(join(evidence, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ ...report, evidence: relative(source, evidence).replaceAll('\\', '/') }, null, 2));
}
