import { createMcpServer } from "./server.js";
import { EarnlabClient } from "./client/earnlab.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express from "express";

const MCP_PORT = Number(process.env.MCP_PORT ?? 3002);
const EARNYLD_API_URL = process.env.EARNYLD_API_URL ?? "http://localhost:3001";

const app = express();

const client = new EarnlabClient({ baseUrl: EARNYLD_API_URL });
const server = createMcpServer(client);

// Map sessionId -> transport for SSE
const transports = new Map<string, SSEServerTransport>();

app.get("/sse", async (_req, res) => {
  const transport = new SSEServerTransport("/messages", res);
  transports.set(transport.sessionId, transport);

  res.on("close", () => {
    transports.delete(transport.sessionId);
  });

  await server.connect(transport);
});

app.post("/messages", async (req, res) => {
  const sessionId = req.query.sessionId as string;
  const transport = transports.get(sessionId);
  if (!transport) {
    res.status(400).json({ error: "Invalid or expired sessionId" });
    return;
  }
  await transport.handlePostMessage(req, res);
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
  await server.close();
  process.exit(0);
});
