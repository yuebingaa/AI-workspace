import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, link } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { readDshPackageInventory } from './package-inventory.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-inventory-'));
  t.after(async () => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('dsh-inventory-'));
    await rm(root, { recursive: true, force: true });
  });
  const namespace = join(root, 'node_modules', '@deepseek-ai'); await mkdir(namespace, { recursive: true });
  const add = async (name, fields = {}) => {
    const directory = join(namespace, name); await mkdir(directory);
    await writeFile(join(directory, 'package.json'), JSON.stringify({ name: '@deepseek-ai/' + name, version: '0.1.7-rc.2', ...fields }));
    return directory;
  };
  return { root, namespace, add };
}

test('lists actual DSH package metadata, classifies, filters and never imports entrypoints', async t => {
  const { root, add } = await fixture(t);
  const plugin = await add('dsh-tool-skill', { description: 'Load\nSkill', main: 'trap.mjs',
    dependencies: { '@deepseek-ai/dsh-skill': '*', external: '*', '../../secret': '*' },
    peerDependencies: { '@deepseek-ai/dsh-skill': '*', '@deepseek-ai/dsh-agent': '*' },
    devDependencies: { '@deepseek-ai/dsh-test': '*' }, apiKey: 'private-fixture' });
  await writeFile(join(plugin, 'trap.mjs'), 'throw new Error("MUST NOT IMPORT");');
  await add('dsh-client-ui-settings'); await add('dsh-sdk-minimal', { dsh: { bundle: { patch: './patch.yml' } } });
  await add('dsh-agent-loop'); await add('not-a-dsh-package');
  const result = await readDshPackageInventory(root);
  assert.equal(result.complete, true); assert.equal(result.packages.length, 4);
  assert.deepEqual(result.packages.map(row => row.category), ['runtime', 'client', 'bundle', 'tool']);
  assert.deepEqual(result.packages[3].dependencies, ['@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-skill']);
  assert.equal(result.packages[3].description, 'Load Skill');
  assert.ok(!JSON.stringify(result).includes('private-fixture')); assert.ok(!JSON.stringify(result).includes(root));
});
test('reports incomplete metadata instead of silently omitting broken packages', async t => {
  const { root, add } = await fixture(t);
  await add('dsh-good');
  const bad = await add('dsh-bad'); await writeFile(join(bad, 'package.json'), '{invalid');
  await add('dsh-wrong', { name: '@elsewhere/dsh-wrong' }); await add('dsh-version', { version: 'secret-fixture-path' });
  const result = await readDshPackageInventory(root);
  assert.equal(result.complete, false); assert.equal(result.packages.length, 1); assert.equal(result.issues.length, 3);
  assert.ok(result.issues.every(row => row.code === 'metadata-unavailable'));
});
test('bounds manifest reads and public description/dependency fields', async t => {
  const { root, add } = await fixture(t);
  await add('dsh-large', { description: 'x'.repeat(70_000) });
  await add('dsh-bounded', { description: 'x'.repeat(2000), peerDependencies: Object.fromEntries(Array.from({ length: 120 }, (_, i) => ['@deepseek-ai/dsh-dep-' + i, '*'])) });
  const result = await readDshPackageInventory(root);
  assert.equal(result.issues.length, 1); assert.equal(result.packages[0].description.length, 600); assert.equal(result.packages[0].dependencies.length, 100);
});
test('rejects linked package directories without reading outside the installation', async t => {
  const { root, namespace } = await fixture(t);
  const target = await mkdtemp(join(tmpdir(), 'dsh-inventory-'));
  t.after(async () => { assert.equal(dirname(resolve(target)), resolve(tmpdir())); assert.ok(basename(target).startsWith('dsh-inventory-')); await rm(target, { recursive: true, force: true }); });
  await writeFile(join(target, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-linked', version: '0.1.7-rc.2' }));
  await symlink(target, join(namespace, 'dsh-linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const result = await readDshPackageInventory(root);
  assert.equal(result.packages.length, 0); assert.equal(result.issues.length, 1);
  assert.ok((await readFile(join(target, 'package.json'), 'utf8')).includes('dsh-linked'));
});
test('rejects hardlinked manifests', async t => {
  const { root, namespace } = await fixture(t);
  const directory = join(namespace, 'dsh-link'); await mkdir(directory);
  const original = join(root, 'original.json');
  await writeFile(original, JSON.stringify({ name: '@deepseek-ai/dsh-link', version: '0.1.7-rc.2' }));
  await link(original, join(directory, 'package.json'));
  const result = await readDshPackageInventory(root);
  assert.equal(result.packages.length, 0); assert.equal(result.issues.length, 1);
});
test('does not turn absent installation into an empty success', async t => {
  const { root } = await fixture(t);
  await assert.rejects(readDshPackageInventory(join(root, 'absent')));
});
test('fresh reads observe package additions and removals without a stale cache', async t => {
  const { root, add } = await fixture(t);
  assert.equal((await readDshPackageInventory(root)).packages.length, 0);
  const location = await add('dsh-new');
  assert.equal((await readDshPackageInventory(root)).packages.length, 1);
  // Only remove the generated fixture manifest, not an installation.
  await rm(join(location, 'package.json'));
  const latest = await readDshPackageInventory(root);
  assert.equal(latest.complete, false); assert.equal(latest.packages.length, 0);
});
