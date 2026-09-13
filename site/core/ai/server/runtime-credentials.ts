import { DEFAULT_DEEPSEEK_MODEL } from "@/core/ai/contracts";

const runtimeCredentialsKey = Symbol.for("agentcanvas.runtime-ai-credentials");

interface RuntimeCredentialsStore {
  deepSeekApiKey?: string;
  deepSeekModel?: string;
  deepSeekModels?: DeepSeekAvailableModel[];
}

export interface DeepSeekAvailableModel {
  id: string;
  ownedBy: string;
}

export interface DeepSeekCredentialStatus {
  configured: boolean;
  source: "runtime" | "environment" | "none";
}

export interface DeepSeekSettingsStatus extends DeepSeekCredentialStatus {
  model: string;
  modelSource: "runtime" | "environment" | "default";
  availableModels: DeepSeekAvailableModel[];
  modelsDiscovered: boolean;
}

function runtimeCredentials(): RuntimeCredentialsStore {
  const target = globalThis as unknown as Record<PropertyKey, unknown>;
  const existing = target[runtimeCredentialsKey];
  if (existing && typeof existing === "object") return existing as RuntimeCredentialsStore;
  const created: RuntimeCredentialsStore = {};
  target[runtimeCredentialsKey] = created;
  return created;
}

export function normalizeDeepSeekApiKey(value: unknown): string {
  if (typeof value !== "string") throw new Error("API Key 必须是字符串。");
  const normalized = value.trim();
  if (normalized.length < 8 || normalized.length > 512) throw new Error("API Key 长度必须在 8–512 个字符之间。");
  if (/\s|[\u0000-\u001f\u007f]/u.test(normalized)) throw new Error("API Key 不能包含空格或控制字符。");
  return normalized;
}

export function setRuntimeDeepSeekApiKey(value: unknown): void {
  const store = runtimeCredentials();
  store.deepSeekApiKey = normalizeDeepSeekApiKey(value);
  delete store.deepSeekModel;
  delete store.deepSeekModels;
}

export function clearRuntimeDeepSeekApiKey(): void {
  const store = runtimeCredentials();
  delete store.deepSeekApiKey;
  delete store.deepSeekModel;
  delete store.deepSeekModels;
}

export function resolveDeepSeekApiKey(): string | undefined {
  return runtimeCredentials().deepSeekApiKey ?? (process.env.DEEPSEEK_API_KEY?.trim() || undefined);
}

export function deepSeekCredentialStatus(): DeepSeekCredentialStatus {
  if (runtimeCredentials().deepSeekApiKey) return { configured: true, source: "runtime" };
  if (process.env.DEEPSEEK_API_KEY?.trim()) return { configured: true, source: "environment" };
  return { configured: false, source: "none" };
}

export function normalizeDeepSeekModel(value: unknown): string {
  if (typeof value !== "string") throw new Error("模型标识必须是字符串。");
  const normalized = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(normalized)) throw new Error("模型标识格式无效。");
  return normalized;
}

function normalizeAvailableModels(models: DeepSeekAvailableModel[]): DeepSeekAvailableModel[] {
  const unique = new Map<string, DeepSeekAvailableModel>();
  for (const model of models) {
    const id = normalizeDeepSeekModel(model.id);
    const ownedBy = typeof model.ownedBy === "string" ? model.ownedBy.trim().slice(0, 120) : "";
    if (!ownedBy) throw new Error("模型提供方不能为空。");
    if (!unique.has(id)) unique.set(id, { id, ownedBy });
  }
  const normalized = [...unique.values()];
  if (normalized.length < 1 || normalized.length > 100) throw new Error("可用模型数量必须在 1–100 之间。");
  return normalized;
}

export function resolveDeepSeekModel(): string {
  return runtimeCredentials().deepSeekModel
    ?? (process.env.DEEPSEEK_MODEL?.trim() || DEFAULT_DEEPSEEK_MODEL);
}

export function setRuntimeDeepSeekDiscovery(
  models: DeepSeekAvailableModel[],
  options: { apiKey?: unknown; preferredModel?: unknown } = {},
): void {
  const normalizedModels = normalizeAvailableModels(models);
  const availableIds = new Set(normalizedModels.map((model) => model.id));
  const preferred = options.preferredModel === undefined ? resolveDeepSeekModel() : normalizeDeepSeekModel(options.preferredModel);
  const environmentModel = process.env.DEEPSEEK_MODEL?.trim();
  const selected = [preferred, environmentModel, DEFAULT_DEEPSEEK_MODEL]
    .find((candidate): candidate is string => Boolean(candidate && availableIds.has(candidate)))
    ?? normalizedModels[0].id;
  const normalizedKey = options.apiKey === undefined ? undefined : normalizeDeepSeekApiKey(options.apiKey);
  const store = runtimeCredentials();
  if (normalizedKey !== undefined) store.deepSeekApiKey = normalizedKey;
  store.deepSeekModels = normalizedModels;
  store.deepSeekModel = selected;
}

export function setRuntimeDeepSeekModel(value: unknown): void {
  const model = normalizeDeepSeekModel(value);
  const available = runtimeCredentials().deepSeekModels;
  if (!available?.some((candidate) => candidate.id === model)) {
    throw new Error("所选模型不在本次 API 识别结果中，请重新识别模型。");
  }
  runtimeCredentials().deepSeekModel = model;
}

export function deepSeekSettingsStatus(): DeepSeekSettingsStatus {
  const credential = deepSeekCredentialStatus();
  const store = runtimeCredentials();
  const environmentModel = process.env.DEEPSEEK_MODEL?.trim();
  return {
    ...credential,
    model: resolveDeepSeekModel(),
    modelSource: store.deepSeekModel ? "runtime" : environmentModel ? "environment" : "default",
    availableModels: store.deepSeekModels ? structuredClone(store.deepSeekModels) : [],
    modelsDiscovered: Boolean(store.deepSeekModels),
  };
}
