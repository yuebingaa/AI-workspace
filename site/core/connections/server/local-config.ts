import { z } from "zod";
import { JsonFileSnapshotAdapter } from "@/core/persistence/server/json-file-snapshot";
import { connectionConfigSchema, type ConnectionConfig } from "../configuration";

// Server-private settings, never project data or browser configuration. Missing
// files preserve the existing environment-only behavior; corrupt files fail shut.
export const LOCAL_CONNECTION_FILE = "sql-connections.private.json";
export const localConnectionSettingsSchema = z.object({
  version: z.literal(1),
  connections: connectionConfigSchema,
  credentials: z.record(z.string().regex(/^[A-Z][A-Z0-9_]*$/u), z.string().min(1).max(8_192))
    .refine((values) => Object.keys(values).length <= 20, "Too many credential references"),
}).strict();
export type LocalConnectionSettings = z.infer<typeof localConnectionSettingsSchema>;

export function readLocalConnectionSettings(env: NodeJS.ProcessEnv = process.env): LocalConnectionSettings | null {
  const rootDirectory = env.STUDIO_LOCAL_STATE_DIR?.trim();
  if (!rootDirectory) return null;
  try {
    return new JsonFileSnapshotAdapter({ rootDirectory, fileName: LOCAL_CONNECTION_FILE,
      schema: localConnectionSettingsSchema, maxBytes: 192 * 1024 }).load();
  } catch {
    // Schema and filesystem diagnostics can contain private keys and paths.
    throw new Error("本地数据库连接配置无效，请检查服务端私有连接文件");
  }
}

/** Environment credentials keep precedence. A file secret belongs to its exact
 * configured connection, not to an arbitrary caller-supplied reference/name. */
export function resolveConnectionCredential(config: ConnectionConfig, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const key = config.kind === "postgresql" ? config.passwordEnv : config.tokenEnv;
  if (env[key] !== undefined) return env[key];
  const local = readLocalConnectionSettings(env);
  const registered = local?.connections.find((item) => item.id === config.id);
  if (!registered || JSON.stringify(registered) !== JSON.stringify(config)) return undefined;
  return local?.credentials[key];
}
