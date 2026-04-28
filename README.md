# EarnYld

An autonomous Uniswap v4 LP yield optimizer. It scans 18 chains for concentrated liquidity pools, ranks opportunities by risk-adjusted return, and runs a paper-trading portfolio manager that either follows rule-based logic or an LLM Seeker → Critic → Executor pipeline to decide when to enter, hold, and exit positions.

Built for [ETHGlobal](https://ethglobal.com/) — EarnYld v2.

---

## Architecture

```
┌────────────────────────────────────────────────────────────────────────────┐
│  agents/  (Node.js / TypeScript, port 3001)                                │
│                                                                            │
│  UniswapV4Scanner ──► ReporterAgent ──────────────────► PortfolioManager  │
│       │                    │                                   │           │
│  18 chains via viem    Enrichment pipeline               ZeroGMemory       │
│  + DefiLlama prices    ┌──────────────────────────┐      LLMClient         │
│  + Swap event logs     │ VolatilityCalculator      │      ReflectionAgent  │
│                        │ CapitalEfficiencyCalc     │                       │
│                        │ TokenRiskAssessor (GoPlus)│      Risk Budget       │
│                        │ StablecoinRiskAssessor    │      Portfolio Opt.    │
│                        │ AdverseSelectionDetector  │      DecisionScorecard │
│                        │ ScenarioStressTester      │                       │
│                        │ DecisionScorecard         │                       │
│                        └──────────────────────────┘                       │
│                                                                            │
│  REST + SSE API ──────────────────────────────────────────────────────────►│
└────────────────────────────────────────────────────────────────────────────┘
                              ▼  HTTP
┌────────────────────────────────────────────────────────────────────────────┐
│  frontend/  (Next.js 14, port 3000)                                        │
│                                                                            │
│  YieldTable (22 columns)   PositionsTable   DecisionFeed   Reflections     │
│  RiskBudgetPanel           Swagger /docs                                   │
└────────────────────────────────────────────────────────────────────────────┘
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

### Capital efficiency
Every pool is scored on how much of its stated APY is realistically capturable:

**Time-in-Range (TiR):** fraction of the last 7 days (168 hourly prices) where the pair stayed within ±2σ of today's price. Out-of-range positions earn zero fees.

**Fee Capture Efficiency (FCE):** `√(min(liveAPY, refAPY) / max(liveAPY, refAPY))` — measures whether APY is spike-driven (FCE ≈ 0.3) or consistently earned (FCE ≈ 1.0).

**Effective Net APY ★** (default sort): `netAPY × TiR × FCE` — the realistic yield on deployed capital. A 150% APY pool with 40% TiR and 60% FCE shows 36% effective APY.

### Liquidity quality score (0–100)
Geometric mean of four sub-scores:
- **TVL** — pool size vs fee-tier target ($2M for 0.01%, $500K for 0.05%, etc.)
- **Activity** — daily vol/TVL turnover, capped at 1× to prevent spike inflation
- **Stability** — `√(min(liveAPY, refAPY) / max)`, penalises sharp APY divergence
- **Depth** — TVL vs volatility-adjusted requirement (`max($50K, vol7d × $10K)`)

### APY persistence
`min(medianAPY7d / currentAPY, 1.0)` — built from hourly snapshots. A persistence < 50% signals a volume spike, not durable yield. Used as a multiplier in RAR ranking.

### Token risk assessment (GoPlus)
Async per-pool check via the [GoPlus Security API](https://gopluslabs.io/). Hard blocks on:
- Honeypot (cannot sell tokens)
- Owner can modify holder balances
- Stablecoin depegged > 5%

Advisory scoring (+points per flag): unverified source code, upgradeable proxy, hidden owner, selfdestruct, blacklist/pause, ownership reclaim, high buy/sell tax, concentrated holder.

TIER1 tokens (ETH, USDC, USDT, WBTC, DAI, etc.) bypass the API call at score 5.

### Stablecoin risk assessment
Six-dimension composite score for any pool containing a stablecoin:
| Dimension | What it measures |
|---|---|
| pegDeviation | Current \|price − $1\| — > 5% hard-blocks entry |
| poolImbalance | token0/token1 ratio skew (stable/stable pools only) |
| issuerRisk | Protocol + collateral tier (USDC≈5, FRAX≈18, USDB≈25) |
| bridgeRisk | Native=0, CCTP=0, bridged (.e/axl)=15–35 |
| chainRisk | Chain maturity (Ethereum=0, new L2=22) |
| depegVolatility | stdDev(hourly price−$1) over 7d |

### Adverse selection detection
Detects whether LP fees are being earned from informed directional traders — a sign that LPs pay more in IL than they earn in fees. Four sub-signals (each 0–100):
- **Fee vs price move** — fee APY spike aligned with a sharp directional 24h move
- **Volume during moves** — high turnover coinciding with elevated volatility
- **Price drift** — blend of trend strength and lag-1 autocorrelation (> 55% = trending)
- **Vol acceleration** — late-session vol / early-session vol (> 1.5× = building, not dissipating)

Score ≥ 70 = high adverse selection — agent avoids entry.

### Scenario stress testing (30-day horizon)
Eight adversarial scenarios run before any LP entry:

| Scenario | Shock |
|---|---|
| Token −5% | One-time 5% price drop |
| Token −10% | One-time 10% drop |
| Token −20% | Severe stress |
| Vol ×2 | Volatility doubles; IL ×4, TiR falls |
| Volume −50% | Trading volume halves; fee APY halves |
| APY mean-revert | Fee APY reverts to 7-day median |
| Gas ×5 | Entry gas cost spikes 5× |
| Stable −50bps | Stablecoin depegs 50 bps from $1 |

**Downside Score** = `min(100, max(0, −worstCase × 5))` (0 = all profitable, 100 = worst ≥ −20% loss).
**Expected Shortfall** = average of the 3 worst scenario returns (CVaR proxy).

### Explainable decision scorecard
Every ranked opportunity receives an 8-dimension scorecard (0–100 each) with a weighted composite:

| Dimension | Weight | Measures |
|---|---|---|
| Yield | 25% | effectiveNetAPY potential, adverse-selection adjusted |
| IL | 20% | Protection from impermanent loss (`1 − IL/APY`) |
| Liquidity | 15% | liquidityQuality score |
| Volatility | 10% | Time-in-range + price-move penalty |
| Token Risk | 10% | Inverse GoPlus score (0 = BLOCKED, 100 = clean) |
| Gas | 5% | Break-even speed (7-day BE → 0, same-block → 100) |
| Correlation | 10% | Portfolio diversification benefit |
| Regime | 5% | Macro regime fit (risk-off+stable → 90) |

**Kelly allocation** = `min(30%, kellyBase × composite/100)` where `kellyBase = (RAR7d−1)/RAR7d × 25`.

### Portfolio-level risk budget
Six hard constraints enforced before every position entry and rebalance:

| Constraint | Limit |
|---|---|
| Single chain exposure | 40% |
| Single token exposure | 40% |
| Volatile pair exposure | 50% |
| Stablecoin issuer exposure | 60% |
| Single pool exposure | 30% |
| Minimum cash buffer | 10% |

Token equivalents: WETH/cbETH/wstETH/rETH/ezETH/weETH → ETH; WBTC → BTC.
Stablecoin issuers: Circle (USDC/USDbC), Tether (USDT), Sky (DAI/USDS), Frax, Liquity (LUSD/BOLD), Aave (GHO), Curve (crvUSD), PayPal (PYUSD), and others.

### Portfolio optimisation (marginal Sharpe)
Each tick, a greedy optimiser selects the best allocation across open candidates:

```
marginalReturn = alloc × effectiveNetAPY
marginalRisk   = alloc × (1 − composite/100) × correlationMultiplier
marginalSharpe = marginalReturn / marginalRisk

correlationMultiplier = 1 + tokenOverlap×0.5 + chainDuplicate×0.3
```

The optimiser runs `enrichWithPortfolio()` on each candidate before selection to update portfolio-aware correlation and regime scores. It builds a provisional position set as each allocation is chosen, so later picks account for earlier ones. Output includes `portfolioReturn`, `portfolioRisk`, `portfolioSharpe`, and per-pool `marginalSharpe`.

### Portfolio manager
Runs every 5 minutes against $10,000 simulated capital.

**Position sizing — ¼ Kelly**
```
f* = (RAR7d − 1) / RAR7d     (full Kelly)
alloc = f* × 0.25             (¼ Kelly, capped at 30%)
```
Scales with macro regime (see below). Final allocation also bounded by the scorecard composite via the Kelly formula above.

**Tick range — 2σ from vol7d**
```
halfTicks = ceil( ln(1 + vol7d×2/100) / ln(1.0001) / spacing ) × spacing
```

**Exit triggers** (evaluated every tick)
- RAR7d drops to < 50% of entry RAR
- A competing pool is > 50% better RAR7d
- Pair price moved > ±15% in 7d (IL acceleration)
- Time-in-Range falls below 80%
- Position stale > 30 days with net APY < 5%

### Macro regime detection
Median `pairPriceChange7d` across all ETH-containing pools:

| Median ETH Δ7d | Regime | Effect |
|---|---|---|
| < −5% | `risk-off` | Stable pools prioritised; Kelly × 0.5 |
| −5% to +5% | `neutral` | Normal Kelly sizing |
| > +5% | `risk-on` | Kelly × 1.5 (capped at 30%) |

### LLM pipeline — Seeker → Critic → Executor
When `OPENROUTER_API_KEY` is set, every 5-minute cycle runs two sequential LLM calls:

1. **Seeker** — reviews ranked opportunities, portfolio state, token exposure, regime label, risk budget status, portfolio optimisation output, scorecard composites, and past outcomes from 0G memory. Returns structured JSON decisions.
2. **Critic** — receives the Seeker's proposal and argues *against* it: checks IL risk, weak RAR, adverse selection, stress test downside score, scorecard composite threshold, price momentum, TVL red flags, overconcentration, and gas break-even. Returns `{ veto, confidence, reasoning }`.
3. **Executor** — only executes decisions with `confidence ≥ 0.75` that were not vetoed.

Falls back to deterministic rules if no API key is provided.

### 0G decentralised memory
Decision records are written to 0G KV storage (EVM testnet):
```
key:   8-byte big-endian unix timestamp (ms)
value: { pool, pair, conditions: {rar7d, vol7d, change7d}, decision, outcome }
```
`getSimilar()` retrieves the N past outcomes with the closest Euclidean distance in condition-space, giving the Seeker and Critic real experience to reason from. Falls back to in-memory ring buffer (100 entries) if `ZEROG_PRIVATE_KEY` is not set.

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

cd agents && npm install
cd ../frontend && npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Minimum required to run in testnet-only, rule-based mode:

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

The agent starts on **port 3001**. Enrichment is asynchronous — LQ, Eff. APY, T.Risk, Adv.Sel, Stress, and Score columns populate over the first 1–2 minutes per pool. APY Persistence requires 6+ hours of history to accumulate.

### 4. Start the frontend

```bash
cd frontend
npm run dev
```

Open **http://localhost:3000**.

---

## Dashboard

Full-viewport layout with a right sidebar for AI chat:

- **Yield Opportunities tab** — 22-column table sorted by Effective Net APY by default. All columns have hover tooltips explaining their computation. Sortable by Eff. APY, RAR, TVL, LQ, Persistence, Stress score, and Scorecard composite.
- **Positions tab** — open and closed positions with time-in-range progress bar, exit alerts, grade (A–F), and realised APY.
- **Right sidebar** — LLM Decisions feed (Seeker → Critic → Executor per cycle) and hourly Reflections with live SSE streaming.
- **Risk Budget panel** — six progress bars showing current portfolio exposure vs limits. Red when a constraint is breached.

---

## API reference

Interactive Swagger UI at **http://localhost:3000/docs**.

| Method | Endpoint | Description |
|---|---|---|
| GET | `/yields` | Ranked opportunities. Query: `chainId`, `network`, `minAPY`, `limit` |
| GET | `/yields/:poolId` | Single pool detail |
| GET | `/portfolio` | Summary: cash, PnL, regime, token exposure, risk budget, optimisation, last decision |
| GET | `/portfolio/positions` | Simulated open/closed positions with TiR and exit alerts |
| GET | `/portfolio/trades` | Trade log |
| GET | `/portfolio/decisions` | LLM decision cycle history |
| GET | `/reflections` | Hourly reflection history |
| GET | `/reflections/stream` | SSE stream of live reflection tokens |
| GET | `/positions` | Raw on-chain positions |
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
│       ├── index.ts                          # Entry point
│       ├── ReporterAgent.ts                  # Scans chains, enrichment pipeline,
│       │                                     #   ranks opportunities
│       ├── PortfolioManager.ts               # Portfolio simulation, Kelly sizing,
│       │                                     #   risk budget, optimisation, exits
│       ├── scanner/
│       │   └── UniswapV4Scanner.ts           # Reads on-chain pool state via viem
│       ├── calculator/
│       │   ├── APYCalculator.ts              # Fee APY + IL formulas
│       │   ├── VolatilityCalculator.ts       # Hourly log-return σ, RAR
│       │   ├── CapitalEfficiencyCalculator.ts# TiR, FCE, effectiveNetAPY
│       │   ├── SlippageGuard.ts              # Simulated swap slippage check
│       │   ├── TokenRiskAssessor.ts          # GoPlus honeypot / ownership checks
│       │   ├── StablecoinRiskAssessor.ts     # Peg, issuer, bridge, chain risk
│       │   ├── AdverseSelectionDetector.ts   # Toxic flow detection (4 signals)
│       │   ├── ScenarioStressTester.ts       # 8-scenario 30d stress test
│       │   ├── DecisionScorecard.ts          # 8-dimension weighted scorecard
│       │   ├── PortfolioOptimizer.ts         # Marginal-Sharpe greedy allocator
│       │   └── RiskBudget.ts                 # Portfolio-level constraint checks
│       ├── llm/
│       │   ├── LLMClient.ts                  # Seeker + Critic LLM calls (OpenRouter)
│       │   └── ReflectionAgent.ts            # Hourly streaming reflection
│       ├── storage/
│       │   ├── ZeroGMemory.ts                # 0G KV episodic memory (RAG)
│       │   ├── ReflectionStore.ts            # SQLite reflection persistence
│       │   └── ExecutionHistory.ts           # SQLite execution log
│       ├── api/
│       │   └── server.ts                     # Express REST + SSE endpoints
│       └── config/
│           └── chains.ts                     # Chain configs, tick spacings,
│                                             #   gas estimates, known tokens
└── frontend/
    └── src/
        ├── pages/
        │   ├── index.tsx                     # Main dashboard
        │   └── docs.tsx                      # Swagger UI
        ├── components/
        │   ├── YieldTable.tsx                # 22-column ranked pool table
        │   ├── PositionsTable.tsx            # Positions with TiR, exit alerts
        │   ├── DecisionFeed.tsx              # LLM decisions + Critic verdict
        │   └── ReflectionSidebar.tsx         # SSE-streamed hourly reflections
        └── types/
            └── api.ts                        # Shared TypeScript types
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

PORTFOLIO: cash=$8420 invested=$1580 positions=1 unrealizedPnL=+$3.22 fees=+$1.10
TOKEN EXPOSURE (40% limit): ETH=7.9%

RISK BUDGET: chain ✓10% token ✓8% volatile ✓8% issuer ✓0% pool ✓8% cash ✓84%

PORTFOLIO OPTIMISATION: sharpe=4.21 ret=12.3% risk=2.9% cash=15.0%
  #1 USDC/ETH   Base  0.30%  effAPY=41.2%  mSharpe=14.2  alloc=15.0%
  #2 AAVE/USDC  Eth   0.30%  effAPY=31.8%  mSharpe=9.1   alloc=12.0%

OPPORTUNITIES (ranked):
  <poolId> | USDC/ETH | Base | feeAPY=142% | effAPY=41% | score=78/100[Y|IL|LQ|V|TR|G|C|R] alloc=15%

OPEN POSITIONS:
  <poolId> | WETH/USDC | Unichain | invested=$1580 | entryAPY=87% | held=2.3h | PnL=+$0.41

PAST OUTCOMES — similar conditions (0G memory):
  [Apr 15] enter USDC/ETH on Base | rar=7.2 vol=38% → 3.1d | APY=134% ret=+$52 ✓
```

---

## Licence

MIT
