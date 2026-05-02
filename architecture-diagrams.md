# EarnYld — Architecture Diagram Prompts (Eraser.io)

Paste each prompt into [eraser.io/ai/architecture-diagram-generator](https://www.eraser.io/ai/architecture-diagram-generator) and click **Generate Diagram**.

---

## Diagram 1: High-Level System Architecture

```
Architecture diagram for EarnYld — an autonomous Uniswap v4 LP yield optimizer.

Structural components:
- "Browser (User)" — end user's browser
- "Frontend" — Next.js 14 app hosted on Vercel (port 3000). Contains dashboard, wallet UI, swap modal, INFT panel
- "Agent API" — Node.js/Express backend hosted on Railway (port 3001). Core intelligence: scanning, enrichment, scoring, portfolio simulation, LLM pipeline
- "MCP Server" — Express MCP-over-HTTP server (port 3002). Proxies 9 AI tools to the Agent API
- "SQLite" — 4 database files: snapshots.db, reflections.db, yield-hunter.db, apy_history.db
- "18 EVM Chains" — Ethereum, Base, Arbitrum, Optimism, Unichain, Polygon, Blast, Avalanche, BNB, Celo, Zora, Worldchain, Ink, Soneium + 4 testnets. Accessed via JSON-RPC
- "DefiLlama API" — TVL, token prices, pool volume enrichment
- "GoPlus API" — Token security assessment (honeypot, owner risk)
- "Sourcify API" — Hook contract source code verification
- "The Graph" — Optional Uniswap v4 subgraph for TVL/volume
- "0G Compute" — LLM inference (OpenAI-compatible router). Models: DeepSeek V3, Qwen, GLM
- "0G KV Storage" — Decentralised episodic memory for decision records
- "0G Blob Storage" — INFT metadata bundles (content-addressed SHA-256)
- "0G Galileo Testnet" — EarnYldAgentINFT.sol smart contract (chain 16602)
- "Telegram Bot API" — Push notifications for reflections, opens, closes, vetoes
- "KeeperHub (external)" — Workflow automation: scheduled triggers, tx execution, retries, alerting
- "AI Agents (Claude/Cursor)" — MCP-compatible clients that connect via SSE

Connections:
- Browser connects to Frontend via HTTPS
- Frontend calls Agent API via REST + SSE for live reflections and decisions
- MCP Server proxies AI Agent requests to Agent API via HTTP REST
- AI Agents connect to MCP Server via SSE + POST /messages
- Agent API reads on-chain pool state from 18 EVM Chains via JSON-RPC (viem)
- Agent API fetches enrichment data from DefiLlama API, GoPlus API, Sourcify API, and The Graph
- Agent API sends LLM prompts to 0G Compute and receives structured JSON decisions
- Agent API writes decision records to 0G KV Storage and INFT bundles to 0G Blob Storage
- Agent API mints/reads INFTs on 0G Galileo Testnet
- Agent API sends notifications to Telegram Bot API
- Agent API persists state to SQLite
- KeeperHub polls Agent API endpoints (/keeper/positions, /keeper/signal) on a schedule
- Frontend connects user wallet via RainbowKit/WalletConnect to EVM Chains
```

---

## Diagram 2: Agent Backend — Enrichment Pipeline

```
Architecture diagram showing the pool enrichment pipeline inside the EarnYld Agent backend.

Structural components:
- Group "UniswapV4Scanner" containing: "Event Watcher (Initialize + Swap)", "StateView Reader (slot0, liquidity)", "Pool ID Computation (keccak256)"
- Group "Enrichment Pipeline (async, concurrency=5)" containing: "APYCalculator (feeAPY, IL, netAPY)", "VolatilityCalculator (hourly log-returns, σ, RAR)", "CapitalEfficiencyCalculator (TiR, FCE, effectiveNetAPY)", "TokenRiskAssessor (GoPlus)", "StablecoinRiskAssessor (6 dimensions)", "AdverseSelectionDetector (4 signals)", "ScenarioStressTester (8 scenarios)", "HookAnalyzer (flag decode, fee/incentive/rebalance classification, Sourcify verification)"
- "DecisionScorecard" — 9-dimension weighted composite (Yield, IL, Liquidity, Volatility, Token Risk, Gas, Correlation, Regime, Hook Risk)
- "ReporterAgent" — orchestrates scan → enrich → rank cycle
- "APYHistoryStore (SQLite)" — hourly APY snapshots for persistence and correlation
- "SnapshotStore (SQLite)" — persists latest ranked list
- Group "External APIs" containing: "DefiLlama", "GoPlus", "Sourcify", "The Graph"
- "18 EVM Chains (JSON-RPC)"

Connections:
- ReporterAgent triggers UniswapV4Scanner every 60 seconds
- UniswapV4Scanner reads Initialize and Swap events from 18 EVM Chains
- UniswapV4Scanner reads slot0 and liquidity from StateView contract on each chain
- Discovered pools flow into the Enrichment Pipeline
- APYCalculator fetches price and volume from DefiLlama
- TokenRiskAssessor queries GoPlus for honeypot and ownership flags
- HookAnalyzer queries Sourcify for source code verification and decodes hook flags from pool address
- CapitalEfficiencyCalculator reads hourly history from APYHistoryStore
- All enrichment results feed into DecisionScorecard which computes composite scores
- ReporterAgent saves the ranked opportunity list to SnapshotStore
- Failed enrichment stages mark pools as degraded with enrichmentErrors[]
```

---

## Diagram 3: LLM Decision Pipeline (Seeker → Critic → Executor)

```
Architecture diagram for the LLM-driven decision pipeline in EarnYld.

Structural components:
- "PortfolioManager" — triggers LLM cycle every 5 minutes
- "Context Builder" — assembles macro regime, portfolio state, token exposure, risk budget, optimiser output, ranked opportunities, open positions
- "0G Memory (ZeroGMemory)" — episodic decision records stored in 0G KV. getSimilar() retrieves past outcomes by Euclidean distance in condition-space
- "LLMClient" — OpenAI-compatible client pointed at 0G Compute router
- "Seeker LLM Call" — reviews context + past outcomes, returns structured JSON decisions (enter/exit/hold)
- "Critic LLM Call" — receives Seeker proposal, argues against it. Checks IL risk, weak RAR, adverse selection, stress downside, composite threshold, momentum, TVL, overconcentration, gas break-even. Returns {veto, confidence, reasoning}
- "Executor" — only executes decisions with confidence >= 0.75 and no veto
- "LLMConfig Singleton" — mutable model config (getModel/setModel). Changed at runtime via POST /settings/llm
- "0G Compute Router" — LLM inference endpoint (testnet or mainnet)
- "ReflectionAgent" — runs hourly, streams 1-5 sentence reflection via SSE, persisted in SQLite
- "ReflectionStore (SQLite)" — stores reflection history, feeds past reflections as context
- "Deterministic Rules Fallback" — used when ZEROG_COMPUTE_API_KEY is not set

Connections:
- PortfolioManager triggers Context Builder every 5 minutes
- Context Builder pulls ranked opportunities from ReporterAgent and portfolio state from PortfolioManager
- Context Builder queries 0G Memory for similar past outcomes
- Context Builder passes assembled prompt to Seeker LLM Call
- Seeker LLM Call sends request to 0G Compute Router via LLMClient
- Seeker output flows to Critic LLM Call
- Critic LLM Call sends request to 0G Compute Router via LLMClient
- Critic output flows to Executor
- Executor writes decision record to 0G Memory
- If no API key, PortfolioManager uses Deterministic Rules Fallback instead
- ReflectionAgent runs hourly, reads from ReflectionStore for context, sends prompt to 0G Compute Router, streams tokens via SSE to frontend, saves to ReflectionStore
- LLMConfig Singleton provides model ID to both LLMClient and ReflectionAgent
```

---

## Diagram 4: Portfolio Management & Risk System

```
Architecture diagram for EarnYld's portfolio management and risk enforcement system.

Structural components:
- "PortfolioManager" — runs every 5 minutes against $10,000 simulated capital
- "Macro Regime Detector" — classifies market as risk-off (<-5% ETH 7d), neutral, or risk-on (>+5% ETH 7d)
- Group "Position Sizing" containing: "Kelly Criterion (¼ Kelly, capped 30%)", "Regime Multiplier (0.5x risk-off, 1x neutral, 1.5x risk-on)", "Tick Range Calculator (±2σ from vol7d using Uniswap v3 TickMath)"
- Group "Risk Budget (6 constraints)" containing: "Single Chain ≤40%", "Single Token ≤40%", "Volatile Pairs ≤50%", "Stablecoin Issuer ≤60%", "Single Pool ≤30%", "Cash Buffer ≥10%"
- Group "Exit Triggers (7 rules)" containing: "RAR drops to <50% of entry", "Competing pool >50% better RAR", "Price moved >±15% in 7d", "Time-in-Range <80%", "RAR falling 3 consecutive ticks ≥10% drop", "Negative momentum worsening ≥2pp/tick", "Stale >30d with netAPY <5%"
- "PortfolioOptimizer" — greedy marginal-Sharpe allocator using real APY correlation matrix
- "APYHistoryStore" — hourly snapshots for Pearson correlation computation
- "HITL Mode" — queues decisions as Pending Actions instead of auto-executing
- "Pending Actions Queue" — approve/reject with staleness TTL and rich failure feedback
- "SnapshotStore (SQLite)" — persists portfolio state (cash, positions, trades, regime)
- "TelegramNotifier" — broadcasts opens, closes, vetoes, HITL pending

Connections:
- PortfolioManager reads ranked opportunities and runs Macro Regime Detector
- Regime feeds into Position Sizing as a multiplier
- DecisionScorecard composite feeds into Kelly Criterion for allocation
- PortfolioOptimizer computes marginal Sharpe across candidates using APYHistoryStore correlation
- Before any entry or rebalance, Risk Budget validates all 6 constraints
- Every tick, Exit Triggers evaluate all open positions
- In HITL mode, decisions go to Pending Actions Queue instead of executing
- PortfolioManager persists state to SnapshotStore after every state transition
- TelegramNotifier fires on position open, close, veto, and HITL pending events
```

---

## Diagram 5: INFT Strategy Agents & 0G Integration

```
Architecture diagram for EarnYld's INFT (Intelligent NFT) strategy agent system and 0G network integration.

Structural components:
- "EarnYldAgentINFT.sol" — ERC-721 smart contract on 0G Galileo testnet (chain 16602). Functions: mintAgent, clone, authorizeUsage, updateStorageUri, transferFrom
- "INFTContractClient" — viem wrapper for contract interactions (mint, clone, authorize, transfer, read)
- "AgentMetadataBuilder" — builds strategy state bundles from portfolio state. 4 archetypes: conservative-stable, eth-usdc-harvest, hook-aware-aggressive, testnet-research
- "ZeroGStorageClient" — uploads and retrieves bundles on 0G Storage using SHA-256 content addressing
- "AgentAccessControl" — gates portfolio execution by INFT ownership. Reads canExecute, requiresHITL, maxAllocationPct. Fail-open with forced HITL on error
- "0G Galileo Testnet (chain 16602)" — hosts the INFT smart contract
- "0G Storage Indexer" — content-addressed blob storage for off-chain metadata
- "0G KV Storage" — episodic memory for decision records (ZeroGMemory)
- "Agent API REST endpoints" — POST /inft/mint-agent, GET /inft/agents/:owner, GET /inft/:tokenId/metadata, POST /inft/:tokenId/authorize, clone, transfer
- "Frontend AgentINFTPanel" — UI for mint, view, clone, authorize, transfer INFTs
- "App Wallet (viem)" — signs mint/clone/transfer transactions server-side

Connections:
- Frontend AgentINFTPanel calls Agent API INFT endpoints via REST
- POST /inft/mint-agent triggers AgentMetadataBuilder to build metadata bundle
- AgentMetadataBuilder passes bundle to ZeroGStorageClient which uploads to 0G Storage Indexer
- ZeroGStorageClient returns storageUri (0g://{hash})
- INFTContractClient calls mintAgent on EarnYldAgentINFT.sol on 0G Galileo Testnet, passing storageUri
- App Wallet signs all on-chain transactions
- AgentAccessControl reads on-chain permissions from EarnYldAgentINFT.sol before allowing portfolio actions
- Token URI format: 0g://{storageUri} resolves via 0G Storage Indexer
- Demo mode activates when INFT_CONTRACT_ADDRESS is unset — all checks pass
```

---

## Diagram 6: Frontend Dashboard & User Interaction

```
Architecture diagram for the EarnYld frontend dashboard and user interaction flows.

Structural components:
- "Browser"
- Group "Next.js 14 Frontend (Vercel)" containing:
  - Group "Header Bar" containing: "Mode Toggle (Autonomous/HITL)", "LLM Selector", "Swap Button", "Agents Button", "Transfer Button", "WalletButton (RainbowKit)"
  - Group "Main Dashboard" containing: "AppWalletBalances (all testnets)", "Stats Bar (pools, positions, trades, fees, PnL)", "RiskBudgetPanel (6 progress bars)", "PendingActionsPanel (HITL approve/reject)", "YieldTable (22 columns, sortable)", "PositionsTable (open/closed, TiR, exit alerts)"
  - Group "Right Sidebar" containing: "DecisionFeed (Seeker/Critic/Executor per cycle)", "ReflectionSidebar (SSE-streamed hourly)"
  - Group "Modals" containing: "SwapModal (Uniswap V3 + 0G JAINE DEX)", "TransferModal (Send/Receive tabs)", "AgentINFTPanel (mint/clone/authorize/transfer)"
- "wagmi v2 + RainbowKit v2" — wallet connection layer supporting MetaMask, Base Wallet, WalletConnect
- "Agent API (port 3001)" — backend REST + SSE
- "EVM Chains" — for wallet transactions (send, receive, swap signing)
- "Swagger UI (/docs page)" — interactive API documentation

Connections:
- Browser loads Frontend from Vercel
- YieldTable, PositionsTable, Stats Bar fetch data from Agent API via REST (GET /yields, /portfolio, /portfolio/positions)
- ReflectionSidebar streams from Agent API via SSE (GET /reflections/stream)
- DecisionFeed polls Agent API (GET /portfolio/decisions)
- PendingActionsPanel calls POST /pending-actions/:id/approve or /reject on Agent API
- SwapModal calls POST /swap/quote and /swap/execute on Agent API
- TransferModal Send tab calls POST /wallet/send on Agent API (server signs)
- TransferModal Receive tab signs transaction in browser via wagmi and sends to EVM Chains directly
- LLM Selector calls POST /settings/llm on Agent API
- Mode Toggle calls POST /settings on Agent API
- WalletButton connects to EVM Chains via RainbowKit/WalletConnect
- AgentINFTPanel calls INFT endpoints on Agent API
```

---

## Diagram 7: KeeperHub Integration & Workflow Execution

```
Architecture diagram showing KeeperHub integration with EarnYld. Design principle: EarnYld decides, KeeperHub executes.

Structural components:
- Group "EarnYld Agent" containing: "Pool Discovery & Scoring", "Portfolio Manager", "Risk Budget", "LLM Pipeline"
- Group "EarnYld Keeper API" containing: "GET /keeper/positions — position health snapshots with conditions block", "POST /keeper/signal — full scoring signal with recommendation and reasoning"
- Group "KeeperHub Platform (external SaaS)" containing:
  - Group "Workflow 1: Monitor & Rebalance (every 15 min)" containing: "Schedule Trigger", "Fetch Positions", "Score Each Position", "Branch: shouldExit → notify + record exit", "Branch: shouldRebalance → notify + optionally execute onchain", "Branch: shouldAlert → notify", "Branch: healthy → log"
  - Group "Workflow 2: Discover Entry (every 1 hr)" containing: "Schedule Trigger", "Fetch Top 5 Yields", "Score Each Pool", "Branch: canEnterNew → notify with scorecard", "Branch: blocked → log skip"
  - Group "Workflow 3: Hook Risk Alert (webhook)" containing: "Webhook Trigger", "Branch: critical → notify exit immediately", "Branch: high → notify reduce allocation", "Branch: resolved → log"
  - "Gas Estimation + Price Oracle", "Nonce Management", "Transaction Retry + Backoff", "Failure Alerting (Discord/Telegram/Email)", "Structured Run Logs"
- "Discord / Telegram" — notification destinations

Connections:
- Workflow 1 Schedule Trigger fires every 15 minutes
- Workflow 1 calls GET /keeper/positions on EarnYld Keeper API
- For each position, Workflow 1 calls POST /keeper/signal
- Condition branches read fields like conditions.shouldExit, conditions.shouldRebalance
- Workflow 2 Schedule Trigger fires every 1 hour
- Workflow 2 calls GET /yields?limit=5 on EarnYld Agent
- For each pool, Workflow 2 calls POST /keeper/signal
- Workflow 3 receives webhook from EarnYld on hook risk change
- All notification branches send to Discord and Telegram
- KeeperHub handles gas estimation, nonce ordering, retry logic, and run logging
- EarnYld never hand-rolls keeper infrastructure; KeeperHub never runs AI inference
```

---

## Diagram 8: End-to-End Data Flow — Pool Discovery to Position Entry

```
Data flow diagram showing how a Uniswap v4 pool is discovered, enriched, scored, and entered as a position in EarnYld.

Structural components:
- "Uniswap v4 PoolManager" — on-chain contract on 18 chains
- "UniswapV4Scanner" — watches Initialize events, reads StateView
- "DefiLlama" — price, TVL, volume data
- "GoPlus" — token security check
- "Sourcify" — hook source verification
- Group "Enrichment Pipeline" containing: "APY Calculation", "Volatility + RAR", "Capital Efficiency (TiR, FCE)", "Token Risk Assessment", "Stablecoin Risk", "Adverse Selection Detection", "Stress Testing (8 scenarios)", "Hook Analysis"
- "DecisionScorecard" — 9-dimension weighted composite
- "PortfolioOptimizer" — marginal Sharpe ranking with correlation
- "Risk Budget Check" — 6 hard constraints
- "Macro Regime" — risk-off / neutral / risk-on
- "LLM Seeker" — proposes enter/exit/hold
- "LLM Critic" — validates or vetoes proposal
- "Kelly Position Sizer" — ¼ Kelly with regime multiplier
- "Tick Range Calculator" — ±2σ from vol7d
- "HITL Gate" — queues as pending action or auto-executes
- "Paper Trading Engine" — simulates position with $10K capital
- "SQLite" — persists position and trade
- "0G Memory" — stores decision outcome for future RAG
- "Telegram" — notification

Sequential flow:
1. UniswapV4Scanner watches Initialize events from Uniswap v4 PoolManager across 18 chains
2. Scanner reads live slot0 and liquidity from StateView contract
3. Scanner fetches price and volume from DefiLlama
4. Pool enters the Enrichment Pipeline — each stage runs independently with failure isolation
5. GoPlus checks token security; hard-blocks honeypots
6. Sourcify verifies hook source code
7. All enrichment results feed into DecisionScorecard producing a 0-100 composite
8. PortfolioOptimizer ranks candidates by marginal Sharpe using APY correlation
9. Risk Budget Check validates chain, token, volatile, issuer, pool, and cash constraints
10. Macro Regime adjusts Kelly sizing multiplier
11. LLM Seeker reviews context + 0G Memory past outcomes and proposes entry
12. LLM Critic validates or vetoes the proposal
13. If approved (confidence >= 0.75, no veto), Kelly Position Sizer computes allocation
14. Tick Range Calculator sets ±2σ range using Uniswap v3 TickMath
15. HITL Gate either auto-executes or queues as pending action
16. Paper Trading Engine opens the simulated position
17. Position is persisted to SQLite and decision outcome is written to 0G Memory
18. Telegram notification fires
```
