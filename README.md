# EarnYld

An autonomous Uniswap v4 LP yield optimizer. It scans 18 chains for concentrated liquidity pools, ranks opportunities by risk-adjusted return, and runs a paper-trading portfolio manager that either follows rule-based logic or an LLM Seeker → Critic → Executor pipeline to decide when to enter, hold, and exit positions.

Portfolio strategies can be minted as ownable **INFT strategy agents** (ERC-7857-style) on 0G Galileo testnet — capturing risk profile, scorecard weights, performance history, and LLM config in a transferable on-chain record with metadata stored on 0G Storage.

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
│                        │ HookAnalyzer (Sourcify)   │       model switching) │
│                        │ DecisionScorecard (9-dim) │                       │
│                        └──────────────────────────┘                       │
│                                                                            │
│  REST + SSE API  ·  App Wallet signer (viem + APP_WALLET_PRIVATE_KEY)     │
│                                                                            │
│  INFT module (agents/src/inft/)                                            │
│  ├── INFTContractClient  — viem wrapper for EarnYldAgentINFT.sol           │
│  ├── AgentMetadataBuilder — builds strategy state bundles                  │
│  ├── AgentAccessControl  — gates execution by INFT ownership               │
│  └── ZeroGStorageClient  — uploads/retrieves bundles on 0G Storage        │
│                                                                            │
│  EarnYldAgentINFT.sol → 0G Galileo testnet (chain 16602)                  │
└────────────────────────────────────────────────────────────────────────────┘
                              ▼  HTTP
┌────────────────────────────────────────────────────────────────────────────┐
│  frontend/  (Next.js 14, port 3000)                                        │
│                                                                            │
│  YieldTable (22 columns)   PositionsTable    DecisionFeed   Reflections    │
│  RiskBudgetPanel           PendingActionsPanel (HITL approve/reject)       │
│  AppWalletBalances         TransferModal (Send/Receive testnet tokens)     │
│  SwapModal (Uniswap V3 + 0G JAINE DEX)        LLMSelector                 │
│  AgentINFTPanel (mint / clone / authorize / transfer INFTs)                │
│  WalletButton (RainbowKit)                    Swagger /docs                │
│                                                                            │
│  wagmi v2 + RainbowKit v2 — MetaMask / Base Wallet / WalletConnect        │
└────────────────────────────────────────────────────────────────────────────┘
                     ▼  SSE/HTTP  (optional AI agent layer)
┌────────────────────────────────────────────────────────────────────────────┐
│  agents/mcp-server/  (MCP server, port 3002)                               │
│                                                                            │
│  9 MCP tools: list_yields · get_pool · get_portfolio · get_positions      │
│               get_trades · get_decisions · check_slippage                  │
│               get_chains · health_check                                    │
│                                                                            │
│  Connect: claude mcp add --transport http earnyld http://localhost:3002/sse│
│  Clients: Claude Code · Cursor · any MCP-compatible AI agent               │
└────────────────────────────────────────────────────────────────────────────┘
                     ▼  HTTP  (optional execution layer)
┌────────────────────────────────────────────────────────────────────────────┐
│  KeeperHub  (external — keeperhub.xyz)                                     │
│                                                                            │
│  GET /keeper/positions ──► position health snapshots                       │
│  POST /keeper/signal   ──► full scoring signal + conditions block          │
│                                                                            │
│  KeeperHub workflow: schedule trigger → score signal → condition branch    │
│    → execute tx (remove liquidity / rebalance / approve entry)             │
│    → retry / gas estimation / nonce management / alert / run log           │
│                                                                            │
│  keeperhub-workflow.yaml — three importable workflows:                     │
│    1. Monitor and Rebalance (every 15 min)                                 │
│    2. Discover Entry Opportunities (every 1 hr)                            │
│    3. Hook Risk Change Alert (webhook trigger)                             │
│                                                                            │
│  keeperhub/templates/earnYld-yield-optimizer.json — importable template:  │
│    Scheduled fetch → threshold check → webhook/Discord/Telegram notify     │
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

### Uniswap v4 Hook Analyzer

Uniswap v4 allows pools to attach arbitrary **hook contracts** — logic that runs before or after swaps, liquidity changes, and donations. Hooks can improve LP economics (autocompound fees, dynamic spreads, MEV protection) or destroy them (lock capital, manipulate fees, impose hidden costs). The Hook Analyzer classifies every hooked pool across three axes and folds the result into the scorecard.

#### How hooks work in v4

Each pool specifies a `hooks` address in its key. In v4, this address is **mined**: the lower 14 bits encode which callbacks the hook contract implements. Bit 0 = `beforeInitialize`, bit 1 = `afterInitialize`, bit 12 = `beforeSwap`, bit 13 = `afterSwap`, and so on. A zero address means no hook — a vanilla concentrated LP.

```
Pool key: (currency0, currency1, fee, tickSpacing, hooks)
                                                    ^
                                         lower 14 bits = active callbacks
```

`decodeHookFlags(hookAddress)` reads these bits via `@uniswap/v4-sdk`'s `hookFlagIndex` and returns the list of active callback names. This runs for every pool on every scan.

#### Fee type classification

| Fee type | Condition | Effect on LP |
|---|---|---|
| `static` | No `beforeSwap` callback | Fee tier is fixed. APY prediction is reliable. |
| `dynamic-unknown` | `beforeSwap` present | Hook can widen or narrow the spread on every swap. Actual fee income may differ substantially from the stated tier. APY haircut applied. |

#### Incentive model classification

| Incentive type | Condition | Effect on LP |
|---|---|---|
| `real-fees` | No `afterSwap` / `afterAddLiquidity` | Fees go directly to LPs as pool tokens. Safest. APY haircut ×1.00. |
| `hook-native-rewards` | `afterSwap` or `afterAddLiquidity` present | Hook intercepts some or all fees and redistributes as hook-specific rewards. Rewards may be illiquid, time-locked, or subject to hook governance. APY haircut ×0.60. |
| `points-airdrop` | Manually labelled (future) | Rewards are offchain points with uncertain redemption. APY haircut ×0.10. |

#### Rebalance type classification

| Rebalance type | Condition | LP benefit |
|---|---|---|
| `none` | No relevant callbacks | Vanilla LP. Range management is manual. |
| `auto-compound` | `afterAddLiquidity` only | Hook reinvests accrued fees back into the position automatically. Improves effective APY for idle capital. |
| `range-rebalance` | `beforeAddLiquidity` + `afterAddLiquidity` | Hook repositions the LP range based on price movement. Increases time-in-range at the cost of additional gas and potential slippage on rebalance. |

#### Smart-contract risk score (0–100)

Risk is accumulated based on callback surface, source code availability, TVL, and pool age:

| Signal | Points | Why it matters |
|---|---|---|
| `beforeRemoveLiquidity` in callbacks | +30 | Hook can block or delay LP withdrawals — the most dangerous callback for capital lockup |
| `beforeAddLiquidity` in callbacks | +15 | Hook can revert liquidity additions, effectively restricting pool access |
| `beforeSwap` in callbacks | +10 | Dynamic fee control — hook can charge any spread on any swap |
| 6+ total callbacks | +15 | Larger attack surface; more logic paths that could interact adversarially |
| Source code not on Sourcify | +25 | No human-readable verification of what the hook actually does |
| TVL > $500K and source unverified | +10 | Unverified high-value hook is a higher-priority concern |
| Pool age < 7 days | +15 | No track record — insufficient time to detect anomalous behaviour |

**Risk levels and scorecard impact:**

| Level | Score range | `netAPYMultiplier` | Dashboard badge |
|---|---|---|---|
| Low | < 25 | ×1.10 | ✓ green — hook likely improves LP economics |
| Medium | 25–49 | ×0.95 | ⚠ yellow — some risk, minor discount applied |
| High | 50–84 | ×0.85 | ⚡ orange — significant surface area, notable discount |
| Critical | ≥ 85 | ×0.70 + blocked | 🚫 red — agent will not enter; blocked from ranking |

A low-risk hook with auto-compound or range-rebalance actually **boosts effective APY** above the naive fee APY via the ×1.10 multiplier — rewarding good hook design.

#### Source verification (Sourcify)

The analyzer calls the [Sourcify](https://sourcify.dev) public API to check whether the hook contract's source code is verified (`perfect` or `partial` match). Results are cached for 24 hours per address/chain pair to avoid repeated network calls. An unverified contract adds +25 risk points — for a $500K+ TVL pool this rises to +35.

#### Integration with the scorecard

`hookAnalysis` feeds into `computeScorecard` in two ways:

1. **Yield dimension** — effective APY is multiplied by `netAPYMultiplier × incentiveHaircut` before scoring. A `hook-native-rewards` pool with `riskLevel=medium` has its APY scaled to `0.95 × 0.60 = 0.57` of face value before the yield score is computed.

2. **Hook Risk dimension (9th)** — `hookRiskScore = 100 − riskScore`. Vanilla pools score 100. This feeds into the weighted composite with 8–12% weight depending on regime:

| Regime | Hook Risk weight | Rationale |
|---|---|---|
| `risk-off` | 8% | Capital preservation dominates; IL and token risk are already elevated |
| `neutral` | 12% | Highest weight — maximum attention to hook smart-contract risk in normal conditions |
| `risk-on` | 10% | Yield focus, but hooks still matter for capital safety |

### Explainable decision scorecard
Every ranked opportunity receives a **9-dimension scorecard** (0–100 each) with a regime-conditional weighted composite:

| Dimension | Neutral weight | Risk-off weight | Risk-on weight | Measures |
|---|---|---|---|---|
| Yield | 22% | 9% | 32% | effectiveNetAPY × hook multiplier × incentive haircut, adverse-selection adjusted |
| IL | 18% | 28% | 9% | Protection from impermanent loss (`1 − IL/APY`) |
| Liquidity | 13% | 14% | 13% | liquidityQuality score |
| Volatility | 9% | 14% | 7% | Time-in-range + price-move penalty |
| Token Risk | 9% | 14% | 7% | Inverse GoPlus score (0 = BLOCKED, 100 = clean) |
| Gas | 4% | 4% | 4% | Break-even speed (7-day BE → 0, same-block → 100) |
| Correlation | 9% | 6% | 11% | Portfolio diversification benefit |
| Regime | 4% | 3% | 7% | Macro regime fit (risk-off+stable → 90) |
| **Hook Risk** | **12%** | **8%** | **10%** | **100 − hook riskScore (100 for vanilla pools)** |

All weight sets sum to 1.00. The regime is detected from median ETH Δ7d across all ETH pools.

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

### Token Swap panel

A **🔄 Swap** button in the header opens a modal for swapping tokens held in the app wallet — letting the portfolio manager acquire the exact tokens a top yield pool requires before entering.

**Supported networks and DEXes:**

| Chain | Chain ID | DEX | Router |
|---|---|---|---|
| Sepolia | 11155111 | Uniswap V3 | SwapRouter02 |
| Base Sepolia | 84532 | Uniswap V3 | SwapRouter02 |
| OP Sepolia | 11155420 | Uniswap V3 | SwapRouter02 |
| Arb Sepolia | 421614 | Uniswap V3 | SwapRouter02 |
| Unichain Sepolia | 1301 | Uniswap V3 | SwapRouter02 |
| 0G Network | 16661 | JAINE DEX (Uniswap V3 fork) | JAINE Router |

**How a swap executes** (all steps are server-side, signed by `APP_WALLET_PRIVATE_KEY`):

1. **Quote** — `POST /swap/quote` calls `QuoterV2.quoteExactInputSingle` via `simulateContract` (eth_call, read-only). Auto-discovers the best fee tier by trying 500 → 3000 → 10000 bps and returning the tier with the highest `amountOut`.
2. **Approve** (if needed) — checks `ERC20.allowance(appWallet, router)`. If allowance is below `amountIn`, the backend approves `MAX_UINT256` and waits for the approval receipt before continuing.
3. **Swap** — calls `SwapRouter02.exactInputSingle` with `amountOutMinimum = quote × (1 − slippageBps/10000)`.

**UI features:**
- Live quote with 500 ms debounce — updates on every amount or token change
- Balance display for the app wallet (via wagmi `useBalance`) for all Uniswap testnets
- **Suggested tokens** — cross-references the top 5 yield pools on the selected chain with the token registry and shows quick-select chips for tokens needed to enter those pools
- Slippage preset buttons: 0.25% / 0.5% / 1%
- Pool fee tier shown after quote (e.g. "Pool fee: 0.3%")
- ⇅ direction swap button to reverse From/To
- Explorer link on success

**0G JAINE DEX** is a Uniswap V3 fork deployed on the 0G Network (chain ID 16661, RPC `https://evmrpc.0g.ai`). It uses the same `exactInputSingle` ABI as SwapRouter02 and the same `quoteExactInputSingle` ABI as QuoterV2 — no code changes are needed to support it beyond the chain configuration.

**API endpoints:**

| Method | Endpoint | Description |
|---|---|---|
| GET | `/swap/chains` | All supported swap chains with token registries |
| POST | `/swap/quote` | Simulate swap; returns `amountOutFormatted`, `fee`. Body: `{ chainId, tokenIn, tokenOut, amountIn, decimalsIn, fee? }` |
| POST | `/swap/execute` | Approve + swap via app wallet. Body: `{ chainId, tokenIn, tokenOut, amountIn, decimalsIn, fee, slippageBps? }` |

---

### KeeperHub Integration

> **Design principle: EarnYld decides. KeeperHub executes.**

EarnYld handles the intelligence layer — pool discovery, hook risk analysis, portfolio scoring, risk budget enforcement, and LLM-driven decisions. **KeeperHub** handles the operational layer — scheduled monitoring, transaction execution, gas estimation, nonce management, retries, failure alerting, and run logs. Neither component does both jobs.

This separation means EarnYld never hand-rolls keeper infrastructure, and KeeperHub never runs AI inference.

#### API contract

Two dedicated endpoints expose the agent's decisions as structured data for KeeperHub condition nodes:

**`GET /keeper/positions`** — Returns every open position with a pre-evaluated `conditions` block. KeeperHub can branch directly on these booleans without calling the scoring API separately.

```json
{
  "positionId": "1714123456789-1",
  "pair": "WETH/USDC",
  "chainName": "Base Sepolia",
  "compositeScore": 78,
  "hookIsBlocked": false,
  "tvlUsd": 840000,
  "inRange": true,
  "conditions": {
    "inRange": true,
    "scoreOk": true,
    "hookRiskOk": true,
    "tvlOk": true,
    "shouldAlert": false,
    "shouldRebalance": false,
    "shouldExit": false
  }
}
```

**`POST /keeper/signal`** — Full scoring signal for a specific pool or position. Accepts `{ poolId?, positionId? }`. Returns all condition booleans plus a `recommendation` ("enter" / "hold" / "rebalance" / "alert" / "exit" / "skip") and a `reasoning` string for use in notification messages.

```json
{
  "signalType": "position",
  "compositeScore": 78,
  "hookRiskScore": 90,
  "effectiveNetAPY": 41.2,
  "tvlUsd": 840000,
  "conditions": {
    "scoreOk": true,
    "hookRiskOk": true,
    "tvlOk": true,
    "volumeOk": true,
    "positionInRange": true,
    "shouldAlert": false,
    "shouldRebalance": false,
    "shouldExit": false,
    "canEnterNew": true
  },
  "recommendation": "hold",
  "reasoning": "Score 78/100, TiR 84.2%, no exit triggers"
}
```

**Condition thresholds** (aligned with PortfolioManager constants):

| Condition | Rule |
|---|---|
| `scoreOk` | `compositeScore >= 60` |
| `hookRiskOk` | `!hookAnalysis.isBlocked` |
| `tvlOk` | `tvlUsd >= $50,000` |
| `volumeOk` | `volume24hUsd > 0` |
| `positionInRange` | `timeInRangePct >= 80%` |
| `shouldAlert` | Any exit alert is active |
| `shouldRebalance` | Out of range + held ≥ 24h + not a critical exit |
| `shouldExit` | Critical exit signal (RAR deterioration, stale position, price move, hook block) |
| `canEnterNew` | All four entry conditions pass |

#### Workflow file

`keeperhub-workflow.yaml` at the project root contains three complete workflows ready to import into your KeeperHub account. A second importable template is available at `keeperhub/templates/earnYld-yield-optimizer.json` — a self-contained scheduled notification workflow that requires no additional EarnYld keeper endpoints:

**Workflow 1 — Monitor and Rebalance** (every 15 minutes)
```
Schedule trigger (15 min)
  → GET /keeper/positions         # fetch all open positions
  → forEach position:
      POST /keeper/signal         # score + conditions
      → branch: shouldExit?       → notify Discord/Telegram + record exit intent
      → branch: shouldRebalance?  → notify Discord + optionally call onchain remove/add
      → branch: shouldAlert?      → notify Discord
      → branch: healthy?          → log "✓ WETH/USDC healthy — score 78, TiR 84%"
  → log run complete
```

**Workflow 2 — Discover Entry Opportunities** (every 1 hour)
```
Schedule trigger (1 hr)
  → GET /yields?limit=5           # top-ranked pools
  → forEach pool:
      POST /keeper/signal
      → branch: canEnterNew?      → notify Discord with full scorecard summary
      → branch: blocked?          → log skip reason
```

**Workflow 3 — Hook Risk Change Alert** (webhook trigger)
```
Webhook trigger (EarnYld posts on hook risk change)
  → branch: riskLevel == critical → notify Discord + Telegram: exit immediately
  → branch: riskLevel == high     → notify Discord: reduce allocation
  → branch: resolved              → log resolution
```

KeeperHub condition nodes read fields like `{{steps.pool_signal.conditions.shouldExit}}` directly — no text parsing required.

#### Why this matters

Building keeper infrastructure in-house means writing your own: gas price oracle, retry logic with exponential backoff, nonce sequence management across concurrent transactions, mempool monitoring, failure alerting, and structured run logs. These are all solved by KeeperHub. EarnYld's scoring model is the differentiator; the execution plumbing is not.

```
EarnYld                    KeeperHub
──────────────────────     ────────────────────────────────
Pool discovery             Scheduled trigger management
Hook risk analysis         Gas estimation + price oracle
Regime detection           Nonce ordering across txs
9-dimension scoring        Transaction retry + backoff
Portfolio optimisation     Failure alerting (Discord/TG/email)
LLM Seeker/Critic          Structured run logs
Risk budget enforcement    Conditional workflow branching
                           onchain read/write contract actions
```

---

### MCP Server

> **Let any AI agent talk directly to EarnYld.**

`agents/mcp-server/` is a [Model Context Protocol](https://modelcontextprotocol.io) server that exposes EarnYld's REST API as 9 AI-discoverable tools. Connect Claude Code, Cursor, or any MCP-compatible client and the agent can query yields, inspect portfolio state, and simulate swaps — without writing API calls.

#### Quick start

```bash
# 1. Start the EarnYld agent (port 3001)
cd agents && npm start

# 2. Start the MCP server (port 3002)
cd agents/mcp-server && npm install && npm start

# 3. Connect from Claude Code
claude mcp add --transport http earnyld http://localhost:3002/sse
```

#### Tools

| Tool | What it does |
|---|---|
| `list_yields` | Ranked yield opportunities (chainId / network / minAPY / limit filters) |
| `get_pool` | Full data for a single pool by ID |
| `get_portfolio` | Simulated portfolio summary (cash, PnL, regime) |
| `get_positions` | Open simulated positions |
| `get_trades` | Trade execution log |
| `get_decisions` | LLM Seeker → Critic decision history |
| `check_slippage` | Simulate a swap and return expected output + slippage % |
| `get_chains` | All supported chain configs |
| `health_check` | Agent liveness + pool scan count |

#### Environment variables

| Variable | Default | Description |
|---|---|---|
| `MCP_PORT` | `3002` | Port the MCP server listens on |
| `EARNYLD_API_URL` | `http://localhost:3001` | EarnYld agent API base URL |

> **Security:** `/sse` and `/messages` have no authentication by default. Do not expose the MCP server to the public internet without a reverse proxy or API key layer.

---

### INFT Strategy Agents

> **Turn your AI portfolio agent into an ownable, transferable NFT.**

Every portfolio agent in EarnYld can be minted as an **ERC-7857-style Intelligent NFT** on the **0G Galileo testnet** (chain ID 16602). The INFT captures the full strategy configuration — risk profile, scorecard weights, LLM model, hook preferences, and live performance stats — in an immutable on-chain record.

Off-chain metadata is stored on **0G Storage** and referenced via the `storageUri` field. This means the agent's strategy state is content-addressed (SHA-256 root hash) and survives even if the EarnYld backend goes offline.

#### My Strategy Agents panel

Click **🤖 Agents** in the header to open the Strategy Agents panel. From there you can:

- **View all INFTs** owned by any wallet address — shows token ID, name, risk profile, permissions, PnL, and 0G Storage URI
- **Mint a new agent** — choose a strategy archetype, optionally override the agent name, enter a recipient wallet, and mint to 0G Galileo testnet in one click
- **Clone** — fork an existing strategy to a new owner wallet (mints a new INFT with `parentTokenId` set)
- **Authorize** — grant or revoke execution rights for another wallet without transferring ownership (ERC-7857 delegation)
- **Transfer** — standard ERC-721 transfer to a new owner

The panel runs in **demo mode** when `INFT_CONTRACT_ADDRESS` is not set, so you can preview the UI before deploying the contract.

#### Strategy archetypes

| Type | Risk | Max Alloc | Description |
|------|------|-----------|-------------|
| `conservative-stable` | low | 10% | Stablecoin-only pools; IL-first scoring; HITL required |
| `eth-usdc-harvest` | moderate | 25% | ETH-denominated pairs; balanced scoring; HITL required |
| `hook-aware-aggressive` | high | 30% | v4 hooked pools with dynamic fees; yield-first; HITL required |
| `testnet-research` | low | 50% | Paper-trades testnet pools; fully autonomous |

#### INFT permissions model

Each INFT carries three permission flags that gate agent execution:

```json
{
  "canExecute":       false,
  "requiresHITL":     true,
  "maxAllocationPct": 25
}
```

`AgentAccessControl` checks these on every portfolio action. In demo mode (no contract address) all checks pass. If the contract call fails, the system **fails open** (`allowed=true`) but forces HITL and caps allocation at 10% as a safety measure.

#### API endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/inft/mint-agent` | Build metadata → upload to 0G Storage → mint INFT |
| `GET`  | `/inft/agents/:owner` | List all INFTs owned by a wallet |
| `GET`  | `/inft/:tokenId/metadata` | Fetch on-chain state + off-chain metadata bundle |
| `POST` | `/inft/:tokenId/authorize` | Grant/revoke execution rights for a user |
| `POST` | `/inft/:tokenId/clone` | Fork strategy to a new owner wallet |
| `POST` | `/inft/:tokenId/transfer` | Transfer INFT to a new owner |

#### Deploying the INFT contract

```bash
cd contracts
npx hardhat run scripts/deploy.ts --network zerog-galileo
# Set INFT_CONTRACT_ADDRESS in .env with the deployed address
```

Contract: `contracts/EarnYldAgentINFT.sol` — ERC-721 base extended with `mintAgent`, `clone`, `authorizeUsage`, `updateStorageUri`. Deploys to 0G Galileo (chain 16602, RPC `https://evmrpc-testnet.0g.ai`).

Token URI format: `0g://{storageUri}` — resolves via the 0G Storage indexer.

---

### Telegram notifications

Set two variables in `.env` and the agent broadcasts every significant event to Telegram — no restart required, no code changes.

```env
TELEGRAM_BOT_TOKEN=<from @BotFather>
TELEGRAM_CHAT_ID=6272037379,-1003983195163   # comma-separated list: personal DM, channel, group, ...
```

**Events posted automatically:**

| Event | Emoji | Trigger |
|---|---|---|
| Hourly reflection | 🌾 | LLM commentary complete |
| Position opened | ✅ | Autonomous mode or HITL approved |
| Position closed | 📤 | Any exit (LLM or rule-based) |
| Critic veto | 🚫 | Seeker proposal blocked |
| HITL pending | ⏳ | New action queued for approval |
| Exit signal | ⚠️ | Rule-based exit trigger in HITL mode |

**Setup (2 minutes):**
1. Message **@BotFather** on Telegram → `/newbot` → copy the token
2. Add the bot to your channel/group and send any message
3. Visit `https://api.telegram.org/bot<TOKEN>/getUpdates` → copy `chat.id`
4. For a channel, the chat ID starts with `-100…`; multiple IDs are comma-separated

`TELEGRAM_CHAT_ID` accepts a single ID or a comma-separated list — every message is broadcast to all recipients in parallel. When either variable is absent all calls are silent no-ops.

---

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

A **🤖 Choose LLM** button in the header opens a model-selection panel. The dropdown lists models available on the 0G Compute network, grouped by provider:

| Environment | Available models |
|---|---|
| Testnet (`router-api-testnet.integratenetwork.work`) | `qwen/qwen-2.5-7b-instruct` |
| Mainnet (`router-api.0g.ai`) | DeepSeek V3, Qwen3 VL, GLM-5, GLM-5.1 and more |

A **"Enter a custom model ID"** toggle accepts any model ID available on 0G Compute (`GET /v1/models`).

Clicking **Apply** calls `POST /settings/llm`. The model change takes effect on the next LLM invocation — no agent restart required. Both the Seeker/Critic (`LLMClient`) and the Reflection Agent call `getModel()` at call time from a shared `LLMConfig` singleton.

The catalogue is hardcoded in the frontend so the dropdown is always populated regardless of whether the agent API is reachable.

### LLM pipeline — Seeker → Critic → Executor
When `ZEROG_COMPUTE_API_KEY` is set, every 5-minute cycle runs two sequential LLM calls:

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

## Deployment

The frontend and backend are deployed independently. The live demo runs at:

| Service | URL |
|---|---|
| Frontend | **https://earnyld.0gskills.com** |
| Backend API | https://api.earnyld.0gskills.com *(Railway)* |

### Frontend — Vercel

The Next.js frontend is deployed to [Vercel](https://vercel.com) and served from `earnyld.0gskills.com`.

```bash
npm install -g vercel
cd frontend
vercel --prod --yes --scope <your-team> \
  -e NEXT_PUBLIC_AGENT_API_URL=https://api.earnyld.0gskills.com \
  -e NEXT_PUBLIC_APP_WALLET_ADDRESS=0x... \
  -e NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID=...
```

**DNS** (add to your DNS provider):
| Type | Name | Value |
|---|---|---|
| `CNAME` | `earnyld` | `cname.vercel-dns.com` |
| `TXT` | `_vercel` | *(shown by Vercel when you add the domain)* |

To redeploy after an env var change (Next.js bakes `NEXT_PUBLIC_*` at build time):
```bash
cd frontend && vercel --prod --yes --scope <your-team>
```

### Backend — Railway

The agent API is deployed to [Railway](https://railway.app) from the `agents/` subdirectory. `railway.toml` sets the build and start commands; Railway injects `PORT` automatically.

```bash
npm install -g @railway/cli
cd agents
railway login --browserless   # opens railway.com/activate in browser
railway init                  # create empty project + empty service
railway up                    # deploy from current directory
```

Set all variables from `.env` in the Railway dashboard under **Variables**, then add:
```env
PORT=             # injected automatically by Railway — do not set manually
NETWORK_FILTER=testnet   # recommended for demo; reduce to testnet chains only
```

To expose the service publicly: Railway dashboard → your service → **Settings** → **Networking** → **Generate Domain**. Use that URL (or your custom `api.earnyld.0gskills.com` CNAME) as `NEXT_PUBLIC_AGENT_API_URL` in Vercel.

**Notes:**
- SQLite state (`agents/data/`) is ephemeral on Railway's free tier — portfolio history resets on redeploy. Use a Railway volume or export snapshots to persist state across deploys.
- The agent scans all 18 chains on startup. Set `NETWORK_FILTER=testnet` to reduce Alchemy API usage on the free RPC tier.
- `railway up` deploys from local files; push to GitHub and link the repo in Railway for automatic deploys on push to `main`.

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

# Enable LLM-driven decisions via 0G Compute (falls back to rules if absent)
ZEROG_COMPUTE_API_KEY=sk-...          # from pc.0g.ai (mainnet) or pc.testnet.0g.ai (testnet)
ZG_ROUTER_URL=https://router-api-testnet.integratenetwork.work/v1  # testnet
# ZG_ROUTER_URL=https://router-api.0g.ai/v1                        # mainnet
LLM_MODEL=qwen/qwen-2.5-7b-instruct  # testnet; use deepseek/deepseek-chat-v3-0324 on mainnet

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

# Local dev — points to local agent
NEXT_PUBLIC_AGENT_API_URL=http://localhost:3001

# Hosted — points to Railway backend
# NEXT_PUBLIC_AGENT_API_URL=https://api.earnyld.0gskills.com

NEXT_PUBLIC_APP_WALLET_ADDRESS=0x...          # from APP_WALLET_PRIVATE_KEY derivation
NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID=...      # optional; placeholder works for local dev
```

### 5. Start the frontend

```bash
cd frontend
npm run dev
```

Open **http://localhost:3000** (local) or **https://earnyld.0gskills.com** (hosted).

---

## Dashboard

Full-viewport layout with a right sidebar for AI reflections and decisions.

**Header bar (left → right)**
- 🌾 EarnYld branding + scan timestamp
- Autonomous / Human-in-Loop mode toggle (with pending-action badge count)
- Refresh button
- API Docs link
- 🤖 Choose LLM — opens model selector panel
- 🔄 Swap — opens token swap modal (Uniswap V3 testnets + 0G JAINE DEX)
- 🤖 Agents — opens Strategy Agents panel (INFT mint / view / clone / authorize / transfer)
- 💸 Transfer — opens Send/Receive testnet token modal
- Connect Wallet / address chip / Disconnect (RainbowKit)

**Main column (top → bottom)**
- **App Wallet Balances** — live token balances for the app wallet across all testnets, chain-switchable
- **Stats bar** — Pools Found, Open Positions, Total Trades, Fees Earned, Unrealised PnL, Last Decision badge
- **Risk Budget panel** — six progress bars (chain, token, volatile, issuer, pool, cash). Red when a constraint is breached
- **Pending Actions panel** (HITL mode only) — queued decisions with Approve / Reject buttons and rich execution failure feedback
- **Yield Opportunities tab** — 22-column table sorted by Effective Net APY. All columns have hover tooltips. Sortable by Eff. APY, RAR, TVL, LQ, Persistence, Stress score, and Scorecard composite. Hook column shows ✓/⚠/⚡/🚫 risk badges; scorecard tooltip shows all 9 dimensions including Hook Risk
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
| GET | `/swap/chains` | All supported swap chains with DEX name and token registries |
| POST | `/swap/quote` | Simulate a V3 single-hop swap via QuoterV2; auto-discovers best fee tier. Body: `{ chainId, tokenIn, tokenOut, amountIn, decimalsIn, fee? }` |
| POST | `/swap/execute` | ERC20 approve (if needed) + swap via app wallet. Body: `{ chainId, tokenIn, tokenOut, amountIn, decimalsIn, fee, slippageBps? }` |
| GET | `/keeper/positions` | Open position health snapshots with pre-evaluated `conditions` block for KeeperHub |
| POST | `/keeper/signal` | Full scoring signal for a pool or position. Returns `conditions` + `recommendation` + `reasoning`. Body: `{ poolId?, positionId? }` |
| POST | `/inft/mint-agent` | Build metadata → upload to 0G Storage → mint INFT on 0G Galileo. Body: `{ to, strategyType?, name?, version? }` |
| GET | `/inft/agents/:owner` | List all INFT strategy agents owned by a wallet |
| GET | `/inft/:tokenId/metadata` | Fetch on-chain agent state + off-chain metadata bundle from 0G Storage |
| POST | `/inft/:tokenId/authorize` | Grant or revoke execution rights for a user. Body: `{ user, authorized? }` |
| POST | `/inft/:tokenId/clone` | Fork strategy to a new owner wallet. Body: `{ cloneOwner }` |
| POST | `/inft/:tokenId/transfer` | ERC-721 transfer. Body: `{ from, to }` |
| GET | `/health` | Liveness check |

### Shared API contract

The frontend re-exports opportunity and enrichment contract types from `agents/src/api/types.ts` instead of redefining `RankedOpportunity` locally. Backend code imports the same `RankedOpportunity` type, so scorecard, enrichment, risk, optimizer, and hook fields fail type-checking in one place instead of drifting silently between `ReporterAgent` and `frontend/src/types/api.ts`.

---

## Project structure

```
earnYld/
├── keeperhub-workflow.yaml               # Three importable KeeperHub workflows
│                                         #   (Monitor+Rebalance, Entry Discovery, Hook Alert)
├── keeperhub/
│   └── templates/
│       ├── earnYld-yield-optimizer.json  # Standalone KeeperHub notification template
│       └── README.md                     # Template usage guide
├── vercel.json                           # Vercel build config for frontend deployment
├── contracts/
│   └── EarnYldAgentINFT.sol              # ERC-7857-style INFT contract (0G Galileo testnet)
├── agents/
│   ├── mcp-server/                       # MCP server (port 3002)
│   │   ├── src/
│   │   │   ├── index.ts                  # Express SSE + /messages endpoints
│   │   │   ├── server.ts                 # 9 MCP tool definitions + dispatch
│   │   │   ├── types.ts                  # asToolResult / asToolError helpers
│   │   │   └── client/
│   │   │       └── earnlab.ts            # HTTP client for EarnYld agent API
│   │   └── README.md                     # Quick start + tools reference
│   ├── keeperhub/                        # Shared KeeperHub utilities
│   │   ├── types.ts                      # KeeperhubError, EarnlabYield types
│   │   └── utils/
│   │       ├── http.ts                   # Fetch wrapper with sanitized error detail
│   │       ├── validators.ts             # requireBaseUrl, validateTemplateInputs
│   │       └── errors.ts                 # asKeeperhubError helper
│   └── src/
│       ├── index.ts                          # Entry point; initialises ZeroGStorageClient
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
│       │   ├── HookAnalyzer.ts               # v4 hook classification + risk score
│       │   │                                 #   (Sourcify, fee/incentive/rebalance)
│       │   ├── DecisionScorecard.ts          # 9-dimension weighted scorecard
│       │   ├── PortfolioOptimizer.ts         # Marginal-Sharpe greedy allocator
│       │   └── RiskBudget.ts                 # Portfolio-level constraint checks
│       ├── llm/
│       │   ├── LLMClient.ts                  # Seeker + Critic LLM calls (0G Compute)
│       │   ├── ReflectionAgent.ts            # Hourly streaming reflection
│       │   └── LLMConfig.ts                  # Mutable model singleton (getModel/setModel)
│       ├── notifications/
│       │   └── TelegramNotifier.ts           # Fire-and-forget Telegram bot notifications
│       │                                     #   (reflections, opens, closes, HITL, vetoes)
│       ├── og/
│       │   └── ZeroGStorageClient.ts         # Upload/retrieve agent state bundles
│       │                                     #   on 0G Storage (sha256 content URIs)
│       ├── inft/
│       │   ├── INFTContractClient.ts         # viem wrapper for EarnYldAgentINFT.sol
│       │   │                                 #   (mint, clone, authorize, transfer, read)
│       │   ├── AgentMetadataBuilder.ts       # Builds AgentINFTMetadata from portfolio state
│       │   │                                 #   (4 strategy archetypes with preset weights)
│       │   └── AgentAccessControl.ts         # Gates portfolio execution by INFT ownership;
│       │                                     #   fail-open with forced HITL on error
│       ├── storage/
│       │   ├── ZeroGMemory.ts                # 0G KV episodic memory (RAG)
│       │   ├── ReflectionStore.ts            # SQLite reflection persistence
│       │   ├── ExecutionHistory.ts           # SQLite execution log
│       │   └── SnapshotStore.ts              # SQLite ranked + portfolio snapshots
│       ├── api/
│       │   ├── server.ts                     # Express REST + SSE endpoints
│       │   │                                 #   (swap, keeper, wallet, portfolio, inft)
│       │   └── types.ts                      # Shared API contract types (incl. INFT)
│       ├── railway.toml                      # Railway build + start config for hosted deploy
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
        │   ├── SwapModal.tsx                 # Token swap (Uniswap V3 + 0G JAINE DEX)
        │   ├── AppWalletBalances.tsx         # Live app wallet balance widget (all testnets)
        │   ├── AgentINFTPanel.tsx            # Strategy agent INFT — mint/clone/authorize/transfer
        │   └── LLMSelector.tsx              # 0G Compute model picker (testnet/mainnet catalogue)
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
| `ZEROG_COMPUTE_API_KEY` | — | Enables LLM decisions via 0G Compute; falls back to rules if absent |
| `ZG_ROUTER_URL` | `https://router-api-testnet.integratenetwork.work/v1` | 0G Compute router URL (swap for mainnet URL when ready) |
| `LLM_MODEL` | `qwen/qwen-2.5-7b-instruct` | Model ID available on your 0G Compute network |
| `REFLECT_INTERVAL_MS` | `3600000` | Reflection cadence (1h default) |
| `ZEROG_PRIVATE_KEY` | — | Enables 0G persistent memory |
| `ZEROG_RPC_URL` | `https://evmrpc-testnet.0g.ai` | 0G EVM RPC |
| `ZEROG_INDEXER_URL` | `https://indexer-storage-testnet-turbo.0g.ai` | 0G storage indexer |
| `ZEROG_KV_URL` | `http://3.101.147.150:6789` | 0G KV endpoint |
| `ZEROG_STREAM_ID` | (hardcoded default) | 0G KV stream for decision records |
| `ZEROG_AGENT_STREAM_ID` | (hardcoded default) | 0G KV stream for INFT agent state bundles |
| `INFT_CONTRACT_ADDRESS` | — | Deployed address of EarnYldAgentINFT.sol on 0G Galileo; demo mode if unset |
| `TELEGRAM_BOT_TOKEN` | — | Telegram bot token from @BotFather; notifications disabled if absent |
| `TELEGRAM_CHAT_ID` | — | Comma-separated chat/channel IDs to broadcast to |
| `MAX_SLIPPAGE_BPS` | `50` | Slippage guard threshold (0.5%) |
| `NEXT_PUBLIC_AGENT_API_URL` | `http://localhost:3001` | Frontend → agent URL |
| `APP_WALLET_PRIVATE_KEY` | — | Private key for the EarnYld app wallet (server-only, never exposed to browser) |
| `NEXT_PUBLIC_APP_WALLET_ADDRESS` | — | Public address of the app wallet — shown in the Transfer modal and balance widget |
| `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` | `earnYld_placeholder` | WalletConnect project ID (get one at cloud.walletconnect.com) |
| `THEGRAPH_API_KEY` | — | Enables The Graph Uniswap v4 subgraph enrichment |
| `SEPOLIA_RPC_URL` | `https://rpc.sepolia.org` | RPC for Sepolia swap/quote calls |
| `BASE_SEPOLIA_RPC_URL` | `https://sepolia.base.org` | RPC for Base Sepolia swap/quote calls |
| `OP_SEPOLIA_RPC_URL` | `https://sepolia.optimism.io` | RPC for OP Sepolia swap/quote calls |
| `ARB_SEPOLIA_RPC_URL` | `https://sepolia-rollup.arbitrum.io/rpc` | RPC for Arb Sepolia swap/quote calls |
| `UNICHAIN_SEPOLIA_RPC_URL` | `https://sepolia.unichain.org` | RPC for Unichain Sepolia swap/quote calls |

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

### `@uniswap/v4-sdk` — Hook flag decoding and risk analysis

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

In Uniswap v4, the hooks contract address is mined so that its lower 14 bits encode which of the 14 hook points (`beforeSwap`, `afterSwap`, `beforeAddLiquidity`, etc.) are implemented. `decodeHookFlags` reads these bits using the SDK's authoritative bit-position map and returns the list of active callbacks.

The decoded callbacks feed directly into `HookAnalyzer.ts`, which uses them to:
- Classify **fee type** (`static` vs `dynamic-unknown` when `beforeSwap` is active)
- Classify **incentive model** (`real-fees` vs `hook-native-rewards` when `afterSwap`/`afterAddLiquidity` intercepts fees)
- Classify **rebalance behaviour** (`auto-compound`, `range-rebalance`, or `none`)
- Accumulate a **risk score** based on which callbacks are present (e.g. `beforeRemoveLiquidity` = +30 for capital lockup risk)
- Apply a `netAPYMultiplier` (×1.10 for low-risk to ×0.70 for critical) and an `incentiveHaircut` to discount uncertain reward streams

The result feeds into the 9th scorecard dimension (`hookRisk`) and adjusts the effective yield used in the Yield dimension. The frontend shows ✓/⚠/⚡/🚫 colour-coded risk badges per pool with a hover tooltip detailing the score, callbacks, source verification status, fee type, and rebalance type.

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
