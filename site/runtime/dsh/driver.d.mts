export interface DshModelConfig {
  mode: 'deepseek'; apiKey: string; baseURL: string; model: string;
  timeoutMs?: number; maxTokens?: number; contextWindow?: number;
}
export interface DshFixtureConfig {
  mode: 'fixture'; actions: { name: string; args: unknown }[]; finalText?: string;
}
export interface DshInspection {
  available: boolean; version: string; reason?: string;
  phase?: 'node' | 'installation' | 'sdk_import' | 'carrier_import' | 'ready';
  code?: 'node_unsupported' | 'installation_unavailable' | 'module_not_found' | 'unsupported_module_url'
    | 'module_loader_unavailable' | 'sdk_export_missing' | 'sdk_import_failed' | 'carrier_import_failed';
}
export interface DshSessionResult {
  sessionId: string; finalResponse: string; events: unknown[]; notifications: unknown[];
  runtime: 'official-dsh-sdk'; version: string; mode: 'deepseek' | 'fixture';
  reaped: boolean;
  /** Candidate log only; the website must independently validate and commit it. */
  persisted?: true;
}
export function inspectDshRuntime(): Promise<DshInspection>;
export function inspectDshPluginPackages(): Promise<Record<string, { installed: boolean; version?: string }>>;
export function inspectDshPackageInventory(): Promise<import('./package-inventory.mjs').DshPackageInventorySnapshot>;
export function runDshSession(options: {
  brokerUrl: string; brokerToken: string; modelConfig: DshModelConfig | DshFixtureConfig;
  instruction: string; sessionId: string; signal?: AbortSignal;
  profile?: 'notebook' | 'conversation';
  plugins?: { skills: boolean };
  nativeSession?: { root: string; mode: 'create' | 'resume' };
  onNotification?: (notification: unknown) => void;
}): Promise<DshSessionResult>;
