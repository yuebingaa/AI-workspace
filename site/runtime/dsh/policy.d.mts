export const VERSION: string;
export const TOOL_NAMES: readonly string[];
export const OPTIONAL_TOOL_NAMES: readonly string[];
export const DISABLED_ROWS: readonly string[];
export type DshToolProfile = 'notebook' | 'conversation';
export function catalogToolNames(tools: unknown, profile?: DshToolProfile): readonly string[];
export function controlledDisabledRows(nativeSession?: boolean): readonly string[];
export function controlledPatch(pluginUrl: string, profile?: DshToolProfile,
  nativeSession?: { root: string; serverPluginUrl: string }, plugins?: { skills: boolean }): string;
export function assertBrokerAddress(value: string): URL;
