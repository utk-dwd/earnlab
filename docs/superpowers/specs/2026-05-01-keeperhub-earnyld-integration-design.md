# Design: KeeperHub EarnYld Integration — MCP Server + Workflow Template

**Date:** 2026-05-01
**Branch:** keeperhub-integration
**Approach:** A — Standalone MCP Server + Static Template

---

## 1. Goal

Expose EarnYld's yield-optimization APIs to KeeperHub's AI and workflow engine via:
1. A **standalone MCP server** that translates AI tool calls into EarnYld REST API requests.
2. A **reusable KeeperHub workflow template** that uses the existing Webhook plugin to call EarnYld endpoints on a schedule and deliver results to any notification channel.

---

## 2. Scope

### In scope
- `agents/mcp-server/` — TypeScript MCP server (HTTP/SSE transport)
- MCP tools mapping every EarnYld API endpoint
- Thin HTTP client to EarnYld agent API (port 3001)
- `keeperhub/templates/earnYld-yield-optimizer.json` — static workflow template
- Integration tests and README

### Out of scope
- First-class KeeperHub plugin (we use the existing Webhook plugin)
- KeeperHub repo PR (documentation only for now)
- On-chain execution through KeeperHub (read-only + simulation)

---

## 3. Architecture

### 3.1 MCP Server (`agents/mcp-server/`)

```
agents/mcp-server/
├── src/
│   ├── index.ts              # Entry: reads EARNYLD_API_URL, starts HTTP server
│   ├── server.ts             # McpServer instance, registers tools
│   ├── client/
│   │   └── earnlab.ts        # Fetch wrapper to localhost:3001
│   ├── tools/
│   │   ├── yields.ts         # list_yields, get_pool
│   │   ├── portfolio.ts      # get_portfolio, get_positions
│   │   ├── slippage.ts       # check_slippage
│   │   └── meta.ts           # health_check, get_chains
│   └── types.ts              # Tool input/output shapes
├── package.json
├── tsconfig.json
└── README.md
```

**Transport:** HTTP with Server-Sent Events (SSE) via `@modelcontextprotocol/sdk`.

**Environment:**
| Variable | Default | Description |
|---|---|---|
| `MCP_PORT` | `3002` | Port the MCP server listens on |
| `EARNYLD_API_URL` | `http://localhost:3001` | Base URL of the EarnYld agent API |
| `MCP_LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |

### 3.2 MCP Tools

All tools forward to the EarnYld agent API and return JSON content.

| Tool | Method | EarnYld Endpoint | Description |
|---|---|---|---|
| `list_yields` | GET | `/yields?chainId&network&minAPY&limit` | Ranked opportunities |
| `get_pool` | GET | `/yields/{poolId}` | Single pool detail |
| `get_portfolio` | GET | `/portfolio` | Portfolio summary |
| `get_positions` | GET | `/portfolio/positions` | Open positions |
| `get_trades` | GET | `/portfolio/trades` | Trade log |
| `get_decisions` | GET | `/portfolio/decisions` | LLM decision history |
| `check_slippage` | POST | `/slippage/check` | Simulate swap slippage |
| `get_chains` | GET | `/chains` | Supported chain configs |
| `health_check` | GET | `/health` | Liveness + pool count |

**Error contract:**
```json
{
  "content": [{ "type": "text", "text": "Error: <message>" }],
  "isError": true
}
```

### 3.3 Workflow Template (`keeperhub/templates/`)

```
keeperhub/templates/
├── earnYld-yield-optimizer.json
└── README.md
```

**Template nodes:**
1. **Trigger** — `Schedule` (default every 15 min) or `Manual`
2. **Fetch Yields** — Webhook action: `GET {{earnlabBaseUrl}}/yields?limit={{limit}}&minAPY={{minAPY}}&chainId={{chainId}}`
3. **Has Results?** — Condition: `{{FetchYields.response.data.length}} > 0`
4. **Notify Top Yields** (true) — Webhook action: `POST {{notifyTarget}}` with formatted top-N yields
5. **Notify Empty** (false, optional) — Webhook action: `POST {{notifyTarget}}` with "No yields found"

**Template inputs (matching existing `TemplateInputs`):**
```typescript
interface EarnYldTemplateInputs {
  earnlabBaseUrl: string;      // EarnYld agent API URL
  chainId?: number;            // Filter chain
  network?: "mainnet" | "testnet" | "all";
  minAPY: number;              // Minimum APY threshold
  limit?: number;              // Max results (default 5)
  notifyProvider: "discord" | "telegram" | "webhook";
  notifyTarget: string;        // Webhook URL or channel ID
}
```

---

## 4. Data Flow

### MCP path
```
AI Agent (Claude / Cursor / etc.)
    → MCP client
    → MCP Server (port 3002, SSE)
    → HTTP GET/POST → EarnYld Agent API (port 3001)
    → JSON response
    → MCP tool result → AI Agent
```

### Template path
```
KeeperHub Scheduler (every N min)
    → Webhook Node → GET earnlabBaseUrl/yields
    → Condition Node → true / false
    → Webhook Node → POST notifyTarget
    → Notification delivered
```

---

## 5. Component Details

### 5.1 `client/earnlab.ts`

A thin fetch wrapper:
- Base URL from `EARNYLD_API_URL`
- Timeout: 10 s
- Forward non-2xx as `KeeperhubError` (status + message)
- Return typed JSON

### 5.2 `tools/*.ts`

Each tool file exports a `registerXxxTools(server: McpServer)` function.
Tool definitions use Zod schemas for input validation (if using a Zod-friendly MCP helper) or manual JSON schema for the standard SDK.

Example `list_yields` schema:
```typescript
{
  name: "list_yields",
  description: "Get ranked Uniswap v4 yield opportunities from EarnYld",
  parameters: {
    type: "object",
    properties: {
      chainId: { type: "number", description: "Filter by chain ID" },
      network: { type: "string", enum: ["mainnet", "testnet", "all"] },
      minAPY: { type: "number", description: "Minimum display APY (%)" },
      limit: { type: "number", description: "Max results (1-100)", default: 20 }
    }
  }
}
```

### 5.3 `server.ts`

- Creates `McpServer` with name `earnYld-mcp` and version from `package.json`.
- Registers all tools from `tools/*.ts`.
- Attaches to an HTTP server that handles `/sse` for MCP connections and `/messages` for client posts.

### 5.4 Template JSON

Must conform to KeeperHub workflow schema:
- Nodes array with unique `id`, `type` (`trigger` or `action`), `data.label`, `data.config`.
- Trigger config has `triggerType: "Schedule"` with `cron` or `triggerType: "Manual"`.
- Action config has `actionType: "webhook/send"` with `url`, `method`, `headers`, `body`.
- Edges connect `source` → `target` with optional `sourceHandle` for condition branches (`true` / `false`).

---

## 6. Error Handling

### MCP Server
- **EarnYld API timeout** → `isError: true`, text = "EarnYld API timed out"
- **Non-2xx response** → forward status code and first 200 chars of body
- **Invalid JSON** → "Invalid JSON from EarnYld API"
- **Connection refused** → "EarnYld API unreachable at <url>"

### Workflow Template
- Webhook plugin natively splits into `success` and `error` outputs.
- The error branch is wired to a second notification node (optional) to alert the user when EarnYld is unreachable.

---

## 7. Testing Strategy

### Unit tests (`agents/mcp-server/src/**/*.test.ts`)
- Mock `fetch` for each tool handler.
- Assert correct URL + query params.
- Assert error wrapping for 4xx/5xx/timeout.
- Assert JSON schema compliance of tool definitions.

### Integration tests
- Start EarnYld agent (`npm start` in `agents/`)
- Start MCP server (`npm start` in `agents/mcp-server/`)
- Use an MCP test client to call `list_yields` and verify a real response.

### Template validation
- Validate `earnYld-yield-optimizer.json` against KeeperHub's workflow JSON schema (if available).
- Manual import test via KeeperHub UI or CLI (`kh template deploy`).

---

## 8. Dependencies

### MCP Server runtime
- `@modelcontextprotocol/sdk` (^1.0.0)
- `express` (^4.x) — for HTTP/SSE transport

### Dev
- `typescript` (^5.x)
- `tsx` or `ts-node` — for dev execution
- `vitest` or `jest` — for unit tests

---

## 9. Security Considerations

- The MCP server runs locally and proxies to a local API — no external exposure required in development.
- In production, the MCP server can be deployed behind an HTTPS reverse proxy.
- No secrets are stored in the MCP server; it is stateless.
- The workflow template uses KeeperHub's native secret management for `notifyTarget` URLs (users supply them at deploy time).

---

## 10. Future Extensions (not in this spec)

- **MCP Resources** — expose `earnYld://yields` and `earnYld://portfolio` as live MCP resources.
- **Write tools** — `enter_position`, `exit_position` once EarnYld supports on-chain execution.
- **Plugin** — A first-class KeeperHub plugin with a custom action node instead of raw Webhook.

---

## 11. Acceptance Criteria

- [ ] `npm install` and `npm start` inside `agents/mcp-server/` starts a server on port 3002.
- [ ] MCP client can discover and call all 9 tools successfully against a running EarnYld agent.
- [ ] `list_yields` returns the same JSON shape as `GET /yields`.
- [ ] `check_slippage` accepts the same body as `POST /slippage/check`.
- [ ] Error responses follow the MCP error contract.
- [ ] Workflow template JSON is valid and importable into KeeperHub.
- [ ] Template README explains inputs and how to customize the schedule.

---

*End of spec.*
