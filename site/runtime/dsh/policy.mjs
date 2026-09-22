export const VERSION = '0.1.6-alpha.2';
export const TOOL_NAMES = Object.freeze([
  'cellSearch', 'editNotebookCells', 'runNotebookCells', 'submitNotebookDraft',
]);
export const OPTIONAL_TOOL_NAMES = Object.freeze([
  'getKernelPackagesInfo', 'inspectEdsRawWorkbook', 'readEdsRawRows', 'inspectConnectionSchema',
]);

/** The parent advertises only this task's capabilities, not the whole allowlist. */
export function catalogToolNames(tools) {
  if (!Array.isArray(tools)) throw new Error('Invalid task-owned tool catalog.');
  const names = tools.map((tool) => tool?.name);
  const readOnly = names.length === 1 && names.includes('cellSearch')
    || names.length === 2 && names.includes('cellSearch') && names.includes('runNotebookCells');
  const completeDraft = TOOL_NAMES.every((name) => names.includes(name));
  if (new Set(names).size !== names.length || (!readOnly && !completeDraft)
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

export function controlledPatch(pluginUrl) {
  return [
    ...DISABLED_ROWS.map((id) => `- id: ${id}\n  disabled: true`),
    '- id: system-prompt\n  config:\n    includeHarnessIdentity: false\n    includeRuntimeContext: false\n    personaPrefix: "Use only the supplied Notebook tools. A draft requires explicit user adoption; never claim it is already saved."',
    '- id: tools\n  config:\n    mode: native',
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
