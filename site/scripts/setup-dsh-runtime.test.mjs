import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { setupDshRuntime } from './setup-dsh-runtime.mjs';
import {
  ACTIVE_FILE, DEFAULT_RUNTIME_ROOT, INSTALLS_DIRECTORY, LEGACY_DIRECTORY, installationId,
  readActivePointer, resolveDshInstallation, validatePointer,
} from '../runtime/dsh/installation.mjs';
import { VERSION } from '../runtime/dsh/policy.mjs';

async function write(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value));
}

async function fakeDependencies(root, zipVersion = '0.8.3') {
  for (const name of ['@deepseek-ai/dsh-sdk-client', '@deepseek-ai/dsh', '@deepseek-ai/dsh-sdk-minimal', '@deepseek-ai/libreoffice-kit', 'fflate']) {
    const directory = join(root, 'node_modules', name);
    await write(join(directory, 'package.json'), {
      name, version: name === 'fflate' ? zipVersion : VERSION, main: 'index.cjs', bin: { dsh: 'index.cjs' },
    });
    await write(join(directory, 'index.cjs'), `module.exports = ${JSON.stringify({ name, zipVersion })};`);
  }
}

async function fixture() {
  await mkdir(DEFAULT_RUNTIME_ROOT, { recursive: true });
  const root = await mkdtemp(join(DEFAULT_RUNTIME_ROOT, 'dsh-install-test-'));
  const runtimeRoot = join(root, 'runtime');
  const source = join(root, 'source');
  await mkdir(runtimeRoot);
  const manifest = { name: 'isolated-test', private: true, overrides: { '@deepseek-ai/libreoffice-kit': { fflate: '0.8.3' } } };
  await write(join(source, 'package.json'), manifest);
  await write(join(source, 'package-lock.json'), { lockfileVersion: 3, packages: {} });
  const legacy = join(runtimeRoot, LEGACY_DIRECTORY);
  await write(join(legacy, 'package.json'), { name: 'legacy-fixture' });
  await write(join(legacy, 'package-lock.json'), { lockfileVersion: 3, fixture: 'preserve' });
  await fakeDependencies(legacy, '0.8.2');
  return { root, runtimeRoot, source, legacy };
}

test('parallel install activates verified patch, preserves legacy and captures one tree per task', async () => {
  const f = await fixture();
  const legacyBytes = await readFile(join(f.legacy, 'package-lock.json'));
  const inFlight = await resolveDshInstallation(f.runtimeRoot);
  const oldResolver = createRequire(inFlight.manifestPath);
  const result = await setupDshRuntime({ ...f, install: async (directory) => {
    assert.equal((await resolveDshInstallation(f.runtimeRoot)).selection.kind, 'legacy');
    assert.notEqual(directory, f.legacy);
    await fakeDependencies(directory);
  } });
  assert.equal(result.active.kind, 'slot');
  assert.deepEqual(result.previous, { kind: 'legacy' });
  const next = await resolveDshInstallation(f.runtimeRoot);
  assert.notEqual(next.manifestPath, inFlight.manifestPath);
  assert.equal(oldResolver('fflate').zipVersion, '0.8.2');
  assert.equal(createRequire(next.manifestPath)('fflate').zipVersion, '0.8.3');
  assert.deepEqual(await readFile(join(f.legacy, 'package-lock.json')), legacyBytes);
  assert.ok(Object.isFrozen(inFlight));
  const reused = await setupDshRuntime({ ...f, install: () => { throw new Error('must not reinstall'); } });
  assert.equal(reused.reused, true);
  assert.deepEqual((await readActivePointer(f.runtimeRoot)).previous, { kind: 'legacy' });
  await setupDshRuntime({ ...f, rollback: true });
  assert.equal((await resolveDshInstallation(f.runtimeRoot)).selection.kind, 'legacy');
  assert.equal(createRequire(next.manifestPath)('fflate').zipVersion, '0.8.3', 'captured task remains on its installation after rollback');
});

test('failed installation preserves active selection and old files', async () => {
  const f = await fixture();
  await assert.rejects(setupDshRuntime({ ...f, install: async () => { throw new Error('test install failure'); } }), /test install failure/);
  assert.equal(await readActivePointer(f.runtimeRoot), null);
  assert.equal((await resolveDshInstallation(f.runtimeRoot)).selection.kind, 'legacy');
  assert.equal((await readdir(join(f.runtimeRoot, INSTALLS_DIRECTORY))).length, 1, 'failed stage retained for inspection');
  assert.equal((await readdir(f.runtimeRoot)).includes('dsh-runtime-install.lock'), false);
});

test('a version upgrade reads the older pointer without executing or overwriting its tree', async () => {
  const f = await fixture();
  const oldSelection = { kind: 'slot', id: `0.0.1-rc.1-${'b'.repeat(64)}` };
  const oldMarker = join(f.runtimeRoot, INSTALLS_DIRECTORY, oldSelection.id, 'preserved.txt');
  await write(oldMarker, 'previous release');
  const original = { schemaVersion: 1, active: oldSelection, previous: { kind: 'legacy' } };
  await write(join(f.runtimeRoot, ACTIVE_FILE), original);
  await assert.rejects(resolveDshInstallation(f.runtimeRoot), /Invalid isolated DSH installation selection/);
  await assert.rejects(setupDshRuntime({ ...f, install: async () => { throw new Error('candidate failed'); } }), /candidate failed/);
  assert.deepEqual(await readActivePointer(f.runtimeRoot), original);
  const installed = await setupDshRuntime({ ...f, install: async (directory) => {
    assert.deepEqual(await readActivePointer(f.runtimeRoot), original);
    await fakeDependencies(directory);
  } });
  assert.deepEqual(installed.previous, oldSelection);
  assert.equal((await resolveDshInstallation(f.runtimeRoot)).selection.id, installed.active.id);
  assert.equal(await readFile(oldMarker, 'utf8'), 'previous release');
  const current = await readActivePointer(f.runtimeRoot);
  await assert.rejects(setupDshRuntime({ ...f, rollback: true }), /Invalid isolated DSH installation selection/);
  assert.deepEqual(await readActivePointer(f.runtimeRoot), current, 'a different SDK version cannot be selected under current code');
});

test('installer rejects unpatched dependency and altered fixed lock before activation', async () => {
  for (const mode of ['vulnerable', 'changed-lock']) {
    const f = await fixture();
    await assert.rejects(setupDshRuntime({ ...f, install: async (directory) => {
      await fakeDependencies(directory, mode === 'vulnerable' ? '0.8.2' : '0.8.3');
      if (mode === 'changed-lock') await write(join(directory, 'package-lock.json'), { altered: true });
    } }), mode === 'vulnerable' ? /ZIP patch/ : /fixed specification/);
    assert.equal(await readActivePointer(f.runtimeRoot), null);
    assert.equal((await resolveDshInstallation(f.runtimeRoot)).selection.kind, 'legacy');
  }
});

test('malformed or escaping pointers fail closed without legacy fallback', async () => {
  const f = await fixture();
  const invalid = [
    { schemaVersion: 1, active: { kind: 'slot', id: '../escape' }, previous: null },
    { schemaVersion: 1, active: { kind: 'legacy', path: 'elsewhere' }, previous: null },
    { schemaVersion: 2, active: { kind: 'legacy' }, previous: null },
  ];
  for (const pointer of invalid) {
    assert.throws(() => validatePointer(pointer), /Invalid/);
    await write(join(f.runtimeRoot, ACTIVE_FILE), pointer);
    await assert.rejects(resolveDshInstallation(f.runtimeRoot), /Invalid/);
  }
  await write(join(f.runtimeRoot, ACTIVE_FILE), '{');
  await assert.rejects(resolveDshInstallation(f.runtimeRoot), SyntaxError);
  await write(join(f.runtimeRoot, ACTIVE_FILE), {
    schemaVersion: 1, active: { kind: 'slot', id: `${VERSION}-${'a'.repeat(64)}` }, previous: { kind: 'legacy' },
  });
  await assert.rejects(resolveDshInstallation(f.runtimeRoot), { code: 'ENOENT' }, 'missing selected slot must not silently run legacy');
});

test('linked slot roots cannot redirect installs or resolution outside runtime', async () => {
  const f = await fixture();
  const external = join(f.root, 'external');
  await mkdir(external);
  await symlink(external, join(f.runtimeRoot, INSTALLS_DIRECTORY), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(setupDshRuntime({ ...f, install: fakeDependencies }), /Linked DSH/);
  assert.deepEqual(await readdir(external), []);
});

test('incomplete final slot is never overwritten or cleaned', async () => {
  const f = await fixture();
  const id = installationId(await readFile(join(f.source, 'package.json')), await readFile(join(f.source, 'package-lock.json')));
  const target = join(f.runtimeRoot, INSTALLS_DIRECTORY, id);
  await write(join(target, 'marker.txt'), 'preserve');
  await assert.rejects(setupDshRuntime({ ...f, install: () => { throw new Error('must not install'); } }), /incomplete/);
  assert.equal(await readFile(join(target, 'marker.txt'), 'utf8'), 'preserve');
  assert.equal(await readActivePointer(f.runtimeRoot), null);
});

test('concurrent setup is rejected rather than replacing a running installer lock', async () => {
  const f = await fixture();
  let release;
  let started;
  const gate = new Promise((resolve) => { release = resolve; });
  const entering = new Promise((resolve) => { started = resolve; });
  const first = setupDshRuntime({ ...f, install: async (directory) => {
    started(); await gate; await fakeDependencies(directory);
  } });
  await entering;
  try { await assert.rejects(setupDshRuntime({ ...f, install: fakeDependencies }), { code: 'EEXIST' }); }
  finally { release(); }
  await first;
  assert.equal((await resolveDshInstallation(f.runtimeRoot)).selection.kind, 'slot');
});

test('manifest/lock tampering invalidates a previously installed content-addressed slot', async () => {
  const f = await fixture();
  await setupDshRuntime({ ...f, install: fakeDependencies });
  const selected = await resolveDshInstallation(f.runtimeRoot);
  await write(join(selected.root, 'package-lock.json'), { tampered: true });
  await assert.rejects(resolveDshInstallation(f.runtimeRoot), /identity differs/);
});
