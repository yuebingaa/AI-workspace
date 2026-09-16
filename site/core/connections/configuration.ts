import { z } from "zod";
import { connectionIdSchema } from "./contracts";

// Server configuration definition only; public UI descriptors live in contracts.ts.
const common = {
  id: connectionIdSchema, name: z.string().min(1).max(120), allowAi: z.boolean().default(false),
  projects: z.array(z.union([z.literal("local"), z.string().uuid()])).min(1).max(100),
};
export const connectionConfigSchema = z.array(z.discriminatedUnion("kind", [
  z.object({ ...common, kind: z.literal("postgresql"), host: z.string().min(1).max(255),
    port: z.number().int().min(1).max(65535).default(5432), database: z.string().min(1).max(120),
    user: z.string().min(1).max(120), passwordEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/u),
    ssl: z.boolean().default(true),
  }).strict(),
  z.object({ ...common, kind: z.literal("databricks"),
    host: z.string().url().refine((value) => { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash; }, "需要 Databricks HTTPS origin"),
    warehouseId: z.string().regex(/^[a-fA-F0-9]+$/u).max(100),
    tokenEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/u),
    catalog: z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/u).max(120),
    schema: z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/u).max(120).default("default"),
  }).strict(),
])).max(20).refine((items) => new Set(items.map((item) => item.id)).size === items.length);
export type ConnectionConfig = z.infer<typeof connectionConfigSchema>[number];
