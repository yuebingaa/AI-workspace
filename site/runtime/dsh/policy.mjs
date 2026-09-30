import { NOTEBOOK_TOOL_NAMES, SOURCE_TOOL_NAMES } from './notebook-plugin/index.mjs';

export const VERSION = '0.1.7-rc.2';
export const TOOL_NAMES = NOTEBOOK_TOOL_NAMES;
export const OPTIONAL_TOOL_NAMES = SOURCE_TOOL_NAMES;

/** The parent advertises only this task's capabilities, not the whole allowlist. */
export function catalogToolNames(tools, profile = 'notebook') {
  if (!['notebook', 'conversation'].includes(profile)) throw new Error('Invalid task-owned tool profile.');
  if (!Array.isArray(tools)) throw new Error('Invalid task-owned tool catalog.');
  const names = tools.map((tool) => tool?.name);
  const readOnly = names.length === 1 && names.includes('cellSearch')
    || names.length === 2 && names.includes('cellSearch') && names.includes('runNotebookCells');
  const completeDraft = TOOL_NAMES.every((name) => names.includes(name));
  const conversationOnly = profile === 'conversation' && names.length === 0;
  if (new Set(names).size !== names.length || (!readOnly && !completeDraft && !conversationOnly)
    || names.some((name) => !TOOL_NAMES.includes(name) && !OPTIONAL_TOOL_NAMES.includes(name))) {
    throw new Error('Task tool catalog must match a read-only Notebook profile or all required draft tools with allowed optional tools.');
  }
  return Object.freeze(names);
}
export const DISABLED_ROWS = Object.freeze([
  'llm-deepseek', 'deepseek-llm-api-extensions', 'session-log-deepseek',
  'plugin-package-inventory-deepseek', 'sandbox', 'sandbox-policy', 'subprocess',
  'pty', 'terminal-bash', 'terminal-pwsh', 'persistent-bash', 'persistent-pwsh',
  'jobs', 'mcp-resources', 'sessions', 'llm-retry',
]);

export function controlledDisabledRows(nativeSession = false) {
  return nativeSession ? [...DISABLED_ROWS.filter(id => id !== 'sessions'), 'sdk-jsonrpc-server'] : DISABLED_ROWS;
}

export function controlledPatch(pluginUrl, profile = 'notebook', nativeSession, plugins = { skills: false }) {
  if (!['notebook', 'conversation'].includes(profile)) throw new Error('Invalid task-owned tool profile.');
  const persona = profile === 'conversation'
    ? 'You are the DSH conversation assistant embedded in AgentCanvas. Respond naturally, clarify when needed, and use the supplied business tools only when relevant. Never invent tool results. A draft requires explicit user adoption; never claim it is already saved.'
    : 'Use only the supplied Notebook tools. A draft requires explicit user adoption; never claim it is already saved.';
  return [
    ...controlledDisabledRows(Boolean(nativeSession)).map((id) => `- id: ${id}\n  disabled: true`),
    ...(nativeSession ? [
      `- id: sessions\n  disabled: false\n  config:\n    root: ${JSON.stringify(nativeSession.root)}\n    compression: none`,
      `- insert:\n    - id: agentcanvas-session-server\n      name: ${JSON.stringify(nativeSession.serverPluginUrl)}`,
    ] : []),
    `- id: system-prompt\n  config:\n    includeHarnessIdentity: false\n    includeRuntimeContext: false\n    personaPrefix: ${JSON.stringify(persona)}`,
    '- id: tools\n  config:\n    mode: native',
    ...(plugins.skills ? [
      '- insert:\n    - id: agentcanvas-skill-registry\n      name: "@deepseek-ai/dsh-skill"',
      `- insert:\n    - id: agentcanvas-builtin-skills\n      name: ${JSON.stringify(new URL('./builtin-skills.mjs', pluginUrl).href)}`,
      '- insert:\n    - id: agentcanvas-tool-skill\n      name: "@deepseek-ai/dsh-tool-skill"',
    ] : []),
    `- insert:\n    - id: agentcanvas-controlled\n      name: ${JSON.stringify(pluginUrl)}`,
    '',
  ].join('\n');
}

export function assertBrokerAddress(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port
    || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('DSH requires a task-owned IPv4 loopback broker root.');
  }
  return url;
}
