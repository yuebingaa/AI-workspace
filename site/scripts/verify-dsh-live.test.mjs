import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { parseLiveArguments } from './verify-dsh-live.mjs';

test('paid acceptance requires explicit acknowledgement and one owned absolute runtime', () => {
  const runtimeDir = resolve('.runtime/owned-synthetic-runtime');
  assert.deepEqual(parseLiveArguments(['--confirm-paid-model', '--runtime-dir', runtimeDir]), { runtimeDir });
  assert.deepEqual(parseLiveArguments(['--confirm-paid-model', '--runtime-dir', runtimeDir, '--delivery']), { runtimeDir, profile: 'delivery' });
  for (const args of [[], ['--runtime-dir', runtimeDir], ['--confirm-paid-model', '--runtime-dir', 'relative'],
    ['--confirm-paid-model', '--runtime-dir', runtimeDir, '--retry'],
    ['--confirm-paid-model', '--api-key', 'not-a-key'],
    ['--confirm-paid-model', '--runtime-dir', runtimeDir, '--model', 'another-model']]) {
    assert.throws(() => parseLiveArguments(args), /Usage:/);
  }
});
