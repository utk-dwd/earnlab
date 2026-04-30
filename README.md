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
│                        │ ScenarioStressTester      │      LLMConfig (runtime│
│                        │ DecisionScorecard         │       model switching) │
│                        └──────────────────────────┘                       │
│                                                                            │
│  REST + SSE API  ·  App Wallet signer (viem + APP_WALLET_PRIVATE_KEY) ───►│
└────────────────────────────────────────────────────────────────────────────┘
                              ▼  HTTP
┌────────────────────────────────────────────────────────────────────────────┐
│  frontend/  (Next.js 14, port 3000)                                        │
│                                                                            │
│  YieldTable (22 columns)   PositionsTable    DecisionFeed   Reflections    │
│  RiskBudgetPanel           PendingActionsPanel (HITL approve/reject)       │
│  AppWalletBalances         TransferModal (Send/Receive testnet tokens)     │
│  LLMSelector               WalletButton (RainbowKit)   Swagger /docs       │
│                                                                            │
│  wagmi v2 + RainbowKit v2 — MetaMask / Base Wallet / WalletConnect        │
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

### Enrichment observability
Each pool enrichment stage is isolated. A failure in one stage logs the exact pool and stage, for example:

```
[enrichRAR] pool 0x... failed: Too Many Requests
```

The affected opportunity is marked `enrichmentDegraded=true` and exposes `enrichmentErrors[]` through the API. The dashboard shows a `degraded` badge beside the pair with the failed stage and error message on hover, so null scorecards or missing risk fields are no longer silent.

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
Each tick, a greedy optimiser selects the best allocation across open candidates. It uses real pool-level APY correlation when enough hourly history exists, and falls back to token/chain overlap heuristics only when the correlation estimate is unavailable.

```
marginalReturn = alloc × effectiveNetAPY
marginalRisk   = alloc × (1 − composite/100) × correlationMultiplier
marginalSharpe = marginalReturn / marginalRisk

avgCorr = avg Pearson ρ(candidate APY series, selected pool APY series)
correlationMultiplier = clamp(1 + avgCorr × 0.8, 0.2, 1.8)

fallback avgCorr = tokenOverlap×0.5 + chainDuplicate×0.3
```

The correlation matrix is built from `APYHistoryStore` hourly snapshots using an inner join on shared `hour_key` values. Pool pairs need at least 6 overlapping hourly samples; otherwise the optimiser uses the structural fallback above. This catches correlated pools such as two ETH/stablecoin opportunities on different chains that may have no token/chain overlap penalty but move together in APY during market stress.

The optimiser runs `enrichWithPortfolio()` on each candidate before selection to update portfolio-aware correlation and regime scores. It builds a provisional position set as each allocation is chosen, so later picks account for earlier ones. Output includes `portfolioReturn`, `portfolioRisk`, `portfolioSharpe`, per-pool `marginalSharpe`, and `correlationWithPortfolio`.

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
- Predictive RAR momentum: RAR falls for 3 consecutive ticks with a ≥10% total drop
- Predictive negative momentum: 24h pair price change is negative and worsening by ≥2 percentage points per tick
- Position stale > 30 days with net APY < 5%

### Macro regime detection
Median `pairPriceChange7d` across all ETH-containing pools:

| Median ETH Δ7d | Regime | Effect |
|---|---|---|
| < −5% | `risk-off` | Stable pools prioritised; Kelly × 0.5 |
| −5% to +5% | `neutral` | Normal Kelly sizing |
| > +5% | `risk-on` | Kelly × 1.5 (capped at 30%) |

### Human-in-the-Loop (HITL) mode

When the agent is switched to **Human-in-Loop** mode via the toggle in the dashboard header, every portfolio decision is queued as a **Pending Action** instead of being executed automatically. A panel appears in the dashboard listing each queued decision with full context: the pool, reasoning, entry/exit conditions, and the Critic's verdict.

**Approve / Reject controls**

- **Approve** — executes the action immediately. The agent re-validates the opportunity at the moment of approval; if it has gone stale (TTL exceeded or opportunity no longer in the top list) a 409 is returned and the action reverts to pending with a reason displayed to the user.
- **Reject** — discards the pending action. The agent will re-evaluate the opportunity on the next cycle.

**Rich execution failure feedback**

If a position cannot be opened after approval, the exact reason is surfaced in the UI in a styled code block rather than silently failing. Reasons include detailed calculations:

```
Sepolia gas: 4.50/side → 9.00 round-trip
Kelly fraction: (1.80 − 1) / 1.80 = 0.44 → ¼ Kelly = 0.11
Regime multiplier: 0.5× (risk-off)
Adjusted Kelly: 0.11 × 0.5 = 0.055
Position size: $10000 × 0.055 = $554
Daily fees at 64% APY: $554 × 64% / 365 = $0.97/day
Break-even: 9 ÷ 0.97/day = 9 days → limit is 7 days
```

Other failure reasons (risk budget violations, max positions reached with the held list, token hard-blocks) are similarly expanded with bullet-point detail.

**Staleness detection**

Pending actions carry a TTL. If the opportunity's enrichment data is older than the configured threshold when Approve is clicked, the action is rejected with a 409 and the stale reason is shown — e.g. "Pool data is 4.2 minutes old (limit 3 min)".

### Wallet connection (RainbowKit)

A **Connect Wallet** button in the top-right header opens the RainbowKit modal, supporting MetaMask, Base Wallet, WalletConnect, and any EIP-1193 provider. Once connected:

- The button shows the truncated wallet address as a monospace chip
- It turns green and relabels to **Disconnect Wallet** (hover → red)

The wagmi configuration includes both mainnet and testnet chains:

| Network type | Chains |
|---|---|
| Mainnet | Ethereum, Base, Optimism, Arbitrum, Unichain |
| Testnet | Sepolia, Base Sepolia, OP Sepolia, Arb Sepolia, Unichain Sepolia |

### Transfer Funds panel

A **💸 Transfer** button in the header opens a modal with two tabs:

**Send tab** — App wallet → your connected wallet (no MetaMask required)
- "From" displays the app wallet address (read-only)
- "To" defaults to the connected wallet address (editable)
- Shows the app wallet's live token balance for the selected chain/token
- "Send" button calls `POST /wallet/send` on the backend; the app wallet signs and broadcasts the transaction server-side using `APP_WALLET_PRIVATE_KEY`

**Receive tab** — Your connected wallet → app wallet (MetaMask signs)
- "From" displays your connected wallet address (read-only)
- "To" defaults to the app wallet address (editable)
- Shows your connected wallet's live balance with a MAX button
- "Send" button triggers a native MetaMask/Base Wallet confirmation popup
- Supports ETH and ERC-20 tokens (`transfer(address, uint256)`)

Both tabs support all five testnets and the token registry for each:

| Chain | Tokens |
|---|---|
| Sepolia | ETH, USDC, WETH, LINK, DAI |
| Base Sepolia | ETH, USDC |
| OP Sepolia | ETH, USDC |
| Arb Sepolia | ETH, USDC |
| Unichain Sepolia | ETH |

Switching network in the dropdown triggers `switchChainAsync` — MetaMask prompts to switch. Transaction hashes link to the correct block explorer.

### Application wallet

A dedicated server-side wallet is generated for EarnYld and stored in `.env`:

```env
APP_WALLET_PRIVATE_KEY=0x...   # server-only, never sent to browser
NEXT_PUBLIC_APP_WALLET_ADDRESS=0x...  # public address, safe to expose
```

The private key is used exclusively by the `POST /wallet/send` backend endpoint (via `viem`'s `createWalletClient` + `privateKeyToAccount`). The browser never sees the private key.

### App Wallet Balances widget

A persistent card at the top of the main dashboard column shows the app wallet's live token balances across all five testnets. A chain selector tabs between Sepolia, Base Sep, OP Sep, Arb Sep, and Uni Sep. Each token (ETH, USDC, WETH, LINK, DAI where available) displays its balance via wagmi's `useBalance` hook, updating in real time.

### Runtime LLM model switching

A **🤖 Choose LLM** button in the header opens a model-selection panel. The dropdown lists 18 models across 6 providers, grouped by provider with colour-coded badges:

| Provider | Models available |
|---|---|
| DeepSeek | V3 (default), R1, R1 Distill |
| OpenAI | GPT-4o, GPT-4o Mini, GPT-4 Turbo, o1 Mini |
| Anthropic | Claude 3.5 Sonnet, Claude 3.5 Haiku, Claude 3 Opus |
| Meta | Llama 3.1 405B, Llama 3.1 70B, Llama 3.3 70B |
| Mistral | Mistral Large, Mistral Small |
| Google | Gemini 1.5 Pro, Gemini 1.5 Flash, Gemini 2.0 Flash |

A **"Enter a custom model ID"** toggle accepts any model available at openrouter.ai/models.

Clicking **Apply** calls `POST /settings/llm`. The model change takes effect on the next LLM invocation — no agent restart required. Both the Seeker/Critic (`LLMClient`) and the Reflection Agent call `getModel()` at call time from a shared `LLMConfig` singleton.

The catalogue is hardcoded in the frontend so the dropdown is always populated regardless of whether the agent API is reachable.

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

### SQLite state snapshots
In addition to APY history, execution history, and reflections, the agent persists restart-critical state to SQLite:

- `ranked.latest` — latest ranked opportunity snapshot, saved before and after async enrichment
- `portfolio.state` — cash, positions, trade log, fees paid, last rebalance, regime, last LLM cycle, and decision history

Snapshots are stored in `agents/data/snapshots.db`. On restart, `ReporterAgent` hydrates the latest ranked list before the first scan completes, and `PortfolioManager` resumes the simulated portfolio from the last persisted state transition.

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

The agent starts on **port 3001**. Enrichment is asynchronous — LQ, Eff. APY, T.Risk, Adv.Sel, Stress, and Score columns populate over the first 1–2 minutes per pool. If an enrichment stage fails, the pool is marked degraded and the stage error is logged and exposed in the API. APY Persistence requires 6+ hours of history to accumulate.

### 4. Configure the frontend environment

Next.js reads env vars from `frontend/.env.local` (not the root `.env`). Create it:

```bash
# frontend/.env.local
NEXT_PUBLIC_AGENT_API_URL=http://localhost:3001
NEXT_PUBLIC_APP_WALLET_ADDRESS=0x...          # from APP_WALLET_PRIVATE_KEY derivation
NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID=...      # optional; placeholder works for local dev
```

### 5. Start the frontend

```bash
cd frontend
npm run dev
```

Open **http://localhost:3000**.

---

## Dashboard

Full-viewport layout with a right sidebar for AI reflections and decisions.

**Header bar (left → right)**
- 🌾 EarnYld branding + scan timestamp
- Autonomous / Human-in-Loop mode toggle (with pending-action badge count)
- Refresh button
- API Docs link
- 🤖 Choose LLM — opens model selector panel
- 💸 Transfer — opens Send/Receive testnet token modal
- Connect Wallet / address chip / Disconnect (RainbowKit)

**Main column (top → bottom)**
- **App Wallet Balances** — live token balances for the app wallet across all testnets, chain-switchable
- **Stats bar** — Pools Found, Open Positions, Total Trades, Fees Earned, Unrealised PnL, Last Decision badge
- **Risk Budget panel** — six progress bars (chain, token, volatile, issuer, pool, cash). Red when a constraint is breached
- **Pending Actions panel** (HITL mode only) — queued decisions with Approve / Reject buttons and rich execution failure feedback
- **Yield Opportunities tab** — 22-column table sorted by Effective Net APY. All columns have hover tooltips. Sortable by Eff. APY, RAR, TVL, LQ, Persistence, Stress score, and Scorecard composite
- **Positions tab** — open and closed positions with time-in-range progress bar, exit alerts, grade (A–F), and realised APY

**Right sidebar**
- LLM Decisions feed (Seeker → Critic → Executor per cycle) and hourly Reflections with live SSE streaming

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
| GET | `/settings` | `{ autonomousMode }` |
| POST | `/settings` | Toggle autonomous/HITL mode — body `{ autonomousMode: bool }` |
| GET | `/settings/llm` | `{ model, availableModels }` — current LLM and catalogue |
| POST | `/settings/llm` | Switch active LLM — body `{ model: "openai/gpt-4o" }` — takes effect on next call, no restart needed |
| GET | `/pending-actions` | Queued HITL decisions |
| POST | `/pending-actions/:id/approve` | Execute a pending action. Returns 409 if stale, 422 if execution failed with reason |
| POST | `/pending-actions/:id/reject` | Discard a pending action |
| POST | `/wallet/send` | App wallet signs and broadcasts a testnet transfer. Body: `{ chainId, to, amount, tokenAddress?, decimals? }` |
| GET | `/health` | Liveness check |

### Shared API contract

The frontend re-exports opportunity and enrichment contract types from `agents/src/api/types.ts` instead of redefining `RankedOpportunity` locally. Backend code imports the same `RankedOpportunity` type, so scorecard, enrichment, risk, optimizer, and hook fields fail type-checking in one place instead of drifting silently between `ReporterAgent` and `frontend/src/types/api.ts`.

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
│       │   ├── ReflectionAgent.ts            # Hourly streaming reflection
│       │   └── LLMConfig.ts                  # Mutable model singleton (getModel/setModel)
│       ├── storage/
│       │   ├── ZeroGMemory.ts                # 0G KV episodic memory (RAG)
│       │   ├── ReflectionStore.ts            # SQLite reflection persistence
│       │   ├── ExecutionHistory.ts           # SQLite execution log
│       │   └── SnapshotStore.ts              # SQLite ranked + portfolio snapshots
│       ├── api/
│       │   ├── server.ts                     # Express REST + SSE endpoints
│       │   └── types.ts                      # Shared API contract types
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
        │   ├── ReflectionSidebar.tsx         # SSE-streamed hourly reflections
        │   ├── PendingActionsPanel.tsx       # HITL approve/reject with rich failure detail
        │   ├── WalletButton.tsx              # RainbowKit connect/disconnect button
        │   ├── TransferModal.tsx             # Send/Receive testnet token modal
        │   ├── AppWalletBalances.tsx         # Live app wallet balance widget (all testnets)
        │   └── LLMSelector.tsx              # OpenRouter model picker (18 models, 6 providers)
        ├── lib/
        │   └── wagmiConfig.ts                # wagmi + RainbowKit chain configuration
        └── types/
            └── api.ts                        # Shared TypeScript types
```

---

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `SCAN_INTERVAL_MS` | `60000` | Chain re-scan interval |
| `TOP_N` | `20` | Pools kept in ranked list |
| `ENRICH_CONCURRENCY` | `5` | Max pools enriched concurrently |
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
| `APP_WALLET_PRIVATE_KEY` | — | Private key for the EarnYld app wallet (server-only, never exposed to browser) |
| `NEXT_PUBLIC_APP_WALLET_ADDRESS` | — | Public address of the app wallet — shown in the Transfer modal and balance widget |
| `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` | `earnYld_placeholder` | WalletConnect project ID (get one at cloud.walletconnect.com) |
| `THEGRAPH_API_KEY` | — | Enables The Graph Uniswap v4 subgraph enrichment |

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

## Built with Uniswap ecosystem

EarnYld integrates the Uniswap v4 protocol and SDK stack at every layer of the agent — from pool discovery to position sizing to UI display.

### `@uniswap/v4-sdk` — Hook flag decoding

Every pool returned by the scanner is analysed for active hook callbacks using the SDK's `hookFlagIndex` map.

```typescript
import { hookFlagIndex } from "@uniswap/v4-sdk";

export function decodeHookFlags(hooksAddress: string): string[] {
  const addrNum = BigInt(hooksAddress);
  return Object.entries(hookFlagIndex)
    .filter(([, bit]) => (addrNum >> BigInt(bit)) & 1n)
    .map(([name]) => name);
}
```

In Uniswap v4, the hooks contract address is mined so that its lower 14 bits encode which of the 14 hook points (`beforeSwap`, `afterSwap`, `beforeAddLiquidity`, etc.) are implemented. `decodeHookFlags` reads these bits using the SDK's authoritative bit-position map and returns the list of active callbacks. The frontend displays this per-pool as a 🔵 badge with a tooltip listing all active callbacks.

### `@uniswap/v4-sdk` — Pool key and pool ID

Pool IDs in Uniswap v4 are the keccak256 of the ABI-encoded pool key `(currency0, currency1, fee, tickSpacing, hooks)`. The scanner replicates the on-chain `PoolManager.toId()` logic exactly:

```typescript
export function computePoolId(key: PoolKey): `0x${string}` {
  return keccak256(
    encodeAbiParameters(
      parseAbiParameters("address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks"),
      [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]
    )
  );
}
```

This is used for both onchain pool state reads (via `StateView`) and for joining DefiLlama data to live chain data.

### `@uniswap/v3-sdk` — Tick math for position range sizing

Position tick ranges are computed using the same log-base-1.0001 tick math used by all Uniswap concentrated liquidity pools. The portfolio manager uses `nearestUsableTick` and `TickMath` from the v3 SDK (re-exported as a transitive dependency of `@uniswap/v4-sdk`):

```typescript
import { nearestUsableTick, TickMath } from "@uniswap/v3-sdk";

function computeTickRange(opp: RankedOpportunity) {
  const halfRangePct = (opp.vol7d || 5) * 2;          // ±2σ covers ~95% of 7d moves
  const rawHalfTicks = Math.log(1 + halfRangePct / 100) / Math.log(1.0001);
  const spacing      = TICK_SPACINGS[opp.feeTier] ?? 60;
  // nearestUsableTick validates against tick spacing; ceil ensures conservative range
  const rawCeiled    = Math.ceil(rawHalfTicks / spacing) * spacing;
  const halfTicks    = Math.min(nearestUsableTick(rawCeiled, spacing), TickMath.MAX_TICK);
  return { tickLower: -halfTicks, tickUpper: halfTicks, halfRangePct };
}
```

This ensures every position range is aligned to the pool's tick spacing, within `TickMath.MIN_TICK` / `MAX_TICK` (±887272), and consistent with how Uniswap v4 validates tick bounds on-chain.

### `viem` — On-chain pool state reads

The scanner uses `viem` (the transport library used by Uniswap's own tooling) to:
- Watch `Initialize` events from the v4 `PoolManager` contract to discover new pools
- Watch `Swap` events to compute 24h volume
- Call the v4 `StateView` contract (`getSlot0`, `getLiquidity`) for live price and liquidity

```typescript
const INITIALIZE_EVENT = parseAbiItem(
  "event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)"
);
```

### The Graph — Uniswap v4 subgraph (optional enrichment)

When a `THEGRAPH_API_KEY` is configured, the scanner queries The Graph's Uniswap v4 subgraph for per-pool TVL, volume, and transaction count. This supplements on-chain `StateView` reads with historical aggregated data and serves as a fallback for chains where RPC event scanning is rate-limited.

```typescript
// agents/src/scanner/UniswapV4Scanner.ts
const THEGRAPH_SUBGRAPH: Partial<Record<number, string>> = {
  1:    "GqzP4Xaehti8KSfQmv3ZctFSjnSUYZ4En5NRsiTbvZpz",  // Ethereum mainnet
  8453: "HMuAwufqZ1YCRmzL2NcL8A9F5e5JmFNLFRFiSnMjnFqX",  // Base
};
```

Set `THEGRAPH_API_KEY` in `.env` to enable. The integration degrades gracefully — if the key is absent or the query fails, the agent continues using DefiLlama data.

### uniswap-ai Claude Code skills

The [uniswap-ai](https://github.com/Uniswap/uniswap-ai) repository provides Claude Code skills for Uniswap v4 development. Add them to your Claude Code environment:

```bash
npx skills add Uniswap/uniswap-ai
```

Available skills:
| Skill | Used for |
|---|---|
| `v4-sdk-integration` | Pool construction, tick math, position encoding |
| `liquidity-planner` | Optimal tick range selection from volatility data |
| `v4-hook-generator` | Scaffolding custom hook contracts |
| `swap-planner` | Universal Router calldata encoding |
| `viem-integration` | Type-safe contract reads/writes with viem |
| `swap-integration` | Token approval flow via Permit2 |
| `v4-security-foundations` | Reentrancy, callback trust, hook address validation |
| `configurator` | Pool deployment configuration |

### Chain coverage

EarnYld monitors 14 Uniswap v4 mainnet deployments:

| Chain | Chain ID |
|---|---|
| Ethereum | 1 |
| Unichain | 130 |
| Base | 8453 |
| Arbitrum | 42161 |
| Optimism | 10 |
| Polygon | 137 |
| Blast | 81457 |
| Avalanche | 43114 |
| BSC | 56 |
| Celo | 42220 |
| Zora | 7777777 |
| Worldchain | 480 |
| Ink | 57073 |
| Soneium | 1868 |

---

## Licence

MIT
