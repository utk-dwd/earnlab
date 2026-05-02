# EarnYld MCP Server

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server that exposes EarnYld's yield-optimization APIs as AI-discoverable tools.

## Features

- **9 MCP tools** covering yields, portfolio, positions, trades, decisions, slippage checks, chains, and health
- **Streamable HTTP transport** (`POST /mcp`) — compatible with Claude Code, Cursor, and any MCP 2025-03-26 client
- **Thin proxy** to the EarnYld agent API (port 3001 by default)
- **Zero state** — no secrets stored, no database

## Security Warning

**The MCP server runs without authentication by default.** The `/mcp` endpoint is open to anyone who can reach the server. This is acceptable for local development but **must not be exposed to the public internet without an authentication layer** (e.g., reverse proxy with API key validation, VPN, or cloud IAP).

Never expose the MCP server directly to untrusted networks — any client that can connect can invoke all EarnYld tools including `check_slippage` and read portfolio data.

## Quick start

### 1. Install dependencies

```bash
cd agents/mcp-server
npm install
```

### 2. Start the EarnYld agent

In a separate terminal:
```bash
cd agents
npm start
```

### 3. Start the MCP server

```bash
cd agents/mcp-server
npm start
```

The server starts on **port 3002** by default.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `MCP_PORT` | `3002` | Port the MCP server listens on |
| `EARNYLD_API_URL` | `http://localhost:3001` | Base URL of the EarnYld agent API |

## Connect from Claude Code

```bash
claude mcp add --transport http earnyld http://localhost:3002/mcp
```

Then run `/mcp` inside Claude Code and select the **earnyld** server.

## Tools reference

| Tool | Description |
|---|---|
| `list_yields` | Get ranked yield opportunities |
| `get_pool` | Get single pool detail by pool ID |
| `get_portfolio` | Get simulated portfolio summary |
| `get_positions` | Get open simulated positions |
| `get_trades` | Get trade log |
| `get_decisions` | Get LLM decision history |
| `check_slippage` | Simulate swap and check slippage |
| `get_chains` | List supported chain configs |
| `health_check` | Check agent health |

## Development

```bash
npm run dev     # hot reload with tsx watch
npm run build   # compile to dist/
npm test        # run vitest suite
```

## Architecture

```
AI Agent (Claude)
    → MCP client
    → MCP Server (port 3002, Streamable HTTP POST /mcp)
    → HTTP GET/POST → EarnYld Agent API (port 3001)
    → JSON response → MCP tool result → AI Agent
```

## License

MIT
