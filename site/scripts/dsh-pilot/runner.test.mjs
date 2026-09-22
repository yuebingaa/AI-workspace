import assert from 'node:assert/strict';
import test from 'node:test';
import { runDshFixture } from './runner.mjs';

const parameters = { type: 'object', properties: {}, additionalProperties: false };
function tool(execute) {
  return { name: 'probe', description: 'Controlled fixture probe.', parameters, execute };
}
const actions = [{ name: 'probe', args: {} }];

test('real DSH loop executes registered tool and records canonical session evidence', async () => {
  let calls = 0;
  const result = await runDshFixture({ tools: [tool(async () => { calls++; return { ok: true }; })], actions });
  assert.equal(calls, 1);
  assert.equal(result.outcome, 'completed');
  assert.equal(result.modelCalls, 2);
  assert.equal(result.finalResponse, 'Controlled analysis fixture completed.');
  assert.equal(result.networkAttempts, 0);
  assert.deepEqual(result.toolNames, ['probe']);
  assert.equal(result.events.filter((event) => event.type === 'tool/call').length, 1);
  assert.equal(result.events.filter((event) => event.type === 'tool/result').length, 1);
  assert.deepEqual(result.events.map((event) => event.seq), result.events.map((_event, index) => index));
});

test('tool failure is a real DSH error result, not a successful analysis', async () => {
  const result = await runDshFixture({ tools: [tool(async () => { throw new Error('controlled-failure'); })], actions });
  assert.equal(result.outcome, 'failed');
  assert.equal(result.failedToolCount, 1);
  assert.deepEqual(result.toolResults, []);
  assert.match(JSON.stringify(result.events), /controlled-failure/);
});

test('unregistered shell name never reaches any supplied tool body', async () => {
  let calls = 0;
  const result = await runDshFixture({
    tools: [tool(async () => { calls++; return {}; })], actions: [{ name: 'bash', args: { command: 'never execute' } }],
  });
  assert.equal(calls, 0);
  assert.equal(result.outcome, 'failed');
  assert.equal(result.failedToolCount, 1);
});

test('process-local fetch denial reports failure and restores the original global', async () => {
  const previous = globalThis.fetch;
  const result = await runDshFixture({
    tools: [tool(async () => { await fetch('https://example.invalid/never-sent'); return {}; })], actions,
  });
  assert.equal(result.outcome, 'failed');
  assert.equal(result.networkAttempts, 1);
  assert.equal(globalThis.fetch, previous);
});

test('caller cancellation reaches executing tool, drains it, and releases the kernel', async () => {
  const controller = new AbortController();
  let drained = false;
  const result = await runDshFixture({
    signal: controller.signal,
    tools: [tool(async (_args, { signal }) => {
      const stopped = new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      controller.abort();
      await stopped;
      drained = true;
      signal.throwIfAborted();
      return {};
    })], actions,
  });
  assert.equal(result.outcome, 'cancelled');
  assert.equal(drained, true);
  assert.equal(result.modelCalls, 1);
  assert.deepEqual(result.toolResults, []);
  const second = await runDshFixture({ tools: [tool(async () => ({}))], actions });
  assert.equal(second.outcome, 'completed');
});

test('timeout cooperatively cancels and drains a pending tool', async () => {
  let drained = false;
  const result = await runDshFixture({
    timeoutMs: 40,
    tools: [tool(async (_args, { signal }) => {
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      drained = true;
      signal.throwIfAborted();
      return {};
    })], actions,
  });
  assert.equal(result.outcome, 'cancelled');
  assert.equal(drained, true);
  assert.match(JSON.stringify(result.events), /offline-pilot-timeout/);
});

test('pre-cancelled caller is rejected without changing fetch or executing tools', async () => {
  const controller = new AbortController();
  controller.abort();
  const previous = globalThis.fetch;
  await assert.rejects(runDshFixture({ tools: [tool(async () => ({}))], actions, signal: controller.signal }));
  assert.equal(globalThis.fetch, previous);
});
