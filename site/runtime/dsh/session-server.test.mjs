import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve, sep } from 'node:path';
import { runDshSession } from './driver.mjs';
import { createNativeSessionController } from './session-server.mjs';
import { controlledDisabledRows, controlledPatch, DISABLED_ROWS, TOOL_NAMES } from './policy.mjs';

async function staging(context) {
  const root = await mkdtemp(join(tmpdir(), 'agentcanvas-native-session-'));
  context.after(async () => {
    const absolute = resolve(root);
    assert.equal(basename(absolute).startsWith('agentcanvas-native-session-'), true);
    assert.equal(relative(resolve(tmpdir()), absolute).includes(sep), false);
    await rm(absolute, { recursive: true, force: true });
  });
  return root;
}

async function filesUnder(root) {
  const entries = await readdir(root, { withFileTypes: true });
  return (await Promise.all(entries.map(entry => entry.isDirectory()
    ? filesUnder(join(root, entry.name)) : [join(root, entry.name)]))).flat();
}

async function broker(context, names = [], execute = async () => ({ summary: 'ok', data: { ok: true } }), authorize = () => true) {
  const token = randomBytes(32).toString('hex');
  const calls = [];
  const server = createServer(async (request, response) => {
    if (request.headers.authorization !== `Bearer ${token}`) { response.writeHead(401).end(); return; }
    response.setHeader('content-type', 'application/json');
    if (request.url === '/catalog') response.end(JSON.stringify({ profile: 'conversation',
      tools: names.map(name => ({ name, description: name, parameters: { type: 'object' } })) }));
    else if (request.url === '/authorize') { calls.push('authorize'); response.end(JSON.stringify({ authorized: authorize() })); }
    else if (request.url === '/execute') {
      let body = ''; for await (const chunk of request) body += chunk;
      const call = JSON.parse(body); calls.push(call.name);
      try { response.end(JSON.stringify(await execute(call))); }
      catch { response.writeHead(422).end(JSON.stringify({ error: 'Synthetic failure' })); }
    } else response.writeHead(404).end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let closing;
  const close = () => closing ??= new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
  context.after(close);
  return { token, calls, close, url: `http://127.0.0.1:${server.address().port}/` };
}

function fakeController({ flush = async () => {}, dispose = async () => {} } = {}) {
  const calls = [];
  const handle = { agent: { session: { id: 'native-unit-session' }, followup(message) { calls.push(message); } }, dispose };
  const ctx = { sessions: { flush }, agents: {
    async create(options) { calls.push({ create: options }); return handle; },
    async resume(options) { calls.push({ resume: options }); return handle; },
  } };
  const controller = createNativeSessionController({ ctx, sessionId: 'native-unit-session', mode: 'resume',
    createUserMessage: value => ({ ...value, id: 'unit-message' }) });
  controller.configure({ provider: 'fixed-provider', model: 'fixed-model' });
  return { controller, calls };
}

test('native profile enables only persistence and its owned server', () => {
  const disabled = controlledDisabledRows(true);
  assert.deepEqual(disabled, [...DISABLED_ROWS.filter(id => id !== 'sessions'), 'sdk-jsonrpc-server']);
  assert.equal(controlledDisabledRows(), DISABLED_ROWS);
  const patch = controlledPatch('file:///controlled.mjs', 'conversation', { root: 'C:\\private\\stage', serverPluginUrl: 'file:///server.mjs' });
  assert.match(patch, /id: sessions\n  disabled: false/);
  assert.match(patch, /id: sdk-jsonrpc-server\n  disabled: true/);
  assert.match(patch, /id: persistent-pwsh\n  disabled: true/);
  assert.match(controlledPatch('file:///controlled.mjs', 'conversation'), /id: sessions\n  disabled: true/);
});

test('native controller rejects foreign identities and repeated prompts and waits for flush and disposal', async () => {
  const order = [];
  const { controller, calls } = fakeController({ flush: async () => { order.push('flush'); }, dispose: async () => { order.push('dispose'); } });
  await assert.rejects(controller.prompt({ sessionId: 'another-session', contentBlocks: [{ type: 'text', text: 'no' }] }));
  assert.deepEqual(await controller.prompt({ sessionId: 'native-unit-session', contentBlocks: [{ type: 'text', text: 'one prompt' }] }), { messageId: 'unit-message' });
  await assert.rejects(controller.prompt({ sessionId: 'native-unit-session', contentBlocks: [{ type: 'text', text: 'duplicate' }] }));
  assert.equal(calls[0].resume.resumeSessionId, 'native-unit-session');
  assert.deepEqual(await controller.checkpoint(), { persisted: true, sessionId: 'native-unit-session' });
  assert.deepEqual(order, ['flush', 'dispose']);
  await controller.dispose();
  assert.deepEqual(order, ['flush', 'dispose']);
});

for (const failure of ['flush', 'dispose']) {
  test(`native checkpoint refuses persisted receipt when ${failure} fails`, async () => {
    const { controller } = fakeController({ [failure]: async () => { throw new Error('Synthetic durability failure'); } });
    await controller.prompt({ sessionId: 'native-unit-session', contentBlocks: [{ type: 'text', text: 'one prompt' }] });
    await assert.rejects(controller.checkpoint(), /durability failure/);
    await controller.dispose().catch(() => {});
  });
}

test('official SDK resumes native history in a new process without website history, and keeps credentials out of logs', { timeout: 60_000 }, async context => {
  const root = await staging(context);
  const first = await broker(context);
  const second = await broker(context);
  const requests = [];
  const failures = [];
  const apiKey = 'synthetic-native-secret-canary-40f186';
  const provider = createServer(async (request, response) => {
    try {
      let body = ''; for await (const chunk of request) body += chunk;
      const input = JSON.parse(body); requests.push(input);
      if (requests.length === 2) {
        const messages = JSON.stringify(input.messages);
        assert.equal(messages.split('FIRST_NATIVE_71A').length - 1, 1);
        assert.equal(messages.split('FIRST_REPLY_28B').length - 1, 1);
        assert.match(messages, /SECOND_PROMPT_93C/);
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const [delta, finish_reason] of [[{ role: 'assistant', content: requests.length === 1 ? 'FIRST_REPLY_28B' : 'Resumed original native history.' }, null], [{}, 'stop']]) {
        response.write(`data: ${JSON.stringify({ id: 'native-fixture', object: 'chat.completion.chunk', created: 1,
          model: 'fixed-model', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      }
      response.end('data: [DONE]\n\n');
    } catch (error) { failures.push(error); response.writeHead(500).end('Synthetic assertion failed.'); }
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise(resolve => { provider.closeAllConnections(); provider.close(resolve); }));
  const modelConfig = { mode: 'deepseek', apiKey, model: 'fixed-model', baseURL: `http://127.0.0.1:${provider.address().port}`, timeoutMs: 2000 };
  const common = { modelConfig, profile: 'conversation', sessionId: 'native-history-session' };
  const firstResult = await runDshSession({ ...common, brokerUrl: first.url, brokerToken: first.token,
    nativeSession: { root, mode: 'create' }, instruction: 'Remember FIRST_NATIVE_71A.' });
  assert.equal(firstResult.persisted, true);
  assert.equal(firstResult.reaped, true);
  await first.close();
  const secondResult = await runDshSession({ ...common, brokerUrl: second.url, brokerToken: second.token,
    nativeSession: { root, mode: 'resume' }, instruction: 'SECOND_PROMPT_93C: Recall the prior phrase.' });
  assert.equal(secondResult.persisted, true);
  assert.equal(secondResult.reaped, true);
  assert.deepEqual(failures, []);
  assert.equal(requests.length, 2);
  assert.deepEqual(first.calls, ['authorize']);
  assert.deepEqual(second.calls, ['authorize']);
  const files = await filesUnder(root);
  assert.equal(files.filter(file => file.endsWith('.jsonl')).length, 1);
  assert.equal(files.every(file => file.endsWith('.jsonl')), true);
  const contents = (await Promise.all(files.map(file => readFile(file, 'utf8')))).join('\n');
  assert.match(contents, /FIRST_NATIVE_71A/);
  assert.match(contents, /FIRST_REPLY_28B/);
  assert.match(contents, /SECOND_PROMPT_93C/);
  for (const secret of [apiKey, first.token, second.token]) assert.equal(contents.includes(secret), false);
});

test('resumed official SDK uses only the new broker and its narrowed tool catalog', { timeout: 60_000 }, async context => {
  const root = await staging(context);
  const first = await broker(context, TOOL_NAMES);
  const firstResult = await runDshSession({ brokerUrl: first.url, brokerToken: first.token, profile: 'conversation',
    modelConfig: { mode: 'fixture', actions: [{ name: 'cellSearch', args: {} }] },
    sessionId: 'native-tool-session', nativeSession: { root, mode: 'create' }, instruction: 'First tool lease.' });
  assert.equal(firstResult.persisted, true);
  await first.close();
  const second = await broker(context, ['cellSearch']);
  const result = await runDshSession({ brokerUrl: second.url, brokerToken: second.token, profile: 'conversation',
    modelConfig: { mode: 'fixture', actions: [{ name: 'editNotebookCells', args: {} }, { name: 'cellSearch', args: {} }] },
    sessionId: 'native-tool-session', nativeSession: { root, mode: 'resume' }, instruction: 'Second tool lease.' });
  assert.equal(result.persisted, true);
  assert.deepEqual(second.calls.filter(name => name !== 'authorize'), ['cellSearch']);
  const headers = result.events.filter(event => event.type === 'request/header');
  assert.ok(headers.length > 0);
  for (const header of headers) assert.deepEqual(header.data.header.tools.map(tool => tool.name), ['cellSearch']);
  assert.equal(result.events.filter(event => event.type === 'tool/result' && event.data.message.isError === true).length, 1);
});

test('failed and cancelled native turns reject without a persisted success result', { timeout: 60_000 }, async context => {
  for (const mode of ['failed', 'cancelled']) {
    const root = await staging(context);
    const controller = new AbortController();
    const fixture = await broker(context, ['cellSearch'], async () => {
      if (mode === 'cancelled') controller.abort();
      return { summary: 'Synthetic', data: {} };
    }, () => mode !== 'failed');
    await assert.rejects(runDshSession({ brokerUrl: fixture.url, brokerToken: fixture.token, profile: 'conversation', signal: controller.signal,
      modelConfig: { mode: 'fixture', actions: [{ name: 'cellSearch', args: {} }] },
      sessionId: `native-${mode}-session`, nativeSession: { root, mode: 'create' }, instruction: 'Negative native lifecycle.' }));
    assert.equal(fixture.calls[0], 'authorize');
    if (mode === 'cancelled') assert.deepEqual(fixture.calls.filter(name => name !== 'authorize'), ['cellSearch']);
  }
});

test('official SDK cannot report persisted success after its native log becomes unwritable', { timeout: 30_000 }, async context => {
  const root = await staging(context);
  const baseline = await broker(context);
  await runDshSession({ brokerUrl: baseline.url, brokerToken: baseline.token, profile: 'conversation',
    modelConfig: { mode: 'fixture', actions: [] }, sessionId: 'native-durability-failure',
    nativeSession: { root, mode: 'create' }, instruction: 'Materialize the synthetic accepted prefix.' });
  await baseline.close();
  let faultInjected = false;
  const fixture = await broker(context, ['cellSearch'], async () => {
    const logs = (await filesUnder(root)).filter(file => file.endsWith('.jsonl'));
    assert.equal(logs.length, 1);
    // Preserve the synthetic prefix and replace only this test's log leaf with
    // a directory, making the official backend's next append/flush fail.
    const path = logs[0];
    assert.equal(relative(root, path).startsWith('..'), false);
    await rename(path, `${path}.retained-test-prefix`);
    await mkdir(path);
    faultInjected = true;
    return { summary: 'Synthetic durability fault injected.', data: {} };
  });
  await assert.rejects(runDshSession({ brokerUrl: fixture.url, brokerToken: fixture.token, profile: 'conversation',
    modelConfig: { mode: 'fixture', actions: [{ name: 'cellSearch', args: {} }] },
    sessionId: 'native-durability-failure', nativeSession: { root, mode: 'resume' }, instruction: 'Synthetic storage failure.' }));
  assert.equal(faultInjected, true);
});

test('native create refuses existing history and resume refuses missing history', { timeout: 60_000 }, async context => {
  const root = await staging(context);
  const fixture = await broker(context);
  const common = { brokerUrl: fixture.url, brokerToken: fixture.token, profile: 'conversation', sessionId: 'native-exact-identity',
    modelConfig: { mode: 'fixture', actions: [] }, instruction: 'Exact identity only.' };
  await assert.rejects(runDshSession({ ...common, nativeSession: { root, mode: 'resume' } }));
  const result = await runDshSession({ ...common, nativeSession: { root, mode: 'create' } });
  assert.equal(result.persisted, true);
  await assert.rejects(runDshSession({ ...common, nativeSession: { root, mode: 'create' } }));
});
