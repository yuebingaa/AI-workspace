import { assertBrokerAddress } from './policy.mjs';

/** Child-local fetch allowlist; this is not an operating-system network sandbox. */
export function createWireFetch(upstream, { brokerUrl, brokerToken, modelConfig }) {
  const broker = assertBrokerAddress(brokerUrl);
  const modelEndpoint = modelConfig.mode === 'deepseek'
    ? new URL(`${modelConfig.baseURL.replace(/\/$/, '')}/chat/completions`).href : undefined;
  return async (input, init = {}) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin === broker.origin
      && ['/catalog', '/execute', '/authorize'].includes(url.pathname)
      && !url.search && !url.hash
      && request.headers.get('authorization') === `Bearer ${brokerToken}`
      && request.method === (url.pathname === '/catalog' ? 'GET' : 'POST')) {
      return upstream(request, { redirect: 'error' });
    }
    if (modelEndpoint && url.href === modelEndpoint && request.method === 'POST') {
      const body = await request.json();
      if (body.model !== modelConfig.model) throw new Error('DSH attempted to change the configured model.');
      // Upstream DSH supplies a default cap even when the website deliberately
      // sends none. Preserve the existing website's omitted max_tokens contract.
      if (modelConfig.maxTokens === undefined) delete body.max_tokens;
      // The existing website explicitly disables thinking and does not set an
      // effort. Do not leak an upstream adapter default into that request.
      delete body.reasoning_effort;
      body.thinking = { type: 'disabled' };
      return upstream(new Request(request, { body: JSON.stringify(body), redirect: 'error' }));
    }
    throw new Error('Network request is outside the DSH task allowlist.');
  };
}
