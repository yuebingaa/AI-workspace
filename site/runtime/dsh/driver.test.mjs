import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { runDshSession, inspectDshRuntime } from './driver.mjs';
import { TOOL_NAMES, OPTIONAL_TOOL_NAMES, catalogToolNames } from './policy.mjs';
import { createWireFetch } from './wire-policy.mjs';
import { notebookSearchFailureMessage } from './tool-diagnostics.mjs';

async function broker(execute = async () => ({ summary: 'ok', data: { ok: true } }), authorize = () => true,
  names = TOOL_NAMES, options = {}) {
  const token = randomBytes(32).toString('hex');
  const calls = [];
  const server = createServer(async (request, response) => {
    if (request.headers.authorization !== `Bearer ${token}`) { response.writeHead(401).end(); return; }
    response.setHeader('content-type', 'application/json');
    if (request.url === '/catalog') {
      response.end(JSON.stringify({ tools: names.map((name) => ({ name, description: name, parameters: options.parameters ?? { type: 'object' } })) }));
    } else if (request.url === '/authorize') {
      calls.push('authorize'); response.end(JSON.stringify({ authorized: authorize() }));
    } else if (request.url === '/execute') {
      let body = ''; for await (const chunk of request) body += chunk;
      const call = JSON.parse(body); calls.push(call.name);
      try { response.end(JSON.stringify(await execute(call))); }
      catch { response.writeHead(422).end(JSON.stringify(options.failureBody ?? { error: 'Controlled failure' })); }
    } else response.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}/`, token, calls,
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }) };
}

test('official SDK subprocess runs exact four-tool profile and is reaped', { timeout: 30_000 }, async (context) => {
  assert.equal((await inspectDshRuntime()).available, true);
  const fixture = await broker();
  try {
    const result = await runDshSession({
      brokerUrl: fixture.url, brokerToken: fixture.token,
      modelConfig: { mode: 'fixture', actions: TOOL_NAMES.map((name) => ({ name, args: {} })) },
      instruction: 'Controlled SDK fixture.', sessionId: 'sdk-driver-success',
    });
    assert.equal(result.reaped, true);
    assert.equal(result.finalResponse, 'Controlled Notebook task completed.');
    assert.equal(result.events.filter((event) => event.type === 'tool/call').length, 4);
    assert.deepEqual(fixture.calls.filter((name) => name !== 'authorize'), TOOL_NAMES);
    assert.equal(fixture.calls.filter((name) => name === 'authorize').length, 5);
    const header = result.events.find((event) => event.type === 'request/header');
    assert.deepEqual(header.data.header.tools.map((tool) => tool.name).sort(), [...TOOL_NAMES].sort());
    const terminals = result.events.filter((event) => event.type === 'turn/end');
    assert.equal(terminals.length, 1);
    assert.equal(terminals[0].data.reason.kind, 'completed');
    context.diagnostic(JSON.stringify({
      eventTypes: [...new Set(result.events.map((event) => event.type))],
      terminal: { type: terminals[0].type, data: terminals[0].data },
      lastNotification: result.notifications.at(-1),
    }));
  } finally { await fixture.close(); }
});

test('official SDK registers and executes only the advertised optional business tools', { timeout: 30_000 }, async () => {
  const names = [...TOOL_NAMES, ...OPTIONAL_TOOL_NAMES];
  const fixture = await broker(undefined, undefined, names);
  try {
    const result = await runDshSession({
      brokerUrl: fixture.url, brokerToken: fixture.token,
      modelConfig: { mode: 'fixture', actions: names.map((name) => ({ name, args: {} })) },
      instruction: 'Controlled extended catalog fixture.', sessionId: 'sdk-driver-optional',
    });
    assert.equal(result.reaped, true);
    assert.equal(result.finalResponse, 'Controlled Notebook task completed.');
    assert.deepEqual(fixture.calls.filter((name) => name !== 'authorize'), names);
    assert.equal(fixture.calls.filter((name) => name === 'authorize').length, names.length + 1);
    for (const event of result.events.filter((entry) => entry.type === 'request/header')) {
      assert.deepEqual(event.data.header.tools.map((tool) => tool.name).sort(), [...names].sort());
    }
    assert.equal(result.events.filter((event) => event.type === 'tool/result'
      && event.data.message.content.some((block) => block.isError)).length, 0);
  } finally { await fixture.close(); }
});

for (const names of [['cellSearch'], ['runNotebookCells', 'cellSearch']]) {
  test(`official SDK runs the exact read-only profile ${names.join('+')} and denies edit/submit`, { timeout: 30_000 }, async () => {
    const fixture = await broker(undefined, undefined, names);
    try {
      const result = await runDshSession({ brokerUrl: fixture.url, brokerToken: fixture.token,
        modelConfig: { mode: 'fixture', actions: [
          ...names.map(name => ({ name, args: {} })),
          { name: 'editNotebookCells', args: {} }, { name: 'submitNotebookDraft', args: {} },
        ] },
        instruction: 'Controlled read-only profile fixture.', sessionId: `sdk-read-only-${names.length}`,
      });
      assert.equal(result.reaped, true);
      assert.deepEqual(fixture.calls.filter(name => name !== 'authorize'), names);
      for (const event of result.events.filter(entry => entry.type === 'request/header')) {
        assert.deepEqual(event.data.header.tools.map(tool => tool.name).sort(), [...names].sort());
      }
      assert.equal(result.events.filter(event => event.type === 'tool/result'
        && event.data.message.content.some(block => block.isError)).length, 2);
      assert.equal(result.events.find(event => event.type === 'turn/end').data.reason.kind, 'completed');
    } finally { await fixture.close(); }
  });
}

test('official SDK rejects an incomplete three-tool writable profile before model/tool dispatch', { timeout: 30_000 }, async () => {
  const fixture = await broker(undefined, undefined, ['cellSearch', 'runNotebookCells', 'editNotebookCells']);
  try {
    await assert.rejects(runDshSession({ brokerUrl: fixture.url, brokerToken: fixture.token,
      modelConfig: { mode: 'fixture', actions: [{ name: 'editNotebookCells', args: {} }] },
      instruction: 'Controlled rejected partial-write profile.', sessionId: 'sdk-incomplete-draft-profile',
    }));
    assert.deepEqual(fixture.calls, []);
  } finally { await fixture.close(); }
});

test('catalog policy rejects duplicates, unknown tools, missing required tools and malformed lists', () => {
  const catalog = (names) => names.map((name) => ({ name }));
  assert.deepEqual(catalogToolNames(catalog([...TOOL_NAMES, OPTIONAL_TOOL_NAMES[0]])), [...TOOL_NAMES, OPTIONAL_TOOL_NAMES[0]]);
  assert.deepEqual(catalogToolNames(catalog(TOOL_NAMES)), TOOL_NAMES);
  assert.deepEqual(catalogToolNames(catalog(['cellSearch'])), ['cellSearch']);
  assert.deepEqual(catalogToolNames(catalog(['cellSearch', 'runNotebookCells'])), ['cellSearch', 'runNotebookCells']);
  assert.deepEqual(catalogToolNames(catalog(['runNotebookCells', 'cellSearch'])), ['runNotebookCells', 'cellSearch']);
  for (const invalid of [[], ['runNotebookCells'], ['cellSearch', 'cellSearch'],
    ['cellSearch', 'editNotebookCells'], ['cellSearch', 'submitNotebookDraft'],
    ['cellSearch', 'runNotebookCells', 'editNotebookCells'],
    ['cellSearch', 'runNotebookCells', 'submitNotebookDraft'],
    ['cellSearch', 'editNotebookCells', 'submitNotebookDraft'],
    ['cellSearch', OPTIONAL_TOOL_NAMES[0]], ['cellSearch', 'runNotebookCells', OPTIONAL_TOOL_NAMES[0]]]) {
    assert.throws(() => catalogToolNames(catalog(invalid)), /catalog/);
  }
  assert.throws(() => catalogToolNames(catalog([...TOOL_NAMES, TOOL_NAMES[0]])), /catalog/);
  assert.throws(() => catalogToolNames(catalog([...TOOL_NAMES, 'bash'])), /catalog/);
  assert.throws(() => catalogToolNames(catalog([...TOOL_NAMES.slice(1), ...OPTIONAL_TOOL_NAMES])), /catalog/);
  assert.throws(() => catalogToolNames(undefined), /catalog/);
  assert.throws(() => catalogToolNames([...catalog(TOOL_NAMES), null]), /catalog/);
});

test('official SDK denies shell and unadvertised optional calls before reaching the broker', { timeout: 30_000 }, async () => {
  const fixture = await broker();
  try {
    const result = await runDshSession({
      brokerUrl: fixture.url, brokerToken: fixture.token,
      modelConfig: { mode: 'fixture', actions: [
        { name: 'bash', args: { command: 'never execute' } },
        ...OPTIONAL_TOOL_NAMES.map((name) => ({ name, args: {} })),
      ] },
      instruction: 'Controlled denied-tool fixture.', sessionId: 'sdk-driver-denied',
    });
    assert.equal(result.reaped, true);
    assert.deepEqual(fixture.calls.filter((name) => name !== 'authorize'), []);
    assert.equal(result.events.filter((event) => event.type === 'tool/result'
      && event.data.message.content.some((block) => block.isError)).length, 1 + OPTIONAL_TOOL_NAMES.length);
  } finally { await fixture.close(); }
});

test('tool broker failure remains real DSH error evidence', { timeout: 30_000 }, async () => {
  const fixture = await broker(async () => { throw new Error('controlled-tool-error'); });
  try {
    const result = await runDshSession({
      brokerUrl: fixture.url, brokerToken: fixture.token,
      modelConfig: { mode: 'fixture', actions: [{ name: 'cellSearch', args: {} }] },
      instruction: 'Controlled failure fixture.', sessionId: 'sdk-driver-tool-failure',
    });
    assert.equal(result.reaped, true);
    assert.equal(result.events.filter((event) => event.type === 'tool/result'
      && event.data.message.content.some((block) => block.isError)).length, 1);
  } finally { await fixture.close(); }
});

test('official SDK exposes only the same fixed search business diagnostic as the UI', { timeout: 30_000 }, async () => {
  const body = { error: { code: 'notebook_search_anchor_required' } };
  const fixture = await broker(async () => { throw new Error('SYNTHETIC_PRIVATE_BUSINESS_MESSAGE'); },
    undefined, ['cellSearch'], { failureBody: body });
  try {
    const result = await runDshSession({ brokerUrl: fixture.url, brokerToken: fixture.token,
      modelConfig: { mode: 'fixture', actions: [{ name: 'cellSearch', args: { direction: 'upstream' } }] },
      instruction: 'Controlled search diagnostic fixture.', sessionId: 'sdk-search-business-diagnostic',
    });
    const failures = result.events.filter(event => event.type === 'tool/result'
      && event.data.message.content.some(block => block.isError));
    assert.equal(failures.length, 1);
    const serialized = JSON.stringify(failures);
    assert.ok(serialized.includes(notebookSearchFailureMessage(body, 'cellSearch')));
    assert.doesNotMatch(serialized, /SYNTHETIC_PRIVATE/);
    assert.equal(result.reaped, true);
  } finally { await fixture.close(); }
});

test('official SDK receives safe argument feedback and a local model fixture corrects the next call', { timeout: 30_000 }, async () => {
  const attempts = [];
  const fixture = await broker(async (call) => {
    attempts.push(call.args);
    if (call.args.view !== 'source') throw new Error('SYNTHETIC_PRIVATE_VALIDATOR_MESSAGE');
    return { summary: 'Corrected source request.', data: { ok: true } };
  }, undefined, TOOL_NAMES, {
    parameters: { type: 'object', properties: { view: { type: 'string' } }, additionalProperties: false },
    failureBody: { error: { code: 'invalid_tool_arguments', issues: [{ path: 'view', code: 'invalid_value' }] } },
  });
  let requests = 0;
  const failures = [];
  const provider = createServer(async (request, response) => {
    try {
      let body = ''; for await (const chunk of request) body += chunk;
      const data = JSON.parse(body);
      const index = requests++;
      if (index === 1) {
        const feedback = JSON.stringify(data.messages.filter((message) => message.role === 'tool'));
        assert.match(feedback, /invalid_tool_arguments/);
        assert.match(feedback, /view: invalid_value/);
        assert.doesNotMatch(feedback, /SYNTHETIC_PRIVATE_VALIDATOR_MESSAGE/);
      }
      assert.ok(index < 3, 'the fixture does not perform extra model retries');
      const delta = index < 2 ? { role: 'assistant', tool_calls: [{ index: 0, id: `local-correction-${index}`,
        type: 'function', function: { name: 'cellSearch', arguments: JSON.stringify({ view: index === 0 ? 'invalid-synthetic-view' : 'source' }) } }] }
        : { role: 'assistant', content: 'Corrected using safe tool feedback.' };
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const [part, finish_reason] of [[delta, null], [{}, index < 2 ? 'tool_calls' : 'stop']]) {
        response.write(`data: ${JSON.stringify({ id: 'local-correction-fixture', object: 'chat.completion.chunk', created: 1,
          model: 'existing-model', choices: [{ index: 0, delta: part, finish_reason }],
        })}\n\n`);
      }
      response.end('data: [DONE]\n\n');
    } catch (error) { failures.push(error); response.writeHead(500).end('Local fixture assertion failed.'); }
  });
  await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
  try {
    const result = await runDshSession({
      brokerUrl: fixture.url, brokerToken: fixture.token,
      modelConfig: { mode: 'deepseek', apiKey: 'synthetic-local-test-key', model: 'existing-model',
        baseURL: `http://127.0.0.1:${provider.address().port}`, timeoutMs: 2000 },
      instruction: 'Controlled corrective provider fixture.', sessionId: 'sdk-driver-safe-arguments',
    });
    assert.deepEqual(failures, []);
    assert.equal(requests, 3);
    assert.deepEqual(attempts, [{ view: 'invalid-synthetic-view' }, { view: 'source' }]);
    const observations = result.events.filter((event) => event.type === 'tool/result');
    assert.equal(observations.length, 2);
    assert.equal(observations[0].data.message.content.some((block) => block.isError), true);
    assert.match(JSON.stringify(observations[0]), /invalid_tool_arguments/);
    assert.equal(observations[1].data.message.content.some((block) => block.isError), false);
    assert.equal(result.finalResponse, 'Corrected using safe tool feedback.');
    assert.equal(result.reaped, true);
  } finally {
    await fixture.close();
    provider.closeAllConnections();
    await new Promise((resolve) => provider.close(resolve));
  }
});

test('authorization is checked again before the second model dispatch', { timeout: 30_000 }, async () => {
  let checks = 0;
  const fixture = await broker(undefined, () => ++checks === 1);
  try {
    const notifications = [];
    await assert.rejects(runDshSession({
      brokerUrl: fixture.url, brokerToken: fixture.token,
      modelConfig: { mode: 'fixture', actions: TOOL_NAMES.map((name) => ({ name, args: {} })) },
      instruction: 'Controlled revocation fixture.', sessionId: 'sdk-driver-revoked',
      onNotification: (notification) => notifications.push(notification),
    }), /DSH runtime failed; no fallback executor was started/);
    assert.equal(checks, 2);
    assert.deepEqual(fixture.calls.filter((name) => name !== 'authorize'), ['cellSearch']);
    assert.equal(notifications.findLast((entry) => entry.method === 'session.event'
      && entry.params.event.type === 'turn/end').params.event.data.reason.kind, 'error');
  } finally { await fixture.close(); }
});

test('a failed final model dispatch cannot deliver a previously submitted draft', { timeout: 30_000 }, async () => {
  let checks = 0;
  const fixture = await broker(undefined, () => ++checks <= TOOL_NAMES.length);
  const notifications = [];
  try {
    await assert.rejects(runDshSession({
      brokerUrl: fixture.url, brokerToken: fixture.token,
      modelConfig: { mode: 'fixture', actions: TOOL_NAMES.map((name) => ({ name, args: {} })) },
      instruction: 'Controlled post-submit failure fixture.', sessionId: 'sdk-driver-post-submit-failure',
      onNotification: (notification) => notifications.push(notification),
    }), /DSH runtime failed; no fallback executor was started/);
    assert.equal(checks, 5);
    assert.deepEqual(fixture.calls.filter((name) => name !== 'authorize'), TOOL_NAMES);
    const events = notifications.filter((entry) => entry.method === 'session.event')
      .map((entry) => entry.params.event);
    assert.equal(events.filter((event) => event.type === 'tool/result').length, 4);
    assert.equal(events.filter((event) => event.type === 'tool/result'
      && event.data.message.content.some((block) => block.isError)).length, 0);
    assert.equal(events.findLast((event) => event.type === 'turn/end').data.reason.kind, 'error');
  } finally { await fixture.close(); }
});

test('cancellation closes and reaps the single task SDK subprocess', { timeout: 30_000 }, async () => {
  const controller = new AbortController();
  const fixture = await broker(async () => { controller.abort(); return { summary: 'cancelled', data: {} }; });
  try {
    await assert.rejects(runDshSession({
      brokerUrl: fixture.url, brokerToken: fixture.token, signal: controller.signal,
      modelConfig: { mode: 'fixture', actions: TOOL_NAMES.map((name) => ({ name, args: {} })) },
      instruction: 'Controlled cancellation fixture.', sessionId: 'sdk-driver-cancelled',
    }), (error) => error.name === 'AbortError');
    assert.deepEqual(fixture.calls.filter((name) => name !== 'authorize'), ['cellSearch']);
  } finally { await fixture.close(); }
});

test('wire policy preserves omitted model output quota and refuses external fetch', async () => {
  let sent;
  const wire = createWireFetch(async (request) => { sent = request; return Response.json({ ok: true }); }, {
    brokerUrl: 'http://127.0.0.1:31234/', brokerToken: 'x'.repeat(64),
    modelConfig: { mode: 'deepseek', baseURL: 'https://api.deepseek.com', model: 'existing-model' },
  });
  await wire('https://api.deepseek.com/chat/completions', {
    method: 'POST', body: JSON.stringify({ model: 'existing-model', max_tokens: 256000, reasoning_effort: 'high', stream: true }),
  });
  assert.deepEqual(await sent.json(), { model: 'existing-model', stream: true });
  assert.equal(sent.redirect, 'error');
  await assert.rejects(wire('https://example.invalid/'), /allowlist/);
});

test('official DeepSeek adapter uses local mocked SSE without imposing max_tokens or effort', { timeout: 30_000 }, async () => {
  const fixture = await broker();
  const requests = [];
  const provider = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    requests.push(JSON.parse(body));
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const [delta, finish_reason] of [[{ role: 'assistant', content: 'Local provider fixture.' }, null], [{}, 'stop']]) {
      response.write(`data: ${JSON.stringify({ id: 'local-provider-fixture', object: 'chat.completion.chunk', created: 1,
        model: 'existing-model', choices: [{ index: 0, delta, finish_reason }],
        ...(finish_reason ? { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } } : {}),
      })}\n\n`);
    }
    response.end('data: [DONE]\n\n');
  });
  await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
  try {
    const result = await runDshSession({
      brokerUrl: fixture.url, brokerToken: fixture.token,
      modelConfig: { mode: 'deepseek', apiKey: 'synthetic-local-test-key', model: 'existing-model',
        baseURL: `http://127.0.0.1:${provider.address().port}`, timeoutMs: 2000 },
      instruction: 'Controlled local provider fixture.', sessionId: 'sdk-driver-provider',
    });
    assert.equal(result.finalResponse, 'Local provider fixture.');
    assert.equal(result.reaped, true);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].model, 'existing-model');
    assert.deepEqual(requests[0].thinking, { type: 'disabled' });
    assert.equal(Object.hasOwn(requests[0], 'max_tokens'), false);
    assert.equal(Object.hasOwn(requests[0], 'reasoning_effort'), false);
  } finally {
    await fixture.close();
    provider.closeAllConnections();
    await new Promise((resolve) => provider.close(resolve));
  }
});
