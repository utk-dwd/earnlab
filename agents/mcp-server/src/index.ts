import { createMcpServer } from "./server.js";
import { EarnlabClient } from "./client/earnlab.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express from "express";

const MCP_PORT = Number(process.env.MCP_PORT) || 3002;
const EARNYLD_API_URL = process.env.EARNYLD_API_URL ?? "http://localhost:3001";

const app = express();

// Map sessionId -> { transport, server } so each SSE connection gets its own Server instance
const sessions = new Map<string, { transport: SSEServerTransport; server: Server }>();

app.get("/sse", async (_req, res) => {
  const client = new EarnlabClient({ baseUrl: EARNYLD_API_URL });
  const server = createMcpServer(client);
  const transport = new SSEServerTransport("/messages", res);

  sessions.set(transport.sessionId, { transport, server });

  res.on("close", async () => {
    sessions.delete(transport.sessionId);
    try {
      await server.close();
    } catch {
      // ignore close errors
    }
  });

  await server.connect(transport);
});

app.post("/messages", async (req, res) => {
  const sessionId = req.query.sessionId as string;
  if (!sessionId || sessionId.length > 128 || !/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
    res.status(400).json({ error: "Invalid sessionId format" });
    return;
  }
  const session = sessions.get(sessionId);
  if (!session) {
    res.status(400).json({ error: "Invalid or expired sessionId" });
    return;
  }
  await session.transport.handlePostMessage(req, res);
});

app.listen(MCP_PORT, () => {
  console.log(`[MCP] EarnYld MCP server listening on http://localhost:${MCP_PORT}`);
  console.log(`[MCP] SSE endpoint: http://localhost:${MCP_PORT}/sse`);
  console.log(`[MCP] Messages endpoint: http://localhost:${MCP_PORT}/messages?sessionId=<id>`);
  console.log(`[MCP] Proxying to EarnYld API at ${EARNYLD_API_URL}`);
});

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("\n[MCP] Shutting down...");
  for (const { server } of sessions.values()) {
    try {
      await server.close();
    } catch {
      // ignore
    }
  }
  process.exit(0);
});
