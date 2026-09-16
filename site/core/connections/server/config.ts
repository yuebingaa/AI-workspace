import { connectionDescriptorSchema, type ConnectionDescriptor } from "../contracts";
import { connectionConfigSchema, type ConnectionConfig } from "../configuration";
export type { ConnectionConfig } from "../configuration";

export function readConnectionConfigs(env: NodeJS.ProcessEnv = process.env): ConnectionConfig[] {
  if (!env.STUDIO_SQL_CONNECTIONS) return [];
  try { return connectionConfigSchema.parse(JSON.parse(env.STUDIO_SQL_CONNECTIONS)); }
  catch { throw new Error("数据库连接配置无效，请检查服务端 STUDIO_SQL_CONNECTIONS"); }
}
export function listConnections(project: string | null, forAi = false): ConnectionDescriptor[] {
  return readConnectionConfigs().filter((item) => item.projects.includes(project ?? "local") && (!forAi || item.allowAi))
    .map((item) => connectionDescriptorSchema.parse({ id: item.id, name: item.name, kind: item.kind, allowAi: item.allowAi }));
}
export function resolveConnection(id: string, project: string | null, forAi: boolean): ConnectionConfig {
  const config = readConnectionConfigs().find((item) => item.id === id && item.projects.includes(project ?? "local"));
  if (!config || (forAi && !config.allowAi)) throw new Error("连接不存在或未授权给当前项目 / Agent");
  return config;
}
