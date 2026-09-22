import {
  DEFAULT_NOTEBOOK_CAPABILITIES,
  type NotebookCapabilities,
} from "../capabilities";

const ENABLED_VALUES = new Set(["1", "true", "on"]);
const DISABLED_VALUES = new Set(["0", "false", "off"]);

export class NotebookCapabilityConfigurationError extends Error {
  constructor(readonly variable: string, readonly value: string) {
    super(`${variable} 配置无效：只能使用 true/1/on 或 false/0/off`);
    this.name = "NotebookCapabilityConfigurationError";
  }
}

export interface NotebookCapabilityEnvironment {
  readonly [name: string]: string | undefined;
  readonly NOTEBOOK_PYTHON_ENABLED?: string;
}

export function notebookCapabilitiesFromEnvironment(
  environment: NotebookCapabilityEnvironment = process.env,
): NotebookCapabilities {
  const raw = environment.NOTEBOOK_PYTHON_ENABLED;
  if (raw === undefined) return DEFAULT_NOTEBOOK_CAPABILITIES;

  const normalized = raw.trim().toLowerCase();
  if (ENABLED_VALUES.has(normalized)) return DEFAULT_NOTEBOOK_CAPABILITIES;
  if (DISABLED_VALUES.has(normalized)) {
    return Object.freeze({
      python: Object.freeze({
        enabled: false,
        reason: "Python Notebook 能力已通过服务器配置关闭",
      }),
    });
  }
  throw new NotebookCapabilityConfigurationError("NOTEBOOK_PYTHON_ENABLED", raw);
}
