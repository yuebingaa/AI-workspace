/** Portable DSH tool adapter. The host owns data, authorization and execution. */
export const name = 'agentcanvas-notebook-tools';
export const inject = ['tools'];

export const NOTEBOOK_TOOL_NAMES = Object.freeze([
  'cellSearch', 'editNotebookCells', 'runNotebookCells', 'submitNotebookDraft',
]);
export const SOURCE_TOOL_NAMES = Object.freeze([
  'getKernelPackagesInfo', 'inspectEdsRawWorkbook', 'readEdsRawRows', 'inspectConnectionSchema',
]);
const supportedNames = new Set([...NOTEBOOK_TOOL_NAMES, ...SOURCE_TOOL_NAMES]);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** @param {import('./index.mjs').NotebookPluginContext} ctx
 * @param {import('./index.mjs').NotebookPluginConfig} config */
export function apply(ctx, config) {
  if (!config || !Array.isArray(config.catalog) || typeof config.execute !== 'function') {
    throw new TypeError('Notebook plugin requires an explicit catalog and execution port.');
  }
  // Validate the whole catalog before registering anything. Never discover files,
  // read environment credentials, add tools, or widen a host's task capability.
  const names = new Set();
  const existing = new Set(ctx.tools.schemas().map(tool => tool.name));
  const catalog = Array.from(config.catalog, tool => {
    if (!record(tool) || !supportedNames.has(tool.name) || names.has(tool.name) || existing.has(tool.name)
      || typeof tool.description !== 'string' || !tool.description.trim() || !record(tool.parameters)) {
      throw new TypeError('Invalid or conflicting Notebook tool descriptor.');
    }
    names.add(tool.name);
    return { name: tool.name, description: tool.description, parameters: structuredClone(tool.parameters) };
  });
  const execute = config.execute;
  for (const tool of catalog) {
    ctx.tools.register({
      ...tool,
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      async execute(args, execution) {
        execution.signal.throwIfAborted();
        const result = await execute({ name: tool.name, args, callId: execution.callId, signal: execution.signal });
        execution.signal.throwIfAborted();
        return result;
      },
    });
  }
}
