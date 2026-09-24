import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  ACTIVE_FILE, BUNDLED_DIRECTORY, BUNDLED_OMITTED_PACKAGES, BUNDLED_PROFILE, BUNDLED_PROFILE_FILE,
  DEFAULT_RUNTIME_ROOT, INSTALLS_DIRECTORY, LEGACY_DIRECTORY,
  installationId, resolveDshInstallation, resolveDshSelection, validatePointer, validateSelection,
} from './installation.mjs';
import { VERSION } from './policy.mjs';

async function write(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value));
}

async function fakeDependencies(root, { zipVersion = '0.8.3', sdkVersion = VERSION, includeOffice = false } = {}) {
  for (const name of ['@deepseek-ai/dsh-sdk-client', '@deepseek-ai/dsh', '@deepseek-ai/dsh-sdk-minimal', 'fflate',
    ...(includeOffice ? ['@deepseek-ai/libreoffice-kit'] : [])]) {
    const directory = join(root, 'node_modules', name);
    await write(join(directory, 'package.json'), {
      name, version: name === 'fflate' ? zipVersion : sdkVersion,
      main: 'index.cjs', bin: { dsh: 'index.cjs' },
    });
    await write(join(directory, 'index.cjs'), 'module.exports = {};');
  }
}

async function fixture(options = {}) {
  await mkdir(DEFAULT_RUNTIME_ROOT, { recursive: true });
  const root = await mkdtemp(join(DEFAULT_RUNTIME_ROOT, 'dsh-bundled-test-'));
  const runtimeRoot = join(root, 'runtime');
  const bundled = join(runtimeRoot, BUNDLED_DIRECTORY);
  const manifest = JSON.stringify({
    name: 'isolated-portable-test', private: true,
    overrides: { '@deepseek-ai/libreoffice-kit': { fflate: options.override ?? '0.8.3' } },
  });
  const lock = JSON.stringify({ lockfileVersion: 3, packages: {} });
  const selection = { kind: 'bundled', id: installationId(manifest, lock) };
  await write(join(bundled, 'package.json'), manifest);
  await write(join(bundled, 'package-lock.json'), lock);
  await fakeDependencies(bundled, options);
  if (!options.omitProfile) {
    await write(join(bundled, BUNDLED_PROFILE_FILE), {
      schemaVersion: 1, profile: BUNDLED_PROFILE, omittedPackages: [...BUNDLED_OMITTED_PACKAGES],
    });
  }
  await write(join(runtimeRoot, ACTIVE_FILE), { schemaVersion: 1, active: selection, previous: null });
  return { root, runtimeRoot, bundled, manifest, lock, selection };
}

test('bundled selection resolves a fixed short path with a frozen content identity', async () => {
  const f = await fixture();
  const installation = await resolveDshInstallation(f.runtimeRoot);
  assert.deepEqual(installation.selection, f.selection);
  assert.equal(installation.root, join(f.runtimeRoot, BUNDLED_DIRECTORY));
  assert.equal(installation.manifestPath, join(f.bundled, 'package.json'));
  assert.ok(!installation.root.includes(f.selection.id), 'content identity must not lengthen portable archive paths');
  assert.ok(Object.isFrozen(installation));
  assert.ok(Object.isFrozen(installation.selection));
  assert.deepEqual(validatePointer({ schemaVersion: 1, active: { kind: 'legacy' }, previous: f.selection }).previous, f.selection);
});

test('bundled manifest or lock tampering fails closed instead of selecting another installation', async () => {
  for (const name of ['package.json', 'package-lock.json']) {
    const f = await fixture();
    await write(join(f.bundled, name), `${await readFile(join(f.bundled, name), 'utf8')}\n`);
    await assert.rejects(resolveDshInstallation(f.runtimeRoot), /identity differs/);
  }
  const f = await fixture();
  await write(join(f.runtimeRoot, ACTIVE_FILE), {
    schemaVersion: 1, active: { kind: 'bundled', id: `${VERSION}-${'a'.repeat(64)}` }, previous: { kind: 'legacy' },
  });
  await assert.rejects(resolveDshInstallation(f.runtimeRoot), /identity differs/);
});

test('bundled installations require both the patch declaration and installed patch version', async () => {
  const unpatchedManifest = await fixture({ override: '0.8.2' });
  await assert.rejects(resolveDshInstallation(unpatchedManifest.runtimeRoot), /patched installation specification differs/);
  const unpatchedTree = await fixture({ zipVersion: '0.8.2' });
  await assert.rejects(resolveDshInstallation(unpatchedTree.runtimeRoot), /ZIP patch is missing/);
  const wrongSdk = await fixture({ sdkVersion: '0.0.0-test' });
  await assert.rejects(resolveDshInstallation(wrongSdk.runtimeRoot), /version differs/);
});

test('bundled profile must explicitly and exactly identify the controlled Notebook distribution', async () => {
  const missing = await fixture({ omitProfile: true });
  await assert.rejects(resolveDshInstallation(missing.runtimeRoot), { code: 'ENOENT' });
  const valid = { schemaVersion: 1, profile: BUNDLED_PROFILE, omittedPackages: [...BUNDLED_OMITTED_PACKAGES] };
  for (const profile of [
    {}, { ...valid, schemaVersion: 2 }, { ...valid, profile: 'generic-dsh' },
    { ...valid, omittedPackages: [] }, { ...valid, omittedPackages: [...BUNDLED_OMITTED_PACKAGES, 'unapproved-extra-package'] },
    { ...valid, omittedPackages: ['../elsewhere', BUNDLED_OMITTED_PACKAGES[1]] },
    { ...valid, omittedPackages: [...BUNDLED_OMITTED_PACKAGES].reverse() },
    { ...valid, skipSafety: true },
  ]) {
    const f = await fixture();
    await write(join(f.bundled, BUNDLED_PROFILE_FILE), profile);
    await assert.rejects(resolveDshInstallation(f.runtimeRoot), /Invalid DSH controlled bundled profile/);
  }
});

test('all four declared omitted packages must actually be absent from a bundled installation', async () => {
  for (const name of BUNDLED_OMITTED_PACKAGES) {
    const f = await fixture();
    await write(join(f.bundled, 'node_modules', name, 'package.json'), { name, version: '0.0.1' });
    await assert.rejects(resolveDshInstallation(f.runtimeRoot), /contains an omitted package/);
  }
});

test('bundled root ZIP dependency cannot resolve through a linked external directory', async () => {
  const f = await fixture();
  const linkedRoot = join(f.root, 'zip-linked-runtime');
  const bundled = join(linkedRoot, BUNDLED_DIRECTORY);
  await write(join(bundled, 'package.json'), f.manifest);
  await write(join(bundled, 'package-lock.json'), f.lock);
  await write(join(bundled, BUNDLED_PROFILE_FILE), {
    schemaVersion: 1, profile: BUNDLED_PROFILE, omittedPackages: [...BUNDLED_OMITTED_PACKAGES],
  });
  for (const name of ['@deepseek-ai/dsh-sdk-client', '@deepseek-ai/dsh', '@deepseek-ai/dsh-sdk-minimal']) {
    const directory = join(bundled, 'node_modules', name);
    await write(join(directory, 'package.json'), { name, version: VERSION, main: 'index.cjs', bin: { dsh: 'index.cjs' } });
    await write(join(directory, 'index.cjs'), 'module.exports = {};');
  }
  await symlink(join(f.bundled, 'node_modules', 'fflate'), join(bundled, 'node_modules', 'fflate'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(resolveDshSelection(f.selection, linkedRoot), /Linked DSH managed paths/);
});

test('bundled selections reject arbitrary paths, malformed identities and extra pointer fields', () => {
  const validId = `${VERSION}-${'a'.repeat(64)}`;
  for (const value of [
    { kind: 'bundled' },
    { kind: 'bundled', id: '../escape' },
    { kind: 'bundled', id: `../${validId}` },
    { kind: 'bundled', id: `${VERSION}-${'A'.repeat(64)}` },
    { kind: 'bundled', id: `0.0.0-${'a'.repeat(64)}` },
    { kind: 'bundled', id: validId, path: 'elsewhere' },
    { kind: 'bundled', id: validId, patched: false },
  ]) {
    assert.throws(() => validateSelection(value), /Invalid isolated DSH installation selection/);
  }
  assert.throws(() => validatePointer({
    schemaVersion: 1, active: { kind: 'bundled', id: validId }, previous: null, path: 'elsewhere',
  }), /Invalid isolated DSH installation pointer/);
});

test('bundled paths reject linked runtime roots, install directories and node_modules', async () => {
  for (const level of ['runtime', 'bundle', 'node_modules']) {
    const f = await fixture();
    const otherRoot = join(f.root, `linked-${level}`);
    if (level === 'runtime') {
      await symlink(f.runtimeRoot, otherRoot, process.platform === 'win32' ? 'junction' : 'dir');
      await assert.rejects(resolveDshSelection(f.selection, otherRoot), /Linked DSH managed paths/);
    } else {
      await mkdir(otherRoot);
      const linkedBundle = join(otherRoot, BUNDLED_DIRECTORY);
      if (level === 'bundle') {
        await symlink(f.bundled, linkedBundle, process.platform === 'win32' ? 'junction' : 'dir');
      } else {
        await write(join(linkedBundle, 'package.json'), f.manifest);
        await write(join(linkedBundle, 'package-lock.json'), f.lock);
        await symlink(join(f.bundled, 'node_modules'), join(linkedBundle, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
      }
      await assert.rejects(resolveDshSelection(f.selection, otherRoot), /Linked DSH managed paths/);
    }
  }
});

test('bundled dependency resolution cannot escape its installation via a nested junction', async () => {
  const f = await fixture();
  const otherRoot = join(f.root, 'other-runtime');
  const bundled = join(otherRoot, BUNDLED_DIRECTORY);
  await write(join(bundled, 'package.json'), f.manifest);
  await write(join(bundled, 'package-lock.json'), f.lock);
  await write(join(bundled, BUNDLED_PROFILE_FILE), {
    schemaVersion: 1, profile: BUNDLED_PROFILE, omittedPackages: [...BUNDLED_OMITTED_PACKAGES],
  });
  await mkdir(join(bundled, 'node_modules'));
  await symlink(join(f.bundled, 'node_modules', '@deepseek-ai'), join(bundled, 'node_modules', '@deepseek-ai'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(resolveDshSelection(f.selection, otherRoot), /dependency resolves outside/);
});

test('missing bundled directory never falls back to a valid legacy installation', async () => {
  const f = await fixture();
  const otherRoot = join(f.root, 'other-runtime');
  const legacy = join(otherRoot, LEGACY_DIRECTORY);
  await write(join(legacy, 'package.json'), { name: 'legacy-test' });
  await write(join(legacy, 'package-lock.json'), { lockfileVersion: 3 });
  await fakeDependencies(legacy, { zipVersion: '0.8.2' });
  assert.equal((await resolveDshInstallation(otherRoot)).selection.kind, 'legacy');
  await write(join(otherRoot, ACTIVE_FILE), { schemaVersion: 1, active: f.selection, previous: { kind: 'legacy' } });
  await assert.rejects(resolveDshInstallation(otherRoot), { code: 'ENOENT' });
});

test('slot selection retains its content-addressed directory rather than resolving the bundle', async () => {
  const f = await fixture();
  const selection = { kind: 'slot', id: f.selection.id };
  await assert.rejects(resolveDshSelection(selection, f.runtimeRoot), { code: 'ENOENT' });
  const slot = join(f.runtimeRoot, INSTALLS_DIRECTORY, selection.id);
  await write(join(slot, 'package.json'), f.manifest);
  await write(join(slot, 'package-lock.json'), f.lock);
  await fakeDependencies(slot, { includeOffice: true });
  const resolved = await resolveDshSelection(selection, f.runtimeRoot);
  assert.equal(resolved.root, slot);
  assert.deepEqual(resolved.selection, selection);
  assert.equal((await resolveDshInstallation(f.runtimeRoot)).root, f.bundled, 'active bundle remains unchanged');
});
