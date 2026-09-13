import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "agentcanvas-test-server", version: "1.0.0" });

server.registerTool("records/list", {
  description: "List test records",
  inputSchema: { limit: z.number().int().min(1).max(10) },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
}, async ({ limit }) => ({
  content: [{ type: "text", text: `returned:${limit}` }],
  structuredContent: { returned: limit },
}));

await server.connect(new StdioServerTransport());
