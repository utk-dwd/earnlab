/**
 * INFTContractClient — viem-based client for EarnYldAgentINFT.sol.
 *
 * Contract: EarnYldAgentINFT (ERC-7857-style)
 * Network:  0G Galileo testnet (chain ID 16602)
 * Address:  INFT_CONTRACT_ADDRESS env var
 *
 * Deploy the contract with:
 *   cd contracts && npx hardhat run scripts/deploy.ts --network zerog-galileo
 *
 * Provides typed wrappers for:
 *   mintAgent       — create a new agent INFT
 *   clone           — fork a strategy to a new owner
 *   authorizeUsage  — grant execution rights without transfer
 *   updateStorageUri— update 0G Storage pointer after a snapshot
 *   getAgentState   — read on-chain agent state
 *   isAuthorized    — check ownership or delegation
 *   getAgentsByOwner— enumerate tokens owned by an address (off-chain scan)
 */

// ─── Config ───────────────────────────────────────────────────────────────────

export const ZEROG_GALILEO_CHAIN_ID = 16602;
const ZEROG_TESTNET_RPC   = process.env.ZEROG_RPC_URL ?? "https://evmrpc-testnet.0g.ai";
const INFT_ADDRESS        = process.env.INFT_CONTRACT_ADDRESS as `0x${string}` | undefined;
const APP_PRIVATE_KEY     = process.env.APP_WALLET_PRIVATE_KEY as `0x${string}` | undefined;

// ─── ABI ──────────────────────────────────────────────────────────────────────

export const INFT_ABI = [
  // ── Write ──────────────────────────────────────────────────────────────────
  {
    name: "mintAgent", type: "function", stateMutability: "nonpayable",
    inputs: [
      { name: "to",           type: "address" },
      { name: "name",         type: "string"  },
      { name: "strategyType", type: "string"  },
      { name: "riskProfile",  type: "string"  },
      { name: "storageUri",   type: "string"  },
      { name: "version",      type: "string"  },
      { name: "permissions",  type: "tuple",
        components: [
          { name: "canExecute",       type: "bool"  },
          { name: "requiresHITL",     type: "bool"  },
          { name: "maxAllocationPct", type: "uint8" },
        ],
      },
    ],
    outputs: [{ name: "tokenId", type: "uint256" }],
  },
  {
    name: "clone", type: "function", stateMutability: "nonpayable",
    inputs: [{ name: "tokenId", type: "uint256" }, { name: "cloneOwner", type: "address" }],
    outputs: [{ name: "cloneId", type: "uint256" }],
  },
  {
    name: "authorizeUsage", type: "function", stateMutability: "nonpayable",
    inputs: [
      { name: "tokenId",    type: "uint256" },
      { name: "user",       type: "address" },
      { name: "authorized", type: "bool"    },
    ],
    outputs: [],
  },
  {
    name: "updateStorageUri", type: "function", stateMutability: "nonpayable",
    inputs: [{ name: "tokenId", type: "uint256" }, { name: "newUri", type: "string" }],
    outputs: [],
  },
  {
    name: "transferFrom", type: "function", stateMutability: "nonpayable",
    inputs: [
      { name: "from",    type: "address" },
      { name: "to",      type: "address" },
      { name: "tokenId", type: "uint256" },
    ],
    outputs: [],
  },
  // ── Read ───────────────────────────────────────────────────────────────────
  {
    name: "getAgentState", type: "function", stateMutability: "view",
    inputs:  [{ name: "tokenId", type: "uint256" }],
    outputs: [{
      name: "", type: "tuple",
      components: [
        { name: "name",          type: "string"  },
        { name: "strategyType",  type: "string"  },
        { name: "riskProfile",   type: "string"  },
        { name: "storageUri",    type: "string"  },
        { name: "version",       type: "string"  },
        { name: "permissions",   type: "tuple",
          components: [
            { name: "canExecute",       type: "bool"  },
            { name: "requiresHITL",     type: "bool"  },
            { name: "maxAllocationPct", type: "uint8" },
          ],
        },
        { name: "mintedAt",      type: "uint256" },
        { name: "parentTokenId", type: "uint256" },
      ],
    }],
  },
  {
    name: "isAuthorized", type: "function", stateMutability: "view",
    inputs:  [{ name: "tokenId", type: "uint256" }, { name: "user", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "ownerOf", type: "function", stateMutability: "view",
    inputs:  [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
  },
  {
    name: "totalSupply", type: "function", stateMutability: "view",
    inputs:  [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "getAuthorizedUsers", type: "function", stateMutability: "view",
    inputs:  [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "address[]" }],
  },
  // ── Events (for log scanning) ──────────────────────────────────────────────
  {
    name: "AgentMinted", type: "event",
    inputs: [
      { name: "tokenId",      type: "uint256", indexed: true  },
      { name: "owner",        type: "address", indexed: true  },
      { name: "name",         type: "string",  indexed: false },
      { name: "strategyType", type: "string",  indexed: false },
      { name: "storageUri",   type: "string",  indexed: false },
    ],
  },
  {
    name: "Transfer", type: "event",
    inputs: [
      { name: "from",    type: "address", indexed: true },
      { name: "to",      type: "address", indexed: true },
      { name: "tokenId", type: "uint256", indexed: true },
    ],
  },
] as const;

// ─── Chain definition for 0G Galileo testnet ─────────────────────────────────

export const zeroGGalileoChain = {
  id:             ZEROG_GALILEO_CHAIN_ID,
  name:           "0G Galileo Testnet",
  nativeCurrency: { name: "0G", symbol: "0G", decimals: 18 },
  rpcUrls:        { default: { http: [ZEROG_TESTNET_RPC] } },
} as const;

// ─── On-chain agent state type ────────────────────────────────────────────────

export interface OnChainAgentState {
  tokenId:       number;
  owner:         string;
  name:          string;
  strategyType:  string;
  riskProfile:   string;
  storageUri:    string;
  version:       string;
  permissions:   { canExecute: boolean; requiresHITL: boolean; maxAllocationPct: number };
  mintedAt:      number;  // unix seconds
  parentTokenId: number;
}

// ─── Client ───────────────────────────────────────────────────────────────────

export class INFTContractClient {
  private configured = false;

  private check(): boolean {
    if (!INFT_ADDRESS) {
      console.warn("[INFT] INFT_CONTRACT_ADDRESS not set — contract calls will no-op");
      return false;
    }
    if (!APP_PRIVATE_KEY) {
      console.warn("[INFT] APP_WALLET_PRIVATE_KEY not set");
      return false;
    }
    this.configured = true;
    return true;
  }

  private async clients() {
    const { createPublicClient, createWalletClient, http } = await import("viem");
    const { privateKeyToAccount } = await import("viem/accounts");
    const account = privateKeyToAccount(APP_PRIVATE_KEY!);
    const pub = createPublicClient({
      chain: zeroGGalileoChain as any,
      transport: http(ZEROG_TESTNET_RPC),
    });
    const wal = createWalletClient({
      account,
      chain: zeroGGalileoChain as any,
      transport: http(ZEROG_TESTNET_RPC),
    });
    return { pub, wal, account };
  }

  async mintAgent(params: {
    to:           string;
    name:         string;
    strategyType: string;
    riskProfile:  string;
    storageUri:   string;
    version:      string;
    permissions:  { canExecute: boolean; requiresHITL: boolean; maxAllocationPct: number };
  }): Promise<{ tokenId: number; txHash: string } | { error: string }> {
    if (!this.check()) return { error: "Contract not configured" };
    try {
      const { pub, wal, account } = await this.clients();
      const hash = await wal.writeContract({
        address:      INFT_ADDRESS!,
        abi:          INFT_ABI,
        functionName: "mintAgent",
        args: [
          params.to as `0x${string}`,
          params.name,
          params.strategyType,
          params.riskProfile,
          params.storageUri,
          params.version,
          {
            canExecute:       params.permissions.canExecute,
            requiresHITL:     params.permissions.requiresHITL,
            maxAllocationPct: params.permissions.maxAllocationPct,
          },
        ],
        chain: zeroGGalileoChain as any,
      });
      const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 60_000 });
      // Extract tokenId from AgentMinted event log
      const log = receipt.logs.find((l: any) => l.address.toLowerCase() === INFT_ADDRESS!.toLowerCase());
      const tokenId = log?.topics[1] ? Number(BigInt(log.topics[1])) : -1;
      return { tokenId, txHash: hash };
    } catch (err: any) {
      return { error: err?.shortMessage ?? err?.message ?? "Mint failed" };
    }
  }

  async clone(tokenId: number, cloneOwner: string): Promise<{ cloneId: number; txHash: string } | { error: string }> {
    if (!this.check()) return { error: "Contract not configured" };
    try {
      const { pub, wal } = await this.clients();
      const hash = await wal.writeContract({
        address: INFT_ADDRESS!, abi: INFT_ABI, functionName: "clone",
        args: [BigInt(tokenId), cloneOwner as `0x${string}`],
        chain: zeroGGalileoChain as any,
      });
      const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 60_000 });
      const log = receipt.logs[receipt.logs.length - 1];
      const cloneId = log?.topics[1] ? Number(BigInt(log.topics[1])) : -1;
      return { cloneId, txHash: hash };
    } catch (err: any) {
      return { error: err?.shortMessage ?? err?.message ?? "Clone failed" };
    }
  }

  async authorizeUsage(tokenId: number, user: string, authorized: boolean): Promise<{ txHash: string } | { error: string }> {
    if (!this.check()) return { error: "Contract not configured" };
    try {
      const { pub, wal } = await this.clients();
      const hash = await wal.writeContract({
        address: INFT_ADDRESS!, abi: INFT_ABI, functionName: "authorizeUsage",
        args: [BigInt(tokenId), user as `0x${string}`, authorized],
        chain: zeroGGalileoChain as any,
      });
      await pub.waitForTransactionReceipt({ hash, timeout: 60_000 });
      return { txHash: hash };
    } catch (err: any) {
      return { error: err?.shortMessage ?? err?.message ?? "Authorize failed" };
    }
  }

  async updateStorageUri(tokenId: number, newUri: string): Promise<{ txHash: string } | { error: string }> {
    if (!this.check()) return { error: "Contract not configured" };
    try {
      const { pub, wal } = await this.clients();
      const hash = await wal.writeContract({
        address: INFT_ADDRESS!, abi: INFT_ABI, functionName: "updateStorageUri",
        args: [BigInt(tokenId), newUri],
        chain: zeroGGalileoChain as any,
      });
      await pub.waitForTransactionReceipt({ hash, timeout: 60_000 });
      return { txHash: hash };
    } catch (err: any) {
      return { error: err?.shortMessage ?? err?.message ?? "Update URI failed" };
    }
  }

  async transfer(tokenId: number, from: string, to: string): Promise<{ txHash: string } | { error: string }> {
    if (!this.check()) return { error: "Contract not configured" };
    try {
      const { pub, wal } = await this.clients();
      const hash = await wal.writeContract({
        address: INFT_ADDRESS!, abi: INFT_ABI, functionName: "transferFrom",
        args: [from as `0x${string}`, to as `0x${string}`, BigInt(tokenId)],
        chain: zeroGGalileoChain as any,
      });
      await pub.waitForTransactionReceipt({ hash, timeout: 60_000 });
      return { txHash: hash };
    } catch (err: any) {
      return { error: err?.shortMessage ?? err?.message ?? "Transfer failed" };
    }
  }

  async getAgentState(tokenId: number): Promise<OnChainAgentState | null> {
    if (!INFT_ADDRESS) return null;
    try {
      const { createPublicClient, http } = await import("viem");
      const pub = createPublicClient({ chain: zeroGGalileoChain as any, transport: http(ZEROG_TESTNET_RPC) });
      const [state, owner] = await Promise.all([
        pub.readContract({ address: INFT_ADDRESS, abi: INFT_ABI, functionName: "getAgentState", args: [BigInt(tokenId)] }) as any,
        pub.readContract({ address: INFT_ADDRESS, abi: INFT_ABI, functionName: "ownerOf",       args: [BigInt(tokenId)] }) as any,
      ]);
      return {
        tokenId,
        owner:          owner as string,
        name:           state.name,
        strategyType:   state.strategyType,
        riskProfile:    state.riskProfile,
        storageUri:     state.storageUri,
        version:        state.version,
        permissions: {
          canExecute:       state.permissions.canExecute,
          requiresHITL:     state.permissions.requiresHITL,
          maxAllocationPct: Number(state.permissions.maxAllocationPct),
        },
        mintedAt:       Number(state.mintedAt),
        parentTokenId:  Number(state.parentTokenId),
      };
    } catch { return null; }
  }

  async isAuthorized(tokenId: number, user: string): Promise<boolean> {
    if (!INFT_ADDRESS) return false;
    try {
      const { createPublicClient, http } = await import("viem");
      const pub = createPublicClient({ chain: zeroGGalileoChain as any, transport: http(ZEROG_TESTNET_RPC) });
      return await pub.readContract({
        address: INFT_ADDRESS, abi: INFT_ABI, functionName: "isAuthorized",
        args: [BigInt(tokenId), user as `0x${string}`],
      }) as boolean;
    } catch { return false; }
  }

  async totalSupply(): Promise<number> {
    if (!INFT_ADDRESS) return 0;
    try {
      const { createPublicClient, http } = await import("viem");
      const pub = createPublicClient({ chain: zeroGGalileoChain as any, transport: http(ZEROG_TESTNET_RPC) });
      const n = await pub.readContract({ address: INFT_ADDRESS, abi: INFT_ABI, functionName: "totalSupply" });
      return Number(n);
    } catch { return 0; }
  }

  /** Scan Transfer events to find all tokens currently owned by `owner`. */
  async getTokensByOwner(owner: string): Promise<OnChainAgentState[]> {
    if (!INFT_ADDRESS) return [];
    try {
      const total = await this.totalSupply();
      if (total === 0) return [];
      const states: OnChainAgentState[] = [];
      // Check each token (practical for small supplies; replace with event scan for > 100 tokens)
      const checks = Array.from({ length: total }, (_, i) => i + 1);
      await Promise.all(checks.map(async id => {
        const s = await this.getAgentState(id);
        if (s && s.owner.toLowerCase() === owner.toLowerCase()) states.push(s);
      }));
      return states.sort((a, b) => a.tokenId - b.tokenId);
    } catch { return []; }
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

export const inftClient = new INFTContractClient();
