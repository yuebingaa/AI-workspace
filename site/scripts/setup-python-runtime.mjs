import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(join(root, 'scripts/python-runtime-lock.json'), 'utf8'));
const destination = join(root, 'vendor/python');
await mkdir(destination, { recursive: true });
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
for (const [name, entry] of Object.entries(manifest.files)) {
  const path = join(destination, name);
  const existing = await readFile(path).catch(() => null);
  if (existing && existing.length === entry.bytes && digest(existing) === entry.sha256) continue;
  let bytes;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(entry.url, { signal: AbortSignal.timeout(60000) });
      if (!response.ok) throw new Error(`Python runtime download failed: ${name} (${response.status})`);
      bytes = Buffer.from(await response.arrayBuffer());
      break;
    } catch (error) { if (attempt === 2) throw error; }
  }
  if (bytes.length !== entry.bytes || digest(bytes) !== entry.sha256) throw new Error(`Python runtime checksum mismatch: ${name}`);
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, bytes); await rename(temporary, path);
  console.log(`Python runtime: ${name}`);
}
await writeFile(join(destination, 'runtime-lock.json'), JSON.stringify(manifest));
console.log(`Python ${manifest.pythonVersion} ready (Pyodide ${manifest.version}); execution is offline.`);
