export const VERSION: string;
export const TOOL_NAMES: readonly string[];
export const OPTIONAL_TOOL_NAMES: readonly string[];
export const DISABLED_ROWS: readonly string[];
export function catalogToolNames(tools: unknown): readonly string[];
export function controlledPatch(pluginUrl: string): string;
export function assertBrokerAddress(value: string): URL;
