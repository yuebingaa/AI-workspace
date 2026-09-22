import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { copyNotebookRuntime, notebookPythonBuildEnabled } from './copy-notebook-runtime.mjs';

const siteRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const copier = join(siteRoot, 'scripts/copy-notebook-runtime.mjs');

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'agentcanvas-optional-python-'));
  const source = join(root, 'source'), destination = join(root, 'output');
  const links = [];
  t.after(async () => {
    // These roots and links were created by this test; never recurse into the shared dependency tree.
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(basename(root).startsWith('agentcanvas-optional-python-'));
    for (const link of links) {
      assert.ok(resolve(link).startsWith(resolve(root) + sep));
      await unlink(link);
    }
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(join(source, 'scripts'), { recursive: true });
  await writeFile(join(source, 'package.json'), '{"private":true,"type":"module"}');
  for (const name of ['notebook-query-worker.cjs', 'notebook-DuckDB-LICENSE.txt']) {
    await cp(join(siteRoot, 'scripts', name), join(source, 'scripts', name));
  }
  const modules = join(source, 'node_modules');
  await symlink(join(siteRoot, 'node_modules'), modules, process.platform === 'win32' ? 'junction' : 'dir');
  links.push(modules);
  return { root, source, destination, links };
}

const safeEnvironment = (extra = {}) => ({ NODE_ENV: 'production',
  ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}), ...extra });

function runChild(args, cwd, env, input = '') {
  return new Promise((fulfill, reject) => {
    const child = spawn(process.execPath, args, { cwd, env, windowsHide: true,
      timeout: 30_000, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdin.on('error', () => {});
    child.once('error', reject);
    child.once('close', (code, signal) => fulfill({ code, signal, stdout, stderr }));
    child.stdin.end(input);
  });
}

test('Python build policy defaults to enabled and accepts only the existing explicit values', () => {
  assert.equal(notebookPythonBuildEnabled({}), true);
  for (const value of ['1', 'true', 'on', ' TRUE ', 'On']) assert.equal(notebookPythonBuildEnabled({ NOTEBOOK_PYTHON_ENABLED: value }), true);
  for (const value of ['0', 'false', 'off', ' FALSE ', 'Off']) assert.equal(notebookPythonBuildEnabled({ NOTEBOOK_PYTHON_ENABLED: value }), false);
  for (const value of ['', ' ', 'yes', 'disabled', '2', false, true, null]) {
    assert.throws(() => notebookPythonBuildEnabled({ NOTEBOOK_PYTHON_ENABLED: value }), /NOTEBOOK_PYTHON_ENABLED 配置无效/u);
  }
});

test('invalid explicit options fail before creating an output or requiring dependencies', async (t) => {
  const { root, destination } = await fixture(t);
  for (const pythonEnabled of ['false', 0, null]) {
    await assert.rejects(copyNotebookRuntime(join(root, 'missing-source'), destination, { pythonEnabled }), /must be a boolean/u);
  }
  await assert.rejects(lstat(destination), { code: 'ENOENT' });
});

test('default enabled copy rejects genuinely absent Python assets before any output writes', async (t) => {
  const { source, destination } = await fixture(t);
  await assert.rejects(copyNotebookRuntime(source, destination), /Python assets missing: run npm run python:setup before building\./u);
  await assert.rejects(lstat(destination), { code: 'ENOENT' });
});

test('disabled copy with no Python source retains standalone SQL, licenses and shared Playwright', async (t) => {
  const { source, destination } = await fixture(t);
  await copyNotebookRuntime(source, destination, { pythonEnabled: false });
  await assert.rejects(lstat(join(source, 'vendor/python')), { code: 'ENOENT' });
  await assert.rejects(lstat(join(destination, 'vendor/python')), { code: 'ENOENT' });
  for (const name of ['query-worker.cjs', 'duckdb-eh.wasm', 'DuckDB-LICENSE.txt', 'Arrow-LICENSE.txt', 'Arrow-NOTICE.txt']) {
    assert.ok((await lstat(join(destination, 'vendor/notebook', name))).size > 0);
  }
  assert.equal(JSON.parse(await readFile(join(destination, 'node_modules/playwright-core/package.json'), 'utf8')).name, 'playwright-core');
  const result = await runChild([join(destination, 'vendor/notebook/query-worker.cjs')], destination,
    safeEnvironment({ NOTEBOOK_WASM_PATH: join(destination, 'vendor/notebook/duckdb-eh.wasm') }), JSON.stringify({
      sql: 'SELECT region, SUM(amount) AS revenue FROM input GROUP BY region ORDER BY region',
      tables: [{ name: 'input', fields: [{ name: 'region', type: 'string' }, { name: 'amount', type: 'number' }],
        rows: [{ region: 'East', amount: 100 }, { region: 'East', amount: 50 }, { region: 'South', amount: 80 }] }],
    }));
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.signal, null);
  assert.deepEqual(JSON.parse(result.stdout).rows, [{ region: 'East', revenue: 150 }, { region: 'South', revenue: 80 }]);
  assert.equal(JSON.parse(result.stdout).truncated, false);
});

test('disabled copy skips existing source Python assets without deleting or modifying them', async (t) => {
  const { source, destination } = await fixture(t);
  const assets = join(source, 'vendor/python');
  await mkdir(assets, { recursive: true });
  await writeFile(join(assets, 'synthetic-asset.txt'), 'copy test marker; not an executable Python runtime');
  await copyNotebookRuntime(source, destination, { pythonEnabled: false });
  assert.equal(await readFile(join(assets, 'synthetic-asset.txt'), 'utf8'), 'copy test marker; not an executable Python runtime');
  await assert.rejects(lstat(join(destination, 'vendor/python')), { code: 'ENOENT' });
});

test('enabled copy preserves its existing Python-payload behavior', async (t) => {
  const { source, destination } = await fixture(t);
  const assets = join(source, 'vendor/python');
  await mkdir(assets, { recursive: true });
  await writeFile(join(assets, 'synthetic-asset.txt'), 'copy test marker; not an executable Python runtime');
  await copyNotebookRuntime(source, destination);
  assert.equal(await readFile(join(destination, 'vendor/python/synthetic-asset.txt'), 'utf8'), 'copy test marker; not an executable Python runtime');
});

test('disabled copy refuses stale output Python assets and leaves all existing bytes untouched', async (t) => {
  const { source, destination } = await fixture(t);
  await mkdir(join(destination, 'vendor/python'), { recursive: true });
  await writeFile(join(destination, 'vendor/python/keep.txt'), 'existing output must remain intact');
  await assert.rejects(copyNotebookRuntime(source, destination, { pythonEnabled: false }), /already contains vendor\/python/u);
  assert.equal(await readFile(join(destination, 'vendor/python/keep.txt'), 'utf8'), 'existing output must remain intact');
  assert.deepEqual(await readdir(join(destination, 'vendor')), ['python']);
  await assert.rejects(lstat(join(destination, 'node_modules')), { code: 'ENOENT' });
});

test('disabled copy also refuses a stale output Python file', async (t) => {
  const { source, destination } = await fixture(t);
  await mkdir(join(destination, 'vendor'), { recursive: true });
  await writeFile(join(destination, 'vendor/python'), 'existing file');
  await assert.rejects(copyNotebookRuntime(source, destination, { pythonEnabled: false }), /already contains vendor\/python/u);
  assert.equal(await readFile(join(destination, 'vendor/python'), 'utf8'), 'existing file');
});

test('disabled copy refuses a stale directory link without writing into its target', async (t) => {
  const { root, source, destination, links } = await fixture(t);
  const linkTarget = join(root, 'retained-assets');
  await mkdir(linkTarget); await writeFile(join(linkTarget, 'keep.txt'), 'linked fixture');
  await mkdir(join(destination, 'vendor'), { recursive: true });
  const link = join(destination, 'vendor/python');
  await symlink(linkTarget, link, process.platform === 'win32' ? 'junction' : 'dir'); links.push(link);
  await assert.rejects(copyNotebookRuntime(source, destination, { pythonEnabled: false }), /already contains vendor\/python/u);
  assert.equal(await readFile(join(linkTarget, 'keep.txt'), 'utf8'), 'linked fixture');
  assert.deepEqual(await readdir(join(linkTarget)), ['keep.txt']);
});

test('disabled copy refuses a dangling output Python directory link', async (t) => {
  const { root, source, destination, links } = await fixture(t);
  await mkdir(join(destination, 'vendor'), { recursive: true });
  const link = join(destination, 'vendor/python');
  await symlink(join(root, 'missing-link-target'), link, process.platform === 'win32' ? 'junction' : 'dir'); links.push(link);
  await assert.rejects(copyNotebookRuntime(source, destination, { pythonEnabled: false }), /already contains vendor\/python/u);
  assert.ok((await lstat(link)).isSymbolicLink());
  await assert.rejects(lstat(join(destination, 'vendor/notebook')), { code: 'ENOENT' });
});

test('CLI honors an explicit disabled environment in an isolated source without Python assets', async (t) => {
  const { source } = await fixture(t);
  const result = await runChild([copier], source, safeEnvironment({ NOTEBOOK_PYTHON_ENABLED: 'false' }));
  assert.equal(result.code, 0, result.stderr);
  const output = join(source, 'dist/standalone');
  assert.ok((await lstat(join(output, 'vendor/notebook/query-worker.cjs'))).isFile());
  await assert.rejects(lstat(join(output, 'vendor/python')), { code: 'ENOENT' });
});

test('CLI rejects an invalid environment before writing any build output', async (t) => {
  const { source } = await fixture(t);
  const result = await runChild([copier], source, safeEnvironment({ NOTEBOOK_PYTHON_ENABLED: 'sometimes' }));
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /NOTEBOOK_PYTHON_ENABLED 配置无效/u);
  await assert.rejects(lstat(join(source, 'dist')), { code: 'ENOENT' });
});
