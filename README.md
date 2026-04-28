# EarnYld

An autonomous Uniswap v4 LP yield optimizer. It scans 18 chains for concentrated liquidity pools, ranks opportunities by risk-adjusted return, and runs a paper-trading portfolio manager that either follows rule-based logic or an LLM Seeker → Critic → Executor pipeline to decide when to enter, hold, and exit positions.

Built for [ETHGlobal](https://ethglobal.com/) — EarnYld v2.

---

## Architecture

```
┌────────────────────────────────────────────────────────────────────────┐
│  agents/  (Node.js / TypeScript, port 3001)                            │
│                                                                        │
│  UniswapV4Scanner ──► ReporterAgent ──► PortfolioManager              │
│       │                    │                   │                       │
│  18 chains via viem    RankedOpportunity    ZeroGMemory (0G KV)        │
│  + DefiLlama prices    APY / RAR / IL       episodic outcomes          │
│  + Swap event logs     VolatilityCalc       LLMClient (OpenRouter)     │
│                        SlippageGuard        ReflectionAgent (hourly)   │
│                                                                        │
│  REST + SSE API ──────────────────────────────────────────────────────►│
└────────────────────────────────────────────────────────────────────────┘
                              ▼  HTTP
┌────────────────────────────────────────────────────────────────────────┐
│  frontend/  (Next.js 14, port 3000)                                    │
│                                                                        │
│  YieldTable   PositionsTable   DecisionFeed   ReflectionSidebar        │
│  Swagger /docs                                                         │
└────────────────────────────────────────────────────────────────────────┘
```

---

## Features

### Pool discovery and ranking
- Scans all Uniswap v4 `Initialize` events across 14 mainnet + 4 testnet chains
- Enriches each pool with live price, TVL, and 24h volume from DefiLlama
- Computes fee APY: `(volume24h × feeTier / tvl) × 365`
- Computes annualised volatility from 24h and 7d hourly log-returns
- Computes **Risk-Adjusted Return (RAR)**: `feeAPY / annualisedVol` (Sharpe with rf=0)
- Estimates **Impermanent Loss** and **Net APY** (`feeAPY − expectedIL`)
- Slippage guard: rejects pools where a simulated swap exceeds configured basis points

### Portfolio manager
Runs every 5 minutes against $10,000 simulated capital.

**Position sizing — ¼ Kelly**
```
f* = (RAR7d − 1) / RAR7d     (full Kelly)
alloc = f* × 0.25             (¼ Kelly, capped at 30%)
```
Scales with macro regime (see below).

**Tick range — 2σ from vol7d**
Entry computes a ±2σ concentrated range snapped to the pool's tick spacing:
```
halfTicks = ceil( ln(1 + vol7d×2/100) / ln(1.0001) / spacing ) × spacing
```
Time-in-Range (TiR) scales fee accrual: positions outside their range earn zero.

**Correlation guard**
Max 40% of total capital in any single underlying token. WETH / cbETH / wstETH / rETH / ezETH / weETH all count as ETH exposure; WBTC counts as BTC.

**Gas break-even guard**
```
breakEvenDays = (gasCostUsd × 2) / (positionUsd × APY/100/365)
```
Positions are skipped if break-even exceeds 7 days. Gas costs are chain-specific (Ethereum ≈ $25, L2s ≈ $0.05–$0.30).

**Exit triggers** (evaluated every tick)
- RAR7d drops to < 50% of entry RAR
- A competing pool is > 50% better RAR7d
- Pair price moved > ±15% in 7d (IL acceleration)
- Time-in-Range falls below 80%
- Position stale > 30 days with net APY < 5%

### Macro regime detection
Each tick computes the median `pairPriceChange7d` across all ETH-containing pools:

| Median ETH Δ7d | Regime | Effect |
|---|---|---|
| < −5% | `risk-off` | Stable pools prioritised; Kelly × 0.5 |
| −5% to +5% | `neutral` | Normal Kelly sizing |
| > +5% | `risk-on` | Kelly × 1.5 (capped at 30%) |

### LLM pipeline — Seeker → Critic → Executor
When `OPENROUTER_API_KEY` is set, every 5-minute cycle runs two sequential LLM calls:

1. **Seeker** (DeepSeek V3 by default) — reviews ranked opportunities, portfolio state, token exposure, regime label, past outcomes from 0G memory, and returns structured JSON decisions
2. **Critic** — receives the Seeker's proposal and argues *against* it: checks IL risk, weak RAR, price momentum, TVL red flags, overconcentration, and gas break-even. Returns `{ veto, confidence, reasoning }`
3. **Executor** — only executes decisions with `confidence ≥ 0.75` that were not vetoed

Falls back to deterministic rules if no API key is provided.

### 0G decentralised memory
Decision records are written to 0G KV storage (EVM testnet):
```
key:   8-byte big-endian unix timestamp (ms)
value: { pool, pair, conditions: {rar7d, vol7d, change7d}, decision, outcome }
```
On each LLM call, `getSimilar()` retrieves the N past outcomes with the closest Euclidean distance in condition-space, giving the Seeker and Critic real experience to reason from.

Falls back to in-memory ring buffer (100 entries) if `ZEROG_PRIVATE_KEY` is not set.

### Reflection agent
Runs hourly. Streams a 1–5 sentence LLM reflection on current opportunities and portfolio performance via Server-Sent Events. Each reflection is persisted in SQLite and surfaced in the UI sidebar. Past reflections are passed as context for future reflections.

---

## Supported chains

| Chain | ID | Network |
|---|---|---|
| Ethereum | 1 | mainnet |
| Unichain | 130 | mainnet |
| Optimism | 10 | mainnet |
| Base | 8453 | mainnet |
| Arbitrum One | 42161 | mainnet |
| Polygon | 137 | mainnet |
| Blast | 81457 | mainnet |
| Avalanche | 43114 | mainnet |
| BNB Chain | 56 | mainnet |
| Celo | 42220 | mainnet |
| Zora | 7777777 | mainnet |
| Worldchain | 480 | mainnet |
| Ink | 57073 | mainnet |
| Soneium | 1868 | mainnet |
| Sepolia | 11155111 | testnet |
| Base Sepolia | 84532 | testnet |
| Arbitrum Sepolia | 421614 | testnet |
| Unichain Sepolia | 1301 | testnet |

---

## Getting started

### Prerequisites
- Node.js 18+
- `ts-node` (installed as a dev dependency)

### 1. Clone and install

```bash
git clone https://github.com/utk-dwd/earnlab.git
cd earnlab
git checkout earnYld

# Install agent dependencies
cd agents && npm install

# Install frontend dependencies
cd ../frontend && npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env`. The minimum required to run in testnet-only, rule-based mode:

```env
# Optional but recommended — paid RPC endpoints reduce rate-limit failures
ETH_RPC_URL=https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY

# Enable LLM-driven decisions (falls back to rules if absent)
OPENROUTER_API_KEY=sk-or-v1-...

# Enable 0G persistent memory (falls back to in-memory if absent)
ZEROG_PRIVATE_KEY=0x...
```

To restrict to a single network:
```env
NETWORK_FILTER=mainnet   # or "testnet"
```

### 3. Start the agent

```bash
cd agents
npm start               # all networks
npm run start:mainnet   # mainnet only
npm run start:testnet   # testnet only
npm run dev             # hot-reload for development
```

The agent starts on **port 3001** and logs scan progress, portfolio decisions, and regime changes.

### 4. Start the frontend

```bash
cd frontend
npm run dev
```

Open **http://localhost:3000**.

---

## API reference

The agent exposes a REST + SSE API on port 3001. An interactive Swagger UI is available at **http://localhost:3000/docs**.

| Method | Endpoint | Description |
|---|---|---|
| GET | `/yields` | Ranked opportunities. Query: `chainId`, `network`, `minAPY`, `limit` |
| GET | `/yields/:poolId` | Single pool detail |
| GET | `/portfolio` | Portfolio summary: cash, PnL, regime, token exposure, last decision |
| GET | `/portfolio/positions` | Simulated open/closed positions with TiR and exit alerts |
| GET | `/portfolio/trades` | Trade log (open + close events) |
| GET | `/portfolio/decisions` | LLM decision cycle history |
| GET | `/reflections` | Hourly reflection history (SQLite) |
| GET | `/reflections/stream` | SSE stream of live reflection tokens |
| GET | `/positions` | Raw on-chain positions (from ReporterAgent) |
| GET | `/executions` | Execution history |
| GET | `/stats` | Agent-level counters |
| GET | `/chains` | Active chain configs |
| POST | `/slippage/check` | Simulate a swap and return slippage estimate |
| GET | `/health` | Liveness check |

---

## Project structure

```
earnYld/
├── agents/
│   └── src/
│       ├── index.ts                  # Entry point — wires agents together
│       ├── ReporterAgent.ts          # Scans chains, ranks opportunities
│       ├── PortfolioManager.ts       # Portfolio simulation, Kelly sizing,
│       │                             #   regime detection, correlation guard,
│       │                             #   gas break-even, exit triggers
│       ├── scanner/
│       │   └── UniswapV4Scanner.ts   # Reads on-chain pool state via viem
│       ├── calculator/
│       │   ├── APYCalculator.ts      # Fee APY + IL formulas
│       │   ├── VolatilityCalculator.ts  # Hourly log-return σ, RAR
│       │   └── SlippageGuard.ts      # Simulated swap slippage check
│       ├── llm/
│       │   ├── LLMClient.ts          # Seeker + Critic LLM calls (OpenRouter)
│       │   └── ReflectionAgent.ts    # Hourly streaming reflection
│       ├── storage/
│       │   ├── ZeroGMemory.ts        # 0G KV episodic memory (RAG)
│       │   ├── ReflectionStore.ts    # SQLite reflection persistence
│       │   └── ExecutionHistory.ts   # SQLite execution log
│       ├── api/
│       │   └── server.ts             # Express REST + SSE endpoints
│       └── config/
│           └── chains.ts             # Chain configs, tick spacings,
│                                     #   gas cost estimates, known tokens
└── frontend/
    └── src/
        ├── pages/
        │   ├── index.tsx             # Main dashboard
        │   └── docs.tsx              # Swagger UI
        ├── components/
        │   ├── YieldTable.tsx        # Ranked pool table with APY/RAR/IL
        │   ├── PositionsTable.tsx    # Positions with TiR bar, exit alerts
        │   ├── DecisionFeed.tsx      # LLM decision stream with Critic verdict
        │   └── ReflectionSidebar.tsx # SSE-streamed hourly reflections
        └── types/
            └── api.ts                # Shared TypeScript types (mirrors OpenAPI)
```

---

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `SCAN_INTERVAL_MS` | `60000` | Chain re-scan interval |
| `TOP_N` | `20` | Pools kept in ranked list |
| `AGENT_API_PORT` | `3001` | REST API port |
| `NETWORK_FILTER` | `all` | `all` / `mainnet` / `testnet` |
| `OPENROUTER_API_KEY` | — | Enables LLM decisions; falls back to rules if absent |
| `LLM_MODEL` | `deepseek/deepseek-chat-v3-0324` | Any OpenRouter model ID |
| `REFLECT_INTERVAL_MS` | `3600000` | Reflection cadence (1h default) |
| `ZEROG_PRIVATE_KEY` | — | Enables 0G persistent memory |
| `ZEROG_RPC_URL` | `https://evmrpc-testnet.0g.ai` | 0G EVM RPC |
| `ZEROG_INDEXER_URL` | `https://indexer-storage-testnet-turbo.0g.ai` | 0G storage indexer |
| `ZEROG_KV_URL` | `http://3.101.147.150:6789` | 0G KV endpoint |
| `ZEROG_STREAM_ID` | (hardcoded default) | 0G KV stream for decision records |
| `MAX_SLIPPAGE_BPS` | `50` | Slippage guard threshold (0.5%) |
| `NEXT_PUBLIC_AGENT_API_URL` | `http://localhost:3001` | Frontend → agent URL |

---

## How the LLM context is built

Each Seeker call receives:

```
MACRO REGIME: RISK-OFF 🔴 (median ETH Δ7d < -5%) — prefer stable pools, sizing halved
PORTFOLIO: cash=$8420 invested=$1580 positions=1/4 unrealizedPnL=+$3.22 ...
TOKEN EXPOSURE (40% limit): ETH=7.9%

OPPORTUNITIES (ranked RAR-7d > APY):
  <poolId> | USDC/ETH | Base | feeAPY=142.3% | netAPY=98.1% | IL=44.2% | RAR7d=8.41 | TVL=$2.1M | Δ7d=+2.1% | be=0.1d
  ...

OPEN POSITIONS:
  <poolId> | WETH/USDC | Unichain | invested=$1580 | entryAPY=87.2% | held=2.3h | PnL=+$0.41 range=±14.2% TiR=94%

PAST OUTCOMES — similar market conditions (0G memory):
  [Apr 15] enter USDC/ETH on Base | rar=7.2 vol=38% Δ=+1.8% → 3.1d | APY=134% ret=+$52.10 ✓
```

The Critic receives the same pool data plus a per-token correlation impact table and the gas break-even figure.

---

## Licence

MIT
