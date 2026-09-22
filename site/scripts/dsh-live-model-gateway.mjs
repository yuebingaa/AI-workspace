import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';

const ENDPOINT = 'https://api.deepseek.com/chat/completions';
const MAXIMUMS = Object.freeze({ maxRequests: 8, maxInputBytes: 600_000, maxRequestBytes: 100_000, requestTimeoutMs: 60_000 });
const DELIVERY_MAXIMUMS = Object.freeze({ maxRequests: 26, maxInputBytes: 4_000_000, maxRequestBytes: 200_000, requestTimeoutMs: 60_000 });
const MAX_TOKENS = 4096;
const SAFE_PROVIDER_CODES = new Set(['invalid_request_error', 'authentication_error', 'permission_error',
  'rate_limit_error', 'api_error', 'server_error', 'invalid_api_key', 'insufficient_quota',
  'rate_limit_exceeded', 'model_not_found', 'context_length_exceeded', 'invalid_parameter', 'invalid_request']);

function untilAborted(work, signal) {
  let abort;
  const cancelled = new Promise((_resolve, reject) => {
    abort = () => reject(new Error('aborted'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
  return Promise.race([work, cancelled]).finally(() => signal.removeEventListener('abort', abort));
}

async function providerErrorCode(response, signal) {
  if (!response.body) return undefined;
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await untilAborted(reader.read(), signal);
      if (done) break;
      length += value.byteLength;
      if (length > 8192) return undefined;
      chunks.push(value);
    }
    const error = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))).error;
    return [error?.code, error?.type].find(value => typeof value === 'string' && SAFE_PROVIDER_CODES.has(value));
  } catch { return undefined; }
  finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export function liveModelLimits(profile = 'smoke') {
  if (!['smoke', 'delivery'].includes(profile)) throw new Error('Unknown live acceptance profile.');
  return { ...(profile === 'delivery' ? DELIVERY_MAXIMUMS : MAXIMUMS) };
}

function limitsFor(input = {}, profile = 'smoke') {
  const maximums = liveModelLimits(profile);
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !Object.hasOwn(maximums, key))) throw new Error('Invalid live gateway limits.');
  const limits = { ...maximums, ...input };
  for (const key of Object.keys(maximums)) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] < 1 || limits[key] > maximums[key]) {
      throw new Error('Live gateway limits may only be tightened.');
    }
  }
  return limits;
}

function matchesSecret(actual, expected) {
  if (typeof actual !== 'string' || actual.length !== expected.length) return false;
  const left = Buffer.from(actual), right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function readBody(request, signal, maximum) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    const cleanup = () => {
      request.off('data', onData); request.off('end', onEnd); request.off('error', onError);
      signal.removeEventListener('abort', onAbort);
    };
    const fail = error => { cleanup(); reject(error); };
    const onData = chunk => {
      bytes += chunk.length;
      if (bytes > maximum) { fail(new Error('body_limit')); request.resume(); }
      else chunks.push(chunk);
    };
    const onEnd = () => { cleanup(); resolve(Buffer.concat(chunks)); };
    const onError = () => fail(new Error('request_error'));
    const onAbort = () => fail(new Error('aborted'));
    request.on('data', onData); request.on('end', onEnd); request.on('error', onError);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

function verifiedUsage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const { prompt_tokens: prompt, completion_tokens: completion, total_tokens: total } = value;
  if (![prompt, completion, total].every(number => Number.isSafeInteger(number) && number >= 0)
    || !Number.isSafeInteger(prompt + completion) || prompt + completion !== total) return undefined;
  return { promptTokens: prompt, completionTokens: completion, totalTokens: total };
}

/** Bounded, transient SSE decoding; only verified numerical usage escapes. */
function usageReader() {
  const decoder = new TextDecoder();
  let pending = '', discarding = false, latest, invalid = false, done = false;
  const line = value => {
    if (!value.startsWith('data:')) return;
    const data = value.slice(5).trim();
    if (!data) return;
    if (data === '[DONE]') { done = true; return; }
    if (done) { invalid = true; return; }
    try {
      const message = JSON.parse(data);
      if (message && Object.hasOwn(message, 'usage') && message.usage !== null) {
        const usage = verifiedUsage(message.usage);
        if (usage) latest = usage;
        else invalid = true;
      }
    } catch { invalid = true; }
  };
  return {
    consume(bytes) {
      pending += decoder.decode(bytes, { stream: true });
      let boundary;
      while ((boundary = pending.indexOf('\n')) !== -1) {
        const value = pending.slice(0, boundary).replace(/\r$/u, '');
        pending = pending.slice(boundary + 1);
        if (!discarding && value.length <= 131_072) line(value);
        else invalid = true;
        discarding = false;
      }
      if (pending.length > 131_072) { pending = ''; discarding = true; invalid = true; }
    },
    finish() {
      pending += decoder.decode();
      if (pending && !discarding) line(pending.replace(/\r$/u, ''));
      pending = '';
      return { usage: latest, invalid: invalid || !done };
    },
  };
}

function writeChunk(response, chunk, signal) {
  if (signal.aborted || response.destroyed) return Promise.reject(new Error('aborted'));
  if (response.write(chunk)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => { response.off('drain', drained); signal.removeEventListener('abort', aborted); };
    const drained = () => { cleanup(); resolve(); };
    const aborted = () => { cleanup(); reject(new Error('aborted')); };
    response.once('drain', drained);
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted();
  });
}

/**
 * Explicit paid-verification instrumentation, never a website execution path.
 * The caller owns paid-call authorization. No credentials or content are logged.
 */
export async function createLiveModelGateway({ apiKey, model, upstreamFetch = fetch, limits: requestedLimits, profile = 'smoke' } = {}) {
  if (typeof apiKey !== 'string' || apiKey.length < 8 || apiKey.length > 512 || /\s/u.test(apiKey)
    || model !== 'deepseek-flash' || typeof upstreamFetch !== 'function') throw new Error('Invalid live gateway configuration.');
  const limits = limitsFor(requestedLimits, profile);
  const token = randomBytes(32).toString('base64url');
  const authorization = `Bearer ${token}`;
  const active = new Set();
  const sockets = new Set();
  let host, closed = false, closing;
  const stats = { providerRequests: 0, inputBytes: 0, rejectedRequests: 0, completedResponses: 0,
    statuses: {}, providerErrorCodes: {}, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, verifiedResponses: 0, invalidResponses: 0 } };
  const server = createServer(async (request, response) => {
    const controller = new AbortController();
    active.add(controller);
    const disconnected = () => { if (!response.writableEnded) controller.abort(new Error('Client disconnected.')); };
    response.once('close', disconnected);
    const timer = setTimeout(() => controller.abort(new Error('Live request deadline.')), limits.requestTimeoutMs);
    const failure = (status, code) => {
      stats.rejectedRequests++;
      if (!response.headersSent && !response.destroyed) {
        response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', connection: 'close' });
        response.end(JSON.stringify({ error: code }));
      } else response.destroy();
      request.resume();
    };
    let reader;
    try {
      const countHeader = name => request.rawHeaders.filter((entry, index) => index % 2 === 0 && entry.toLowerCase() === name).length;
      if (closed || request.method !== 'POST' || request.url !== '/chat/completions'
        || request.headers.host !== host || countHeader('host') !== 1 || countHeader('authorization') !== 1
        || countHeader('origin') !== 0 || !matchesSecret(request.headers.authorization, authorization)) {
        failure(403, 'gateway_rejected'); return;
      }
      if (request.headers['content-type']?.split(';', 1)[0].trim().toLowerCase() !== 'application/json'
        || request.headers['content-encoding']) { failure(415, 'json_required'); return; }
      const declared = request.headers['content-length'];
      if (declared !== undefined && (!/^\d+$/u.test(declared) || Number(declared) > limits.maxRequestBytes)) {
        failure(413, 'request_limit'); return;
      }
      const bytes = await readBody(request, controller.signal, limits.maxRequestBytes);
      let body;
      try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
      catch { failure(400, 'invalid_json'); return; }
      if (!body || typeof body !== 'object' || Array.isArray(body) || body.model !== model) {
        failure(400, 'model_mismatch'); return;
      }
      body.max_tokens = MAX_TOKENS;
      delete body.max_completion_tokens;
      delete body.max_output_tokens;
      body.thinking = { type: 'disabled' };
      delete body.reasoning_effort;
      body.stream = true;
      body.stream_options = { include_usage: true };
      const outgoing = JSON.stringify(body), outgoingBytes = Buffer.byteLength(outgoing, 'utf8');
      if (outgoingBytes > limits.maxRequestBytes) { failure(413, 'request_limit'); return; }
      // Reserve synchronously before fetch; concurrent requests cannot overdraw.
      if (stats.providerRequests >= limits.maxRequests || stats.inputBytes + outgoingBytes > limits.maxInputBytes) {
        failure(429, 'live_budget_exhausted'); return;
      }
      controller.signal.throwIfAborted();
      stats.providerRequests++; stats.inputBytes += outgoingBytes;
      const fetching = Promise.resolve(upstreamFetch(ENDPOINT, { method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }, body: outgoing }));
      void fetching.then(value => { if (controller.signal.aborted) return value.body?.cancel().catch(() => {}); }).catch(() => {});
      const upstream = await untilAborted(fetching, controller.signal);
      controller.signal.throwIfAborted();
      stats.statuses[upstream.status] = (stats.statuses[upstream.status] ?? 0) + 1;
      if (!upstream.ok) {
        const code = await providerErrorCode(upstream, controller.signal);
        if (code) stats.providerErrorCodes[code] = (stats.providerErrorCodes[code] ?? 0) + 1;
        failure(upstream.status >= 400 ? upstream.status : 502, 'provider_rejected'); return;
      }
      if (!upstream.body || upstream.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'text/event-stream') {
        await upstream.body?.cancel().catch(() => {}); failure(502, 'provider_stream_required'); return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      const usage = usageReader();
      reader = upstream.body.getReader();
      while (true) {
        const { done, value } = await untilAborted(reader.read(), controller.signal);
        controller.signal.throwIfAborted();
        if (done) break;
        usage.consume(value);
        await writeChunk(response, value, controller.signal); // Original provider bytes, unchanged.
      }
      const observed = usage.finish();
      if (observed.invalid || !observed.usage) stats.usage.invalidResponses++;
      else {
        const combined = ['promptTokens', 'completionTokens', 'totalTokens'].map(key => stats.usage[key] + observed.usage[key]);
        if (!combined.every(Number.isSafeInteger)) stats.usage.invalidResponses++;
        else {
          ['promptTokens', 'completionTokens', 'totalTokens'].forEach((key, index) => { stats.usage[key] = combined[index]; });
          stats.usage.verifiedResponses++;
        }
      }
      stats.completedResponses++;
      response.end();
    } catch (error) {
      failure(controller.signal.aborted ? 504 : error?.message === 'body_limit' ? 413 : 502,
        controller.signal.aborted ? 'request_aborted' : error?.message === 'body_limit' ? 'request_limit' : 'upstream_failure');
    } finally {
      clearTimeout(timer); response.off('close', disconnected); active.delete(controller);
      controller.abort(new Error('Gateway request completed.'));
      await reader?.cancel().catch(() => {});
      reader?.releaseLock();
    }
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const address = server.address();
  host = `127.0.0.1:${address.port}`;
  return {
    baseURL: `http://${host}`,
    apiKey: token,
    summary: () => structuredClone(stats),
    close() {
      if (closing) return closing;
      closed = true;
      for (const controller of active) controller.abort(new Error('Live gateway closed.'));
      closing = new Promise((resolve, reject) => {
        server.close(error => error ? reject(new Error('Live gateway close failed.')) : resolve());
        for (const socket of sockets) socket.destroy();
      });
      return closing;
    },
  };
}
