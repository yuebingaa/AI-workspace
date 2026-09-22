import { access, lstat, readFile, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION } from './policy.mjs';

export const DEFAULT_RUNTIME_ROOT = fileURLToPath(new URL('../../.runtime/', import.meta.url));
export const ACTIVE_FILE = 'dsh-runtime-active.json';
export const INSTALLS_DIRECTORY = 'dsh-runtime-installs';
export const LEGACY_DIRECTORY = 'dsh-runtime-deps';

export function installationId(manifest, lock) {
  return `${VERSION}-${createHash('sha256').update(manifest).update('\0').update(lock).digest('hex')}`;
}

function strictKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

export function validateSelection(value) {
  if (strictKeys(value, ['kind']) && value.kind === 'legacy') return Object.freeze({ kind: 'legacy' });
  if (strictKeys(value, ['kind', 'id']) && value.kind === 'slot'
    && typeof value.id === 'string' && value.id.startsWith(`${VERSION}-`)
    && /^[a-f0-9]{64}$/.test(value.id.slice(VERSION.length + 1))) {
    return Object.freeze({ kind: 'slot', id: value.id });
  }
  throw new Error('Invalid isolated DSH installation selection.');
}

export function validatePointer(value) {
  if (!strictKeys(value, ['schemaVersion', 'active', 'previous']) || value.schemaVersion !== 1) {
    throw new Error('Invalid isolated DSH installation pointer.');
  }
  return Object.freeze({
    schemaVersion: 1,
    active: validateSelection(value.active),
    previous: value.previous === null ? null : validateSelection(value.previous),
  });
}

function isContained(base, target) {
  const suffix = relative(base, target);
  return suffix === '' || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`));
}

/** Reject junctions/symlinks in managed selection paths, including the runtime root. */
export async function assertPlainPath(runtimeRoot, target) {
  const base = resolve(runtimeRoot);
  const location = resolve(target);
  if (!isContained(base, location)) throw new Error('DSH managed path escapes its runtime root.');
  const suffix = relative(base, location);
  const parts = suffix ? suffix.split(sep) : [];
  let current = base;
  for (let index = 0; index <= parts.length; index += 1) {
    if ((await lstat(current)).isSymbolicLink()) throw new Error('Linked DSH managed paths are not allowed.');
    if (index < parts.length) current = join(current, parts[index]);
  }
  return location;
}

export async function readActivePointer(runtimeRoot = DEFAULT_RUNTIME_ROOT) {
  await assertPlainPath(runtimeRoot, runtimeRoot);
  const path = join(runtimeRoot, ACTIVE_FILE);
  try {
    await assertPlainPath(runtimeRoot, path);
    return validatePointer(JSON.parse(await readFile(path, 'utf8')));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function installedPath(root, target) {
  const actual = await realpath(target);
  if (!isContained(await realpath(root), actual)) throw new Error('DSH dependency resolves outside its installation.');
  return actual;
}

/** Also used on a fresh staging directory before it can become selectable. */
export async function verifyInstalledTree(root, { patched = true } = {}) {
  const resolver = createRequire(join(root, 'package.json'));
  for (const name of ['@deepseek-ai/dsh-sdk-client', '@deepseek-ai/dsh', '@deepseek-ai/dsh-sdk-minimal']) {
    const path = await installedPath(root, resolver.resolve(`${name}/package.json`));
    if (JSON.parse(await readFile(path, 'utf8')).version !== VERSION) throw new Error('Isolated DSH version differs.');
  }
  await access(await installedPath(root, resolver.resolve('@deepseek-ai/dsh-sdk-client')));
  const cliPath = await installedPath(root, resolver.resolve('@deepseek-ai/dsh/package.json'));
  const cli = JSON.parse(await readFile(cliPath, 'utf8'));
  await access(await installedPath(root, resolve(dirname(cliPath), cli.bin.dsh)));
  if (patched) {
    const officePath = await installedPath(root, resolver.resolve('@deepseek-ai/libreoffice-kit/package.json'));
    const officeResolver = createRequire(officePath);
    const zipManifest = await installedPath(root, officeResolver.resolve('fflate/package.json'));
    if (JSON.parse(await readFile(zipManifest, 'utf8')).version !== '0.8.3') throw new Error('DSH ZIP patch is missing.');
  }
}

export async function resolveDshSelection(selection, runtimeRoot = DEFAULT_RUNTIME_ROOT) {
  const selected = validateSelection(selection);
  const root = selected.kind === 'legacy'
    ? join(runtimeRoot, LEGACY_DIRECTORY) : join(runtimeRoot, INSTALLS_DIRECTORY, selected.id);
  await assertPlainPath(runtimeRoot, root);
  const manifestPath = join(root, 'package.json');
  for (const name of ['package.json', 'package-lock.json', 'node_modules']) {
    await assertPlainPath(runtimeRoot, join(root, name));
  }
  if (selected.kind === 'slot') {
    const manifest = await readFile(manifestPath);
    const lock = await readFile(join(root, 'package-lock.json'));
    if (installationId(manifest, lock) !== selected.id) throw new Error('DSH installation identity differs.');
    const specification = JSON.parse(manifest.toString('utf8'));
    if (specification.overrides?.['@deepseek-ai/libreoffice-kit']?.fflate !== '0.8.3') {
      throw new Error('DSH patched installation specification differs.');
    }
  }
  await verifyInstalledTree(root, { patched: selected.kind === 'slot' });
  return Object.freeze({ selection: selected, root, manifestPath });
}

/** Capture once per task. Later pointer changes never retarget this object. */
export async function resolveDshInstallation(runtimeRoot = DEFAULT_RUNTIME_ROOT) {
  const pointer = await readActivePointer(runtimeRoot);
  return resolveDshSelection(pointer?.active ?? { kind: 'legacy' }, runtimeRoot);
}
