import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { createLiveModelGateway } from './dsh-live-model-gateway.mjs';

const secret = 'unit-only-upstream-key';
const model = 'deepseek-flash';
const usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 };
const payload = { model, messages: [{ role: 'user', content: 'SYNTHETIC_PRIVATE_PROMPT' }] };
const event = value => `data: ${JSON.stringify(value)}\n\n`;
const streamText = (value = usage) => event({ choices: [{ delta: { content: 'SYNTHETIC_PRIVATE_REPLY', reasoning_content: 'NOT_RECORDED' } }] })
  + event({ usage: value, choices: [] }) + 'data: [DONE]\n\n';
function upstreamResponse(value = usage) {
  return new Response(streamText(value), { headers: { 'content-type': 'text/event-stream' } });
}
async function gateway(t, options = {}) {
  const instance = await createLiveModelGateway({ apiKey: secret, model, upstreamFetch: async () => upstreamResponse(), ...options });
  t.after(() => instance.close());
  return instance;
}
function post(instance, body = payload, options = {}) {
  return fetch(`${instance.baseURL}/chat/completions`, { method: 'POST', ...options,
    headers: { authorization: `Bearer ${instance.apiKey}`, 'content-type': 'application/json', ...options.headers },
    body: typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body) });
}
function raw(instance, { path = '/chat/completions', method = 'POST', headers, body = JSON.stringify(payload) }) {
  const url = new URL(instance.baseURL);
  return new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: '127.0.0.1', port: url.port, path, method,
      headers: headers ?? { Host: url.host, Authorization: `Bearer ${instance.apiKey}`, 'Content-Type': 'application/json' } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('error', reject); request.end(body);
  });
}

test('forwards original SSE bytes while enforcing fixed provider, model and paid-call policy', async t => {
  let received;
  const original = Buffer.from(streamText());
  const instance = await gateway(t, { upstreamFetch: async (url, init) => {
    received = { url, init };
    return new Response(new ReadableStream({ start(controller) {
      for (const [start, end] of [[0, 3], [3, 21], [21, original.length - 2], [original.length - 2, original.length]]) {
        controller.enqueue(original.subarray(start, end));
      }
      controller.close();
    } }), { headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
  } });
  assert.notEqual(instance.apiKey, secret);
  const response = await post(instance, { ...payload, max_tokens: 1_000_000, max_completion_tokens: 1_000_000,
    thinking: { type: 'enabled' }, reasoning_effort: 'high', stream: false, stream_options: { include_usage: false } });
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), original);
  assert.equal(received.url, 'https://api.deepseek.com/chat/completions');
  assert.equal(received.init.redirect, 'error');
  assert.equal(received.init.headers.authorization, `Bearer ${secret}`);
  assert.deepEqual(JSON.parse(received.init.body), { ...payload, max_tokens: 4096,
    thinking: { type: 'disabled' }, stream: true, stream_options: { include_usage: true } });
  const summary = instance.summary();
  assert.equal(summary.providerRequests, 1);
  assert.equal(summary.completedResponses, 1);
  assert.equal(summary.inputBytes, Buffer.byteLength(received.init.body));
  assert.deepEqual(summary.statuses, { 200: 1 });
  assert.deepEqual(summary.usage, { promptTokens: 100, completionTokens: 20, totalTokens: 120, verifiedResponses: 1, invalidResponses: 0 });
  for (const forbidden of [secret, instance.apiKey, 'SYNTHETIC_PRIVATE_PROMPT', 'SYNTHETIC_PRIVATE_REPLY', 'NOT_RECORDED']) {
    assert.equal(JSON.stringify(summary).includes(forbidden), false);
  }
  summary.providerRequests = 999; summary.statuses[200] = 999;
  assert.equal(instance.summary().providerRequests, 1);
  assert.equal(instance.summary().statuses[200], 1);
});

for (const variant of ['host', 'token', 'origin', 'empty-origin', 'duplicate-auth', 'method', 'path', 'query', 'absolute-url']) {
  test(`rejects ${variant} before provider access`, async t => {
    let calls = 0;
    const instance = await gateway(t, { upstreamFetch: async () => { calls++; return upstreamResponse(); } });
    const host = new URL(instance.baseURL).host;
    const headers = { Host: host, Authorization: `Bearer ${instance.apiKey}`, 'Content-Type': 'application/json' };
    const options = { headers };
    if (variant === 'host') headers.Host = 'attacker.invalid';
    if (variant === 'token') headers.Authorization = 'Bearer invalid';
    if (variant === 'origin' || variant === 'empty-origin') headers.Origin = variant === 'origin' ? instance.baseURL : '';
    if (variant === 'duplicate-auth') options.headers = ['Host', host, 'Authorization', headers.Authorization,
      'Authorization', headers.Authorization, 'Content-Type', 'application/json'];
    if (variant === 'method') options.method = 'PUT';
    if (variant === 'path') options.path = '/execute';
    if (variant === 'query') options.path = '/chat/completions?key=not-accepted';
    if (variant === 'absolute-url') options.path = `${instance.baseURL}/chat/completions`;
    const response = await raw(instance, options);
    assert.equal(response.status, 403);
    assert.equal(calls, 0); assert.equal(instance.summary().providerRequests, 0);
  });
}

test('rejects unsupported model, non-JSON, malformed JSON and invalid UTF-8 without paying', async t => {
  const instance = await gateway(t);
  for (const [body, options, status] of [
    [{ ...payload, model: 'other-model' }, {}, 400],
    ['{', {}, 400],
    [new Uint8Array([0xc3, 0x28]), {}, 400],
    [payload, { headers: { 'content-type': 'text/plain' } }, 415],
    [payload, { headers: { 'content-encoding': 'gzip' } }, 415],
  ]) {
    const response = await post(instance, body, options);
    assert.equal(response.status, status); await response.text();
  }
  assert.equal(instance.summary().providerRequests, 0);
});

test('reserves request counts atomically and never retries rejected or failed provider calls', async t => {
  let calls = 0;
  const instance = await gateway(t, { limits: { maxRequests: 1 }, upstreamFetch: async () => {
    calls++;
    return new Response(JSON.stringify({ error: { type: 'authentication_error', message: secret } }), { status: 401 });
  } });
  const responses = await Promise.all([post(instance), post(instance), post(instance)]);
  assert.deepEqual(responses.map(response => response.status).sort(), [401, 429, 429]);
  for (const response of responses) assert.equal((await response.text()).includes(secret), false);
  assert.equal(calls, 1);
  assert.equal(instance.summary().providerRequests, 1);
  assert.deepEqual(instance.summary().statuses, { 401: 1 });
  assert.deepEqual(instance.summary().providerErrorCodes, { authentication_error: 1 });
});

test('hard default cap permits eight upstream requests and refuses the ninth', async t => {
  const instance = await gateway(t);
  for (let index = 0; index < 8; index++) {
    const response = await post(instance); assert.equal(response.status, 200); await response.text();
  }
  const denied = await post(instance); assert.equal(denied.status, 429); await denied.text();
  assert.equal(instance.summary().providerRequests, 8);
});

test('explicit delivery profile allows a recovery loop but rejects the twenty-seventh request', async t => {
  const instance = await gateway(t, { profile: 'delivery' });
  for (let index = 0; index < 26; index++) {
    const response = await post(instance); assert.equal(response.status, 200); await response.text();
  }
  const denied = await post(instance); assert.equal(denied.status, 429); await denied.text();
  assert.equal(instance.summary().providerRequests, 26);
  await assert.rejects(createLiveModelGateway({ apiKey: secret, model, profile: 'unlimited' }));
  await assert.rejects(createLiveModelGateway({ apiKey: secret, model, profile: 'delivery', limits: { maxRequests: 27 } }));
});

test('charges transformed UTF-8 request bytes, rejecting per-request and aggregate excess', async t => {
  const instance = await gateway(t, { limits: { maxRequestBytes: 300, maxInputBytes: 350 } });
  const first = await post(instance); assert.equal(first.status, 200); await first.text();
  assert.ok(instance.summary().inputBytes > 175);
  const total = await post(instance); assert.equal(total.status, 429); await total.text();
  const tooLarge = await post(instance, { model, messages: [{ role: 'user', content: '长'.repeat(101) }] });
  assert.equal(tooLarge.status, 413); await tooLarge.text();
  assert.equal(instance.summary().providerRequests, 1);
});

test('chunked bodies are bounded even without Content-Length', async t => {
  const instance = await gateway(t, { limits: { maxRequestBytes: 200 } });
  const response = await raw(instance, { headers: { Host: new URL(instance.baseURL).host,
    Authorization: `Bearer ${instance.apiKey}`, 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' },
  body: JSON.stringify({ model, messages: ['x'.repeat(400)] }) });
  assert.equal(response.status, 413); assert.equal(instance.summary().providerRequests, 0);
});

for (const value of [
  { prompt_tokens: -1, completion_tokens: 2, total_tokens: 1 },
  { prompt_tokens: '1', completion_tokens: 2, total_tokens: 3 },
  { prompt_tokens: 1.1, completion_tokens: 2, total_tokens: 3.1 },
  { prompt_tokens: 1, completion_tokens: 2, total_tokens: 4 },
  { prompt_tokens: Number.MAX_SAFE_INTEGER, completion_tokens: 2, total_tokens: Number.MAX_SAFE_INTEGER + 2 },
]) {
  test(`invalid usage is not counted: ${JSON.stringify(value)}`, async t => {
    const instance = await gateway(t, { upstreamFetch: async () => upstreamResponse(value) });
    const response = await post(instance); await response.text();
    assert.deepEqual(instance.summary().usage, { promptTokens: 0, completionTokens: 0, totalTokens: 0, verifiedResponses: 0, invalidResponses: 1 });
  });
}

test('repeated terminal usage is counted once per completed provider response', async t => {
  const instance = await gateway(t, { upstreamFetch: async () => new Response(event({ usage }) + event({ usage }) + 'data: [DONE]\n\n',
    { headers: { 'content-type': 'text/event-stream' } }) });
  const response = await post(instance); await response.text();
  assert.equal(instance.summary().usage.totalTokens, 120);
  assert.equal(instance.summary().usage.verifiedResponses, 1);
});

for (const body of [event({ usage }), 'data: [DONE]\n\n', event({ usage }) + 'data: [DONE]\n\n' + event({ usage })]) {
  test('missing usage, missing terminal marker or post-terminal data cannot produce verified usage', async t => {
    const instance = await gateway(t, { upstreamFetch: async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } }) });
    const response = await post(instance); assert.equal(await response.text(), body);
    assert.equal(instance.summary().usage.totalTokens, 0);
    assert.equal(instance.summary().usage.invalidResponses, 1);
  });
}

test('oversized SSE lines are forwarded unchanged but not retained or treated as verified usage', async t => {
  const body = event({ choices: [{ delta: { content: 'x'.repeat(140_000) } }] }) + event({ usage }) + 'data: [DONE]\n\n';
  const instance = await gateway(t, { upstreamFetch: async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } }) });
  const response = await post(instance); assert.equal(await response.text(), body);
  assert.equal(instance.summary().usage.invalidResponses, 1);
  assert.ok(JSON.stringify(instance.summary()).length < 500);
});

test('rejects non-SSE successes and never forwards their content', async t => {
  const instance = await gateway(t, { upstreamFetch: async () => new Response(secret,
    { headers: { 'content-type': 'text/event-stream-invalid' } }) });
  const response = await post(instance); assert.equal(response.status, 502);
  assert.equal((await response.text()).includes(secret), false);
  assert.equal(instance.summary().completedResponses, 0);
});

test('error diagnostics preserve only allowlisted type/code, never provider message or arbitrary labels', async t => {
  const instance = await gateway(t, { upstreamFetch: async () => new Response(JSON.stringify({ error: {
    code: secret, type: 'invalid_request_error', message: `${secret} ${payload.messages[0].content}`,
  } }), { status: 400 }) });
  const response = await post(instance); assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'provider_rejected' });
  assert.deepEqual(instance.summary().providerErrorCodes, { invalid_request_error: 1 });
  assert.equal(JSON.stringify(instance.summary()).includes(secret), false);
});

test('request deadline aborts upstream and does not wait for an uncooperative fetch', async t => {
  let signal;
  const instance = await gateway(t, { limits: { requestTimeoutMs: 60 }, upstreamFetch: async (_url, init) => {
    signal = init.signal; return new Promise(() => {});
  } });
  const response = await post(instance); assert.equal(response.status, 504); await response.text();
  assert.equal(signal.aborted, true);
  assert.equal(instance.summary().providerRequests, 1);
  assert.equal(instance.summary().completedResponses, 0);
});

test('stalled SSE is cancelled at the deadline and partial usage is not booked', async t => {
  let signal, cancelled = false;
  const instance = await gateway(t, { limits: { requestTimeoutMs: 70 }, upstreamFetch: async (_url, init) => {
    signal = init.signal;
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(event({ usage }))); },
      cancel() { cancelled = true; } }), { headers: { 'content-type': 'text/event-stream' } });
  } });
  const response = await post(instance);
  await assert.rejects(response.text());
  assert.equal(signal.aborted, true); assert.equal(cancelled, true);
  assert.equal(instance.summary().usage.verifiedResponses, 0);
  assert.equal(instance.summary().completedResponses, 0);
});

test('client disconnect aborts upstream; close also cancels all active streams', async t => {
  const signals = [];
  let cancelled = 0;
  const instance = await gateway(t, { upstreamFetch: async (_url, init) => {
    signals.push(init.signal);
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(': ready\n\n')); },
      cancel() { cancelled++; } }), { headers: { 'content-type': 'text/event-stream' } });
  } });
  const first = await post(instance);
  const reader = first.body.getReader(); await reader.read(); await reader.cancel();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(signals[0].aborted, true);
  const second = await post(instance);
  const consumption = second.text().catch(() => 'cancelled');
  await instance.close(); await consumption;
  assert.equal(signals[1].aborted, true);
  assert.equal(cancelled, 2);
  assert.equal(instance.summary().completedResponses, 0);
  await instance.close();
});

test('configuration cannot loosen any paid-verification ceiling', async () => {
  for (const limits of [{ maxRequests: 9 }, { maxRequestBytes: 100001 }, { maxInputBytes: 600001 },
    { requestTimeoutMs: 60001 }, { maxRequests: 0 }, { maxRequests: 1.5 }, { endpoint: 'https://elsewhere.invalid' }]) {
    await assert.rejects(createLiveModelGateway({ apiKey: secret, model, limits }), /limits/u);
  }
  await assert.rejects(createLiveModelGateway({ apiKey: secret, model: 'other-model' }), /configuration/u);
});
