import { randomUUID } from "crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { createMcpServer } from "./server.js";
import { EarnlabClient } from "./client/earnlab.js";

const MCP_PORT = Number(process.env.MCP_PORT) || 3002;
const EARNYLD_API_URL = process.env.EARNYLD_API_URL ?? "http://localhost:3001";

const app = express();
app.use(express.json());

// sessionId -> { transport, server }
const sessions = new Map<string, { transport: StreamableHTTPServerTransport; server: Server }>();

app.all("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  const existing = sessionId ? sessions.get(sessionId) : undefined;

  if (existing) {
    await existing.transport.handleRequest(req, res, req.body);
    return;
  }

  // New session — only allowed on initialize (POST without session ID)
  const client = new EarnlabClient({ baseUrl: EARNYLD_API_URL });
  const server = createMcpServer(client);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sid) => {
      sessions.set(sid, { transport, server });
    },
  });

  transport.onclose = async () => {
    if (transport.sessionId) sessions.delete(transport.sessionId);
    try { await server.close(); } catch { /* ignore */ }
  };

  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.listen(MCP_PORT, () => {
  console.log(`[MCP] EarnYld MCP server listening on http://localhost:${MCP_PORT}`);
  console.log(`[MCP] Endpoint: http://localhost:${MCP_PORT}/mcp`);
  console.log(`[MCP] Proxying to EarnYld API at ${EARNYLD_API_URL}`);
  console.log(`[MCP] Register with: claude mcp add --transport http earnyld http://localhost:${MCP_PORT}/mcp`);
});

process.on("SIGINT", async () => {
  for (const { server } of sessions.values()) {
    try { await server.close(); } catch { /* ignore */ }
  }
  process.exit(0);
});
