# Earnlab

Autonomous DeFi yield optimization powered by AI agents. Earnlab deploys on-chain agents that continuously monitor Uniswap v3 liquidity pools, rank opportunities using 0G Compute, rebalance positions via KeeperHub, and persist state to 0G Storage — all without manual intervention.

## Architecture

```
earnTest1/
├── contracts/   Solidity smart contracts (Hardhat)
├── agents/      TypeScript agent runtime
└── frontend/    Next.js dashboard (wagmi + RainbowKit)
```

### Smart Contracts

| Contract | Description |
|---|---|
| `ERC7857iNFT` | ERC-721 "intelligent NFT" that represents an agent identity and stores a metadata hash on-chain |
| `AgentRegistry` | Registers agents, links them to their iNFT, and emits execution events |
| `EarnlabMarketplace` | Buy, sell, or lease agent iNFTs with a 2.5% protocol fee |

### Agent Runtime

The agent runs a polling loop (default 60 s) that:
1. Scans Uniswap v3 pools for yield opportunities via `YieldDiscovery`
2. Ranks them using 0G Compute (`ZeroGCompute`)
3. Triggers a rebalance through KeeperHub (`KeeperHubClient`)
4. Persists updated memory (execution history) to 0G Storage

### Frontend

Next.js 14 app with wallet connection (RainbowKit/wagmi), a yield dashboard, and an agent marketplace. Targets Sepolia testnet.

## Prerequisites

- Node.js 18+
- An Ethereum wallet with Sepolia ETH
- Infura (or similar) RPC endpoint
- KeeperHub API key
- WalletConnect project ID

## Setup

**1. Install dependencies**

```bash
npm install
```

**2. Configure environment**

```bash
cp .env.example .env
```

Edit `.env` and fill in:

| Variable | Description |
|---|---|
| `RPC_URL` | Sepolia RPC endpoint (e.g. Infura) |
| `PRIVATE_KEY` | Deployer/agent wallet private key |
| `KEEPERHUB_API_KEY` | KeeperHub API key |
| `NEXT_PUBLIC_WALLET_CONNECT_ID` | WalletConnect project ID |

The Uniswap v3 addresses and 0G endpoints are pre-filled with their public values.

**3. Deploy contracts**

```bash
npm run deploy
# or target a specific network:
HARDHAT_NETWORK=sepolia npm run deploy
```

After deployment, copy the printed contract addresses into `.env`:

```
AGENT_REGISTRY_ADDRESS=0x...
MARKETPLACE_ADDRESS=0x...
INFT_ADDRESS=0x...
```

Also set the same three `NEXT_PUBLIC_*` variants in `frontend/.env.local`.

## Running

### Frontend (development)

```bash
cd frontend
npm run dev
# opens at http://localhost:3000
```

### Agent runtime

Mint an iNFT, register an agent, then start the loop:

```bash
cd agents
npm start
```

Configure agent behaviour via `.env`:

| Variable | Default | Description |
|---|---|---|
| `AGENT_ID` | `0` | Registered agent ID |
| `INFT_TOKEN_ID` | `0` | Linked iNFT token ID |
| `OWNER_ADDRESS` | — | Wallet address that owns the agent |
| `STRATEGY_TYPE` | `yield_farming` | Strategy (`yield_farming`, `delta_neutral`, `stablecoin_looping`) |
| `RISK_PROFILE` | `moderate` | Risk tolerance (`low`, `moderate`, `high`) |
| `MAX_SLIPPAGE_BPS` | `50` | Max swap slippage in basis points |
| `REBALANCE_THRESHOLD_BPS` | `100` | Drift threshold that triggers a rebalance |
| `POLL_INTERVAL_MS` | `60000` | Polling interval in milliseconds |

## Testing

```bash
# All workspaces
npm test

# Contracts only
cd contracts && npm test
```

## Build

```bash
npm run build
```

## Networks

| Network | Chain ID | Notes |
|---|---|---|
| Sepolia | `11155111` | Default testnet |
| 0G Testnet | — | Agent compute & storage |
