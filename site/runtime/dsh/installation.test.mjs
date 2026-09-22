import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { resolveDshInstallation } from './installation.mjs';

test('active SDK resolves patched ZIP dependency and safely rejects malformed ZIP64', { timeout: 10_000 }, async () => {
  const installation = await resolveDshInstallation();
  assert.equal(installation.selection.kind, 'slot', 'explicit patched setup is required for this integration check');
  const resolver = createRequire(installation.manifestPath);
  const officeManifest = resolver.resolve('@deepseek-ai/libreoffice-kit/package.json');
  const officeResolver = createRequire(officeManifest);
  assert.equal(JSON.parse(await readFile(officeResolver.resolve('fflate/package.json'), 'utf8')).version, '0.8.3');
  const lock = JSON.parse(await readFile(join(installation.root, 'package-lock.json'), 'utf8'));
  const zipRecords = Object.entries(lock.packages).filter(([path]) => path.endsWith('/fflate'));
  assert.equal(zipRecords.length, 1);
  assert.equal(zipRecords[0][1].version, '0.8.3');
  // Execute malformed input in a bounded, owned child even after the patch is verified.
  // No old vulnerable package is executed and no archive is written to disk.
  const child = spawnSync(process.execPath, ['-e', `
    const assert = require('node:assert/strict');
    const { createRequire } = require('node:module');
    const { zipSync, unzipSync, strToU8, strFromU8 } = createRequire(process.argv[1])('fflate');
    const valid = Buffer.from(zipSync({ 'fixture.txt': strToU8('patched round trip') }, { level: 0 }));
    assert.equal(strFromU8(unzipSync(valid)['fixture.txt']), 'patched round trip');
    const end = valid.length - 22;
    const central = valid.readUInt32LE(end + 16);
    const malformed = Buffer.alloc(valid.length + 76);
    valid.copy(malformed, 0, 0, end);
    // ZIP64 directory and locator are present, but the central entry has no required size extra field.
    malformed.writeUInt32LE(0x06064b50, end);
    malformed.writeBigUInt64LE(44n, end + 4);
    malformed.writeUInt16LE(45, end + 12);
    malformed.writeUInt16LE(45, end + 14);
    malformed.writeBigUInt64LE(1n, end + 24);
    malformed.writeBigUInt64LE(1n, end + 32);
    malformed.writeBigUInt64LE(BigInt(end - central), end + 40);
    malformed.writeBigUInt64LE(BigInt(central), end + 48);
    malformed.writeUInt32LE(0x07064b50, end + 56);
    malformed.writeBigUInt64LE(BigInt(end), end + 64);
    malformed.writeUInt32LE(1, end + 72);
    valid.copy(malformed, end + 76, end);
    malformed.writeUInt32LE(0xffffffff, central + 20);
    assert.throws(() => unzipSync(malformed), /invalid zip data/);
    process.stdout.write('roundtrip-and-zip64-rejection-ok');
  `, officeManifest], { timeout: 3000, encoding: 'utf8', windowsHide: true });
  assert.equal(child.error, undefined, 'patched ZIP processing must finish within the child deadline');
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, 'roundtrip-and-zip64-rejection-ok');
});
