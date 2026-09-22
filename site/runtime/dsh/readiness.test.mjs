import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectDshRuntime } from './driver.mjs';

test('readiness resolves then imports the SDK but never constructs it', async () => {
  const calls = [];
  const selected = { manifestPath: 'synthetic-only' };
  const result = await inspectDshRuntime({ nodeVersion: '24.19.0',
    resolveInstallation: async () => { calls.push('resolve'); return selected; },
    importSdk: async installation => {
      assert.equal(installation, selected); calls.push('import');
      return { DeepSeekHarness: class { constructor() { throw new Error('Must not instantiate'); } } };
    },
  });
  assert.deepEqual(calls, ['resolve', 'import']);
  assert.equal(result.available, true); assert.equal(result.phase, 'ready');
});

test('unsupported Node and installation failures stop before SDK import', async () => {
  for (const phase of ['node', 'installation']) {
    const result = await inspectDshRuntime({ nodeVersion: phase === 'node' ? '22.0.0' : '24.0.0',
      resolveInstallation: async () => { throw new Error('synthetic-secret-path'); },
      importSdk: async () => { assert.fail('SDK must not be imported'); },
    });
    assert.equal(result.available, false); assert.equal(result.phase, phase);
    assert.equal(result.code, phase === 'node' ? 'node_unsupported' : 'installation_unavailable');
    assert.ok(!JSON.stringify(result).includes('synthetic-secret-path'));
  }
});

test('readiness rejects an SDK missing its constructor export', async () => {
  const result = await inspectDshRuntime({ nodeVersion: '24.0.0', resolveInstallation: async () => ({}),
    importSdk: async () => ({ DeepSeekHarness: 'not-a-constructor' }),
  });
  assert.equal(result.available, false); assert.equal(result.phase, 'sdk_import');
  assert.equal(result.code, 'sdk_export_missing');
});

for (const [raw, expected] of [['ERR_MODULE_NOT_FOUND', 'module_not_found'],
  ['ERR_UNSUPPORTED_ESM_URL_SCHEME', 'unsupported_module_url'],
  ['ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING', 'module_loader_unavailable'],
  ['DSH_SDK_EXPORT_MISSING', 'sdk_export_missing'], ['SECRET_UNKNOWN_ERROR', 'sdk_import_failed']]) {
  test(`SDK import diagnostic is safe and classified: ${expected}`, async () => {
    const result = await inspectDshRuntime({ nodeVersion: '24.0.0', resolveInstallation: async () => ({}),
      importSdk: async () => { const error = new Error('synthetic-private-path/credential'); error.code = raw; throw error; },
    });
    assert.equal(result.available, false); assert.equal(result.phase, 'sdk_import');
    assert.equal(result.code, expected);
    assert.ok(!JSON.stringify(result).includes('synthetic-private-path'));
    assert.ok(!JSON.stringify(result).includes('SECRET_UNKNOWN_ERROR'));
  });
}
