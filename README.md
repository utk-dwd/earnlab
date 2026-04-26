# Earnlab / EarnGen

Autonomous DeFi portfolio management powered by a network of specialist AI agents. Agents hold on-chain identity as ERC-7857 iNFTs, communicate over an encrypted P2P mesh (Gensyn AXL), discover yield opportunities via Uniswap v3 and DefiLlama, and execute decisions through KeeperHub — all without manual intervention and without a central coordinator.

---

## Repository Layout

```
earnTest1/                  ← original single-agent MVP
├── contracts/              Solidity smart contracts (Hardhat)
├── agents/                 TypeScript agent runtime
└── frontend/               Next.js dashboard (wagmi + RainbowKit)

earnGen/                    ← multi-agent system (this repo)
├── agents/
│   ├── src/
│   │   ├── orchestrator/   Orchestrator agent
│   │   ├── tasks/          Yield scanner agents (Uniswap, stablecoin)
│   │   ├── portfolio/      Portfolio management agents
│   │   └── integrations/   AXL, Uniswap, 0G, KeeperHub clients
│   └── axl/                AXL node binary, configs, keys, logs
└── frontend/               Next.js dashboard
```

---

## Multi-Agent Architecture

Six specialist agents communicate over a private Gensyn AXL mesh. No REST APIs between agents — all messaging is raw bytes over Yggdrasil-encrypted P2P channels identified by Ed25519 public keys.

```
┌────────────────────────────────────────────────────────────────────────┐
│                       Gensyn AXL Mesh (Yggdrasil)                      │
│          Encrypted P2P  ·  Ed25519 identity  ·  Static private net     │
│                                                                        │
│  ┌─────────────────┐   SCAN_REQUEST    ┌──────────────────────────┐   │
│  │   Orchestrator  │ ───────────────▶  │   agent1-uniswap         │   │
│  │   (port 9002)   │ ◀──────────────── │   (port 9003)            │   │
│  │                 │   SCAN_RESULT     │   Scans all Uniswap v3   │   │
│  │  Dispatches     │                   │   pools on Ethereum       │   │
│  │  scan cycles,   │ ───────────────▶  └──────────────────────────┘   │
│  │  ranks results, │   SCAN_REQUEST    ┌──────────────────────────┐   │
│  │  commands best  │ ◀──────────────── │   agent2-stablecoin      │   │
│  │  execution      │   SCAN_RESULT     │   (port 9004)            │   │
│  └─────────────────┘                   │   Stable-only pairs      │   │
│                                        │   (USDC/USDT/DAI/FRAX)   │   │
│                                        └──────────────────────────┘   │
│                                                                        │
│  ┌─────────────────┐   YIELD_OPPORTUNITY  ┌──────────────────────┐    │
│  │  YieldHunter    │ ──────────────────▶  │   RiskManager        │    │
│  │  (port 9006)    │ ◀────────────────── │   (port 9007)        │    │
│  │                 │   RISK_CHALLENGE     │                      │    │
│  │  Seeks max APY, │                      │  Challenges every    │    │
│  │  no risk filter │ ──────────────────▶  │  opportunity,        │    │
│  └─────────────────┘   YIELD_OPPORTUNITY  │  Sharpe scoring,     │    │
│           │                               │  PERF_REQUEST cycle  │    │
│           │ YIELD_OPPORTUNITY             └──────────────────────┘    │
│           ▼         RISK_CHALLENGE               │                    │
│  ┌──────────────────────────────────────────────-┘                    │
│  │         ▼                                                          │
│  │  ┌─────────────────┐                                               │
│  │  │PortfolioManager │                                               │
│  │  │  (port 9005)    │                                               │
│  │  │                 │                                               │
│  │  │  Enforces 30%   │                                               │
│  │  │  max position,  │                                               │
│  │  │  arbitrates     │                                               │
│  │  │  yield vs risk  │                                               │
│  │  └─────────────────┘                                               │
└──┴──────────────────────────────────────────────────────────────────-─┘
```

### Agent Roles

| Agent | Port | Goal | Hard Rule |
|---|---|---|---|
| **Orchestrator** | 9002 | Coordinate scan cycles; rank opportunities by APY; dispatch execution | Dispatches to idle agents only |
| **agent1-uniswap** | 9003 | Scan all Uniswap v3 Ethereum pools | Reports top N by APY |
| **agent2-stablecoin** | 9004 | Scan stable-only pairs (USDC/USDT/DAI/FRAX/LUSD) | Reports top N stable opportunities |
| **YieldHunter** | 9006 | Find the highest APY across all protocols | None — pure yield maximiser |
| **PortfolioManager** | 9005 | Maintain diversification while capturing yield | No single position > 30% of portfolio |
| **RiskManager** | 9007 | Maximise risk-adjusted return; challenge every opportunity | Must publish `RISK_CHALLENGE` for every `YIELD_OPPORTUNITY` |

### Message Protocol (AXL send/recv)

All inter-agent communication is raw bytes over the Yggdrasil mesh. No HTTP between agents, no message broker.

**Orchestrator layer**
```
Orchestrator      ──SCAN_REQUEST──▶   agent1-uniswap
Orchestrator      ──SCAN_REQUEST──▶   agent2-stablecoin
agent1-uniswap    ──SCAN_RESULT──▶    Orchestrator
agent2-stablecoin ──SCAN_RESULT──▶    Orchestrator
Orchestrator      ──EXECUTE_COMMAND─▶ best idle agent
```

**Portfolio layer**
```
YieldHunter       ──YIELD_OPPORTUNITY──▶  RiskManager
RiskManager       ──RISK_CHALLENGE──▶     all peers
YieldHunter       ──YIELD_OPPORTUNITY──▶  PortfolioManager
PortfolioManager  ──ALLOCATION_DECISION─▶ all peers
PortfolioManager  ──PORTFOLIO_SNAPSHOT──▶ all peers      (every 90s)
RiskManager       ──PERF_REQUEST──▶       all peers      (every 90s)
all peers         ──PERF_RESPONSE──▶      RiskManager
RiskManager       ──RISK_ASSESSMENT──▶    all peers
```

---

## Smart Contracts

| Contract | Address (Sepolia) | Description |
|---|---|---|
| `ERC7857iNFT` | `0x116185dF3e894580D4A2CAf13D7d10280f56745e` | ERC-721 intelligent NFT representing agent identity; stores encrypted metadata hash and TEE-verified transfer proofs |
| `AgentRegistry` | — | Registers agents, links them to their iNFT, emits execution events |
| `EarnlabMarketplace` | — | Buy, sell, or lease agent iNFTs with a 2.5% protocol fee |
| `MockOracle` | — | Testnet TEE oracle (owner-signed nonce proofs); replace with 0G TEE oracle in production |

### ERC-7857 iNFT

Each agent is backed by an intelligent NFT that extends ERC-721 with:
- **`secureTransfer`** — TEE-oracle-verified ownership transfer with `sealedKey` + `proof`
- **`clone`** — spawn a new agent from an existing strategy
- **`authorizeUsage`** — delegate execution rights without transferring ownership
- **`updateMetadata`** — update the on-chain metadata hash when agent memory changes

---

## Agent Runtime

### Orchestrator + Yield Scanners

The Orchestrator drives a 60-second polling loop:
1. Dispatches `SCAN_REQUEST` to all registered idle scanner agents
2. Collects `SCAN_RESULT` messages; merges and ranks by APY
3. Sends `EXECUTE_COMMAND` to the best idle agent

**agent1-uniswap** queries the DefiLlama Yields API for all Uniswap v3 Ethereum pools, filters by TVL, and returns ranked opportunities.

**agent2-stablecoin** applies the same scan with an additional filter restricting to stable-pair pools (USDC, USDT, DAI, FRAX, LUSD).

### Portfolio Management Agents

**YieldHunter** scans DefiLlama every 60 seconds and broadcasts the top 8 opportunities by APY with no risk filter — it is a pure yield maximiser.

**RiskManager** receives every `YIELD_OPPORTUNITY` and immediately challenges it:
- **APY suspicion**: >50% elevated risk (+20), >200% flagged (+40)
- **TVL liquidity**: <$1M elevated (+15), <$200K flagged (+30)
- **Protocol familiarity**: unknown protocols penalised (+10)

Outputs a `riskScore` (0–100), a Sharpe estimate (`apy / (riskScore/100)`), and a `maxAllocation` that scales from 30% at zero risk to 5% at maximum risk. Broadcasts `RISK_CHALLENGE` to all peers. Also runs a 90-second rating cycle — fans out `PERF_REQUEST`, collects responses, and publishes `RISK_ASSESSMENT` scores for every agent.

**PortfolioManager** waits 10 seconds after receiving a `YIELD_OPPORTUNITY` to collect the corresponding `RISK_CHALLENGE`, then:
1. Declines if RiskManager rejected
2. Caps the allocation at `min(riskMaxAlloc, 30% − currentProtocolExposure)` — the 30% cap is a hard invariant
3. Trims the lowest-yield existing position to make room
4. Broadcasts `ALLOCATION_DECISION` with full reasoning

---

## Frontend

Next.js 14 app with wallet connection (RainbowKit/wagmi), live on-chain reads for agent registry and iNFT metadata, a yield dashboard, and an agent marketplace. Targets Sepolia testnet.

---

## Prerequisites

- Node.js 18+
- Go 1.21+ (for building the AXL node binary)
- OpenSSL (for key generation)
- An Ethereum wallet with Sepolia ETH
- Infura (or similar) RPC endpoint
- KeeperHub API key
- WalletConnect project ID

---

## Setup

### 1. Install dependencies

```bash
npm install          # root workspace
cd agents && npm install
cd ../frontend && npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

| Variable | Description |
|---|---|
| `RPC_URL` | Sepolia RPC endpoint (e.g. Infura/Alchemy) |
| `PRIVATE_KEY` | Deployer/agent wallet private key |
| `KEEPERHUB_API_KEY` | KeeperHub API key |
| `NEXT_PUBLIC_WALLET_CONNECT_ID` | WalletConnect project ID |
| `NEXT_PUBLIC_INFT_ADDRESS` | Deployed `ERC7857iNFT` address |
| `NEXT_PUBLIC_AGENT_REGISTRY_ADDRESS` | Deployed `AgentRegistry` address |
| `NEXT_PUBLIC_MARKETPLACE_ADDRESS` | Deployed `EarnlabMarketplace` address |

### 3. Deploy contracts

```bash
cd contracts
npm run deploy
# or for Sepolia explicitly:
HARDHAT_NETWORK=sepolia npm run deploy
```

Copy the printed addresses into `.env` and `frontend/.env.local`.

### 4. Build the AXL node binary

```bash
# Install Go
wget https://go.dev/dl/go1.24.3.linux-amd64.tar.gz
sudo tar -C /usr/local -xzf go1.24.3.linux-amd64.tar.gz
export PATH=$PATH:/usr/local/go/bin

# Build
git clone https://github.com/gensyn-ai/axl.git ~/axl
cd ~/axl && go build -o node ./cmd/node/
cp ~/axl/node agents/axl/node
```

### 5. Generate node keys

```bash
cd agents/axl/keys
for agent in orchestrator agent1 agent2 executor seeker critic; do
  openssl genpkey -algorithm ed25519 -out "$agent.pem"
done
```

### 6. Start the AXL mesh

```bash
cd agents/axl

# Bootstrap node
./node -config configs/node-orchestrator.json > logs/orchestrator.log 2>&1 &
sleep 1

# Yield scanner nodes
./node -config configs/node-agent1.json > logs/agent1.log 2>&1 &
./node -config configs/node-agent2.json > logs/agent2.log 2>&1 &

# Portfolio agent nodes
./node -config configs/node-executor.json > logs/executor-axl.log 2>&1 &
./node -config configs/node-seeker.json   > logs/seeker-axl.log   2>&1 &
./node -config configs/node-critic.json   > logs/critic-axl.log   2>&1 &
sleep 3

# Verify connectivity (each should show 1+ peers)
for port in 9002 9003 9004 9005 9006 9007; do
  peers=$(curl -s http://127.0.0.1:$port/topology | \
    python3 -c "import sys,json; print(len(json.load(sys.stdin)['peers']))")
  echo "Port $port: $peers peers"
done
```

### 7. Run the agents

**Yield scanner group**
```bash
cd agents
npm run orchestrator    # Terminal 1
npm run agent1          # Terminal 2
npm run agent2          # Terminal 3
```

**Portfolio management group**
```bash
npm run portfolio-manager   # Terminal 4
npm run yield-hunter        # Terminal 5
npm run risk-manager        # Terminal 6
```

### 8. Start the frontend

```bash
cd frontend
npm run dev
# http://localhost:3000
```

---

## AXL Node Configuration

All nodes use `tcp_port: 7000` for the Yggdrasil data plane and different `Listen` ports to avoid conflicts on localhost. Each node's Yggdrasil IPv6 is derived from its Ed25519 key, so port 7000 on each node's virtual address is unique.

| Node | API port | Listen port | Peers to |
|---|---|---|---|
| orchestrator | 9002 | 7000 | — (bootstrap) |
| agent1-uniswap | 9003 | 7001 | orchestrator:7000 |
| agent2-stablecoin | 9004 | 7002 | orchestrator:7000 |
| PortfolioManager (executor) | 9005 | 7003 | orchestrator:7000 |
| YieldHunter (seeker) | 9006 | 7004 | orchestrator:7000 |
| RiskManager (critic) | 9007 | 7005 | orchestrator:7000 |

The `a2a_addr`/`a2a_port` fields on the PortfolioManager node are wired for future upgrade to the Google A2A protocol without changing agent logic.

---

## Agent Configuration

| Variable | Default | Description |
|---|---|---|
| `AGENT_ID` | `0` | Registered agent ID |
| `INFT_TOKEN_ID` | `0` | Linked iNFT token ID |
| `OWNER_ADDRESS` | — | Wallet address that owns the agent |
| `STRATEGY_TYPE` | `yield_farming` | `yield_farming`, `delta_neutral`, `stablecoin_looping` |
| `RISK_PROFILE` | `moderate` | `low`, `moderate`, `high` |
| `MAX_SLIPPAGE_BPS` | `50` | Max swap slippage in basis points |
| `REBALANCE_THRESHOLD_BPS` | `100` | Drift threshold that triggers a rebalance |
| `POLL_INTERVAL_MS` | `60000` | Scan cycle interval in milliseconds |

---

## Testing

```bash
npm test               # all workspaces
cd contracts && npm test   # contracts only
```

## Build

```bash
npm run build
```

---

## Networks

| Network | Chain ID | Notes |
|---|---|---|
| Sepolia | `11155111` | Default testnet — contracts deployed |
| 0G Testnet | `16602` | Agent compute and storage |

---

## Production Upgrade Path

| Mock component | Production replacement |
|---|---|
| `ZeroGCompute` attestation | 0G Compute TEE job → on-chain attestation |
| `ZeroGStorage` CID | 0G Storage upload → real content CID |
| `X402Client` proof | Signed Ethereum tx on Sepolia/mainnet |
| `KeeperHubClient` job | KeeperHub contract → on-chain keeper registration |
| DefiLlama yield scan | Add Curve, Aave, Compound scanners as additional AXL nodes |
| Mock oracle | 0G TEE oracle in `MockOracle.sol` |

Each upgrade is local to one file and does not require changes to the message protocol or agent interaction model.

---

## License

MIT
