import { lstat, open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { assertPlainPath } from './installation.mjs';

const packageName = /^dsh(?:-[a-z0-9]+)*$/;
const packageId = /^@deepseek-ai\/dsh(?:-[a-z0-9]+)*$/;
const version = /^\d{1,3}\.\d{1,3}\.\d{1,3}(?:-[a-zA-Z0-9.-]{1,60})?(?:\+[a-zA-Z0-9.-]{1,60})?$/;
const MAX_PACKAGES = 1000, MAX_MANIFEST = 64 * 1024;

async function readMetadata(root, name) {
  const directory = await assertPlainPath(root, join(root, 'node_modules', '@deepseek-ai', name));
  if (!(await lstat(directory)).isDirectory()) throw new Error('Invalid package directory.');
  const location = await assertPlainPath(root, join(directory, 'package.json'));
  const handle = await open(location, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_MANIFEST) throw new Error('Invalid package metadata.');
    const buffer = Buffer.alloc(MAX_MANIFEST + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > MAX_MANIFEST) throw new Error('Oversized package metadata.');
    const value = JSON.parse(buffer.subarray(0, length).toString('utf8'));
    if (value?.name !== '@deepseek-ai/' + name || typeof value.version !== 'string' || !version.test(value.version)) {
      throw new Error('Invalid package identity.');
    }
    const dependencies = new Set();
    for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
      const group = value[field];
      if (group && typeof group === 'object' && !Array.isArray(group)) {
        for (const id of Object.keys(group)) if (packageId.test(id) && id.length <= 160) dependencies.add(id);
      }
    }
    return { id: value.name, version: value.version,
      description: typeof value.description === 'string' ? value.description.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 600) : '',
      category: value.dsh?.bundle ? 'bundle' : name.startsWith('dsh-client-') || value.dsh?.client ? 'client'
        : name.startsWith('dsh-tool-') ? 'tool' : 'runtime',
      dependencies: [...dependencies].sort().slice(0, 100),
    };
  } finally { await handle.close(); }
}

/** Public package metadata only. The caller supplies an already resolved managed
 * installation, never an HTTP path. Does not import or activate any package. */
export async function readDshPackageInventory(root) {
  const namespace = await assertPlainPath(root, join(root, 'node_modules', '@deepseek-ai'));
  const names = (await readdir(namespace)).filter(name => name.length <= 145 && packageName.test(name)).sort();
  if (names.length > MAX_PACKAGES) throw new Error('Package inventory exceeds its bound.');
  const packages = [], issues = [];
  for (let offset = 0; offset < names.length; offset += 12) {
    await Promise.all(names.slice(offset, offset + 12).map(async name => {
      try { packages.push(await readMetadata(root, name)); }
      catch { issues.push({ id: '@deepseek-ai/' + name, code: 'metadata-unavailable' }); }
    }));
  }
  packages.sort((a, b) => a.id.localeCompare(b.id));
  issues.sort((a, b) => a.id.localeCompare(b.id));
  return { source: 'managed-installation', complete: issues.length === 0, packages, issues };
}
