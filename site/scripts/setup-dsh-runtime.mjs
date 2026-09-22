import { lstat, mkdir, mkdtemp, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ACTIVE_FILE, DEFAULT_RUNTIME_ROOT, INSTALLS_DIRECTORY, assertPlainPath, installationId,
  readActivePointer, resolveDshSelection, validatePointer, verifyInstalledTree,
} from '../runtime/dsh/installation.mjs';

const defaultSource = fileURLToPath(new URL('../runtime/dsh/', import.meta.url));

async function npmCi(target) {
  const npmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  await stat(npmCli);
  const code = await new Promise((resolveExit, reject) => {
    const child = spawn(process.execPath, [npmCli, 'ci', '--prefix', target, '--ignore-scripts', '--no-audit', '--no-fund'], {
      cwd: target, stdio: 'inherit', windowsHide: true,
    });
    child.once('error', reject);
    child.once('exit', resolveExit);
  });
  if (code !== 0) throw new Error('DSH isolated installation failed; the active installation was preserved.');
}

async function writePointer(runtimeRoot, pointer, expected) {
  const checked = validatePointer(pointer);
  if (JSON.stringify(await readActivePointer(runtimeRoot)) !== JSON.stringify(expected)) {
    throw new Error('DSH installation selection changed; activation was refused.');
  }
  const temporary = join(runtimeRoot, `${ACTIVE_FILE}.${randomUUID()}.tmp`);
  const handle = await open(temporary, 'wx');
  try {
    await handle.writeFile(`${JSON.stringify(checked, null, 2)}\n`);
    await handle.sync();
  } finally { await handle.close(); }
  // Same-directory rename is atomic; failure retains both the old pointer and evidence.
  await rename(temporary, join(runtimeRoot, ACTIVE_FILE));
}

/** Installs only into a new staging directory. Existing trees are never overwritten. */
export async function setupDshRuntime({
  source = defaultSource, runtimeRoot = DEFAULT_RUNTIME_ROOT, install = npmCi, rollback = false,
} = {}) {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('DSH setup requires Node 24+.');
  await mkdir(runtimeRoot, { recursive: true });
  await assertPlainPath(runtimeRoot, runtimeRoot);
  const lockPath = join(runtimeRoot, 'dsh-runtime-install.lock');
  const lock = await open(lockPath, 'wx');
  try {
    await lock.writeFile(`${process.pid}\n`);
    const previous = await readActivePointer(runtimeRoot);
    if (rollback) {
      if (!previous?.previous) throw new Error('No previous isolated DSH installation to restore.');
      await resolveDshSelection(previous.previous, runtimeRoot);
      await writePointer(runtimeRoot, {
        schemaVersion: 1, active: previous.previous, previous: previous.active,
      }, previous);
      return { active: previous.previous, rolledBack: true };
    }
    const [manifest, dependencyLock] = await Promise.all([
      readFile(join(source, 'package.json')), readFile(join(source, 'package-lock.json')),
    ]);
    const id = installationId(manifest, dependencyLock);
    const active = { kind: 'slot', id };
    const installs = join(runtimeRoot, INSTALLS_DIRECTORY);
    await mkdir(installs, { recursive: true });
    await assertPlainPath(runtimeRoot, installs);
    const target = join(installs, id);
    let reused = false;
    try {
      await lstat(target);
      await resolveDshSelection(active, runtimeRoot);
      reused = true;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      // A partial final slot must not be overwritten either.
      try { await lstat(target); throw new Error('Preserve incomplete DSH slot; inspect it before retrying.'); }
      catch (missing) { if (missing.code !== 'ENOENT') throw missing; }
      const staging = await mkdtemp(join(installs, '.staging-'));
      await writeFile(join(staging, 'package.json'), manifest, { flag: 'wx' });
      await writeFile(join(staging, 'package-lock.json'), dependencyLock, { flag: 'wx' });
      await install(staging);
      if (!(await readFile(join(staging, 'package.json'))).equals(manifest)
        || !(await readFile(join(staging, 'package-lock.json'))).equals(dependencyLock)) {
        throw new Error('DSH installer changed its fixed specification; activation was refused.');
      }
      await assertPlainPath(runtimeRoot, staging);
      await assertPlainPath(runtimeRoot, join(staging, 'node_modules'));
      await verifyInstalledTree(staging);
      await rename(staging, target);
      await resolveDshSelection(active, runtimeRoot);
    }
    if (previous?.active.kind === 'slot' && previous.active.id === id) return { active, reused: true };
    // No pointer denotes the preserved legacy tree, if it is actually usable.
    let oldSelection = previous?.active ?? null;
    if (!previous) {
      try { oldSelection = (await resolveDshSelection({ kind: 'legacy' }, runtimeRoot)).selection; }
      catch { /* A first installation need not have a legacy predecessor. */ }
    }
    await writePointer(runtimeRoot, { schemaVersion: 1, active, previous: oldSelection }, previous);
    return { active, previous: oldSelection, reused };
  } finally {
    try { await lock.close(); } finally { await unlink(lockPath); }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length && !(args.length === 1 && args[0] === '--rollback')) throw new Error('Usage: node scripts/setup-dsh-runtime.mjs [--rollback]');
  const result = await setupDshRuntime({ rollback: args[0] === '--rollback' });
  console.log(JSON.stringify(result));
  if (result.active.kind === 'legacy') console.warn('Explicit rollback restored the legacy installation, including its known ZIP dependency risk.');
}
