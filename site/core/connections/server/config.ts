import { connectionDescriptorSchema, type ConnectionDescriptor } from "../contracts";
import { connectionConfigSchema, type ConnectionConfig } from "../configuration";
import { readLocalConnectionSettings } from "./local-config";
export type { ConnectionConfig } from "../configuration";

export function readConnectionConfigs(env: NodeJS.ProcessEnv = process.env): ConnectionConfig[] {
  const local = readLocalConnectionSettings(env);
  try {
    const configured = env.STUDIO_SQL_CONNECTIONS ? connectionConfigSchema.parse(JSON.parse(env.STUDIO_SQL_CONNECTIONS)) : [];
    // Duplicate IDs fail closed instead of silently changing the connected host
    // or privilege when a local settings file is introduced or edited.
    return connectionConfigSchema.parse([...configured, ...(local?.connections ?? [])]);
  } catch { throw new Error("数据库连接配置无效，请检查服务端 STUDIO_SQL_CONNECTIONS 与私有连接文件（连接 ID 不可重复）"); }
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
