import {
  createPublicClient,
  http,
  keccak256,
  encodeAbiParameters,
  parseAbiParameters,
  parseAbi,
  parseAbiItem,
  type PublicClient,
} from "viem";
import axios from "axios";
// Uniswap v4 SDK — hook flag decoding, pool key utilities
import { hookFlagIndex } from "@uniswap/v4-sdk";
import {
  ALL_CHAINS,
  KNOWN_TOKENS,
  FEE_TIERS,
  TICK_SPACINGS,
  ETH_ADDRESS,
  type ChainConfig,
  type FeeTier,
} from "../config/chains";

// ─── ABIs ────────────────────────────────────────────────────────────────────
const STATE_VIEW_ABI = parseAbi([
  "function getSlot0(bytes32 poolId) external view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
  "function getLiquidity(bytes32 poolId) external view returns (uint128 liquidity)",
]);

const INITIALIZE_EVENT = parseAbiItem(
  "event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)"
);
const SWAP_EVENT = parseAbiItem(
  "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)"
);

// ─── DefiLlama chain name → chainId ──────────────────────────────────────────
const DEFILLAMA_CHAIN: Record<string, number> = {
  Ethereum:      1,
  Unichain:      130,
  Optimism:      10,
  Base:          8453,
  "Arbitrum":    42161,
  Polygon:       137,
  Blast:         81457,
  Avalanche:     43114,
  "BSC":         56,
  Celo:          42220,
  Zora:          7777777,
};

// ─── Types ───────────────────────────────────────────────────────────────────
export interface PoolKey {
  currency0:   `0x${string}`;
  currency1:   `0x${string}`;
  fee:         number;
  tickSpacing: number;
  hooks:       `0x${string}`;
}

export interface PoolState {
  poolId:       `0x${string}`;
  poolKey:      PoolKey;
  chainId:      number;
  chainName:    string;
  network:      "mainnet" | "testnet";
  sqrtPriceX96: bigint;
  tick:         number;
  liquidity:    bigint;
  tvlUsd:       number;
  volume24hUsd: number;
  liveAPY:      number;
  referenceAPY: number;
  token0Symbol: string;
  token1Symbol: string;
  token0Price:  number;
  token1Price:  number;
  /** "onchain" = StateView read succeeded; "defillama" = fallback data */
  dataSource:   "onchain" | "defillama";
  /** Active v4 hook callbacks decoded from the hooks address lower 14 bits */
  hookFlags:       string[];
  /** True when the pool has a non-zero hooks address (custom logic applied) */
  hasCustomHooks:  boolean;
  lastUpdated:  number;
}

// ─── Hook flag decoding (Uniswap v4 SDK) ────────────────────────────────────
/**
 * Decodes the active hook callbacks for a Uniswap v4 pool by inspecting the
 * lower 14 bits of the hooks contract address.
 *
 * Per the v4 spec the hooks address is mined such that bit N is set iff the
 * corresponding callback (from hookFlagIndex) is implemented by the contract.
 * A zero/ETH address means no hooks — the pool is a vanilla concentrated LP.
 */
export function decodeHookFlags(hooksAddress: string): string[] {
  const NULL_HOOK = "0x0000000000000000000000000000000000000000";
  if (!hooksAddress || hooksAddress === NULL_HOOK) return [];

  const addrNum = BigInt(hooksAddress);
  const active: string[] = [];
  for (const [name, bit] of Object.entries(hookFlagIndex)) {
    if ((addrNum >> BigInt(bit)) & 1n) active.push(name);
  }
  return active;
}

// ─── The Graph — Uniswap v4 subgraph (optional enrichment) ───────────────────
// Set THEGRAPH_API_KEY in .env to enable. Falls back to DefiLlama-only when absent.
// Subgraph IDs per chain (The Graph Network decentralised service):
//   Ethereum mainnet: GqzP4Xaehti8KSfQmv3ZctFSjnSUYZ4En5NRsiTbvZpz
//   Unichain:         Coming soon (use gateway.thegraph.com when available)
//
// Query returns pool-level fee, volume, TVL, txCount for post-scan enrichment.

const THEGRAPH_API_KEY = process.env.THEGRAPH_API_KEY ?? "";

const THEGRAPH_SUBGRAPH: Partial<Record<number, string>> = {
  1:    "GqzP4Xaehti8KSfQmv3ZctFSjnSUYZ4En5NRsiTbvZpz",  // Ethereum mainnet
  8453: "HMuAwufqZ1YCRmzL2NcL8A9F5e5JmFNLFRFiSnMjnFqX",  // Base
};

interface GraphPoolResult {
  id:           string;
  feeTier:      string;
  totalValueLockedUSD: string;
  volumeUSD:    string;
  txCount:      string;
}

let graphCache = new Map<string, { data: GraphPoolResult; ts: number }>();

/**
 * Fetches volume and TVL from The Graph's Uniswap v4 subgraph for a specific
 * pool. Returns null when no API key is configured or the subgraph query fails.
 */
export async function fetchGraphPoolData(chainId: number, poolId: string): Promise<GraphPoolResult | null> {
  if (!THEGRAPH_API_KEY) return null;
  const subgraphId = THEGRAPH_SUBGRAPH[chainId];
  if (!subgraphId) return null;

  const cacheKey = `${chainId}:${poolId}`;
  const cached   = graphCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < 300_000) return cached.data;

  const url   = `https://gateway.thegraph.com/api/${THEGRAPH_API_KEY}/subgraphs/id/${subgraphId}`;
  const query = `{ pool(id: "${poolId.toLowerCase()}") { id feeTier totalValueLockedUSD volumeUSD txCount } }`;

  try {
    const resp = await axios.post(url, { query }, { timeout: 8_000 });
    const pool: GraphPoolResult | null = resp.data?.data?.pool ?? null;
    if (pool) {
      graphCache.set(cacheKey, { data: pool, ts: Date.now() });
      return pool;
    }
  } catch { /* network failure — degrade gracefully */ }
  return null;
}

// ─── DefiLlama fetch (cached 5 min) ──────────────────────────────────────────
let llamaCache:   any[]  = [];
let llamaCacheTs: number = 0;

async function fetchLlama(): Promise<any[]> {
  if (llamaCache.length > 0 && Date.now() - llamaCacheTs < 300_000) return llamaCache;
  try {
    const r = await axios.get("https://yields.llama.fi/pools", { timeout: 10_000 });
    llamaCache   = r.data?.data ?? [];
    llamaCacheTs = Date.now();
  } catch { /* keep stale cache on failure */ }
  return llamaCache;
}

// Minimum TVL to include a pool — filters out micro-cap memecoin noise
const MIN_TVL_USD = 500_000; // $500K

// DefiLlama chain name for each mainnet chainId
const CHAIN_TO_LLAMA: Record<number, string> = {
  1:       "Ethereum",
  130:     "Unichain",
  10:      "Optimism",
  8453:    "Base",
  42161:   "Arbitrum",
  137:     "Polygon",
  81457:   "Blast",
  43114:   "Avalanche",
  56:      "BSC",
  42220:   "Celo",
  7777777: "Zora",
  480:     "Worldchain",
  57073:   "Ink",
  1868:    "Soneium",
};

// Testnet → corresponding mainnet chainId (for reference APY lookup)
const TESTNET_TO_MAINNET: Record<number, number> = {
  11155111: 1,       // Sepolia       → Ethereum
  84532:    8453,    // Base Sepolia   → Base
  421614:   42161,   // Arb Sepolia    → Arbitrum
  1301:     130,     // Unichain Sep   → Unichain
};

/** Build PoolState entries from DefiLlama (no RPC needed).
 *
 *  Mainnet chains  → real DefiLlama pools, TVL-filtered, known-token-filtered.
 *  Testnet chains  → reference APY only: look up same pair on corresponding
 *                    mainnet chain and mark as apySource="reference".
 */
async function defiLlamaPoolsForChain(cfg: ChainConfig): Promise<PoolState[]> {
  const all = await fetchLlama();

  // Which chainId to query in DefiLlama?
  const lookupChainId = cfg.network === "testnet"
    ? TESTNET_TO_MAINNET[cfg.chainId]   // testnet → mainnet equivalent
    : cfg.chainId;

  if (!lookupChainId) return []; // no mainnet equivalent known

  const llamaChainName = CHAIN_TO_LLAMA[lookupChainId];
  if (!llamaChainName) return [];

  // Known tokens for the actual chain (testnet tokens for key building)
  const tokens     = KNOWN_TOKENS[cfg.chainId] ?? {};
  const knownSyms  = new Set(Object.values(tokens).map((t) => t.symbol.toUpperCase()));

  const matches = all.filter((p: any) => {
    if (p.project !== "uniswap-v4") return false;
    if (p.chain !== llamaChainName) return false;
    if ((p.tvlUsd ?? 0) < MIN_TVL_USD) return false;       // ← TVL floor

    // Both tokens must be in our known-token list for this chain
    const [sym0, sym1] = (p.symbol ?? "").toUpperCase().split("-");
    if (!sym0 || !sym1) return false;
    if (!knownSyms.has(sym0) && sym0 !== "ETH") return false;
    if (!knownSyms.has(sym1) && sym1 !== "ETH") return false;

    return true;
  });

  return matches.map((p: any): PoolState => {
    const [sym0raw, sym1raw] = (p.symbol ?? "?-?").split("-");
    const sym0 = sym0raw ?? "?";
    const sym1 = sym1raw ?? "?";
    const fee  = p.feeTier ?? 3000;

    const t0 = Object.values(tokens).find((t) => t.symbol.toUpperCase() === sym0.toUpperCase());
    const t1 = Object.values(tokens).find((t) => t.symbol.toUpperCase() === sym1.toUpperCase());

    const poolKey: PoolKey = {
      currency0:   (t0?.address ?? ETH_ADDRESS) as `0x${string}`,
      currency1:   (t1?.address ?? ETH_ADDRESS) as `0x${string}`,
      fee,
      tickSpacing: TICK_SPACINGS[fee as FeeTier] ?? 60,
      hooks:       ETH_ADDRESS,
    };

    // Use the real pool ID for mainnet; for testnet use computed key
    const poolId = cfg.network === "mainnet"
      ? ((p.pool ?? computePoolId(poolKey)) as `0x${string}`)
      : (`testnet-ref-${cfg.chainId}-${computePoolId(poolKey)}` as `0x${string}`);

    return {
      poolId,
      poolKey,
      chainId:      cfg.chainId,
      chainName:    cfg.name,
      network:      cfg.network,
      sqrtPriceX96: 0n,
      tick:         0,
      liquidity:    0n,
      tvlUsd:       cfg.network === "mainnet" ? (p.tvlUsd ?? 0) : 0,
      volume24hUsd: cfg.network === "mainnet" ? (p.volumeUsd1d ?? 0) : 0,
      liveAPY:      0,
      referenceAPY: p.apy ?? 0,
      token0Symbol: sym0,
      token1Symbol: sym1,
      token0Price:    0,
      token1Price:    0,
      dataSource:     "defillama",
      hookFlags:      decodeHookFlags(poolKey.hooks),
      hasCustomHooks: poolKey.hooks !== ETH_ADDRESS,
      lastUpdated:    Date.now(),
    };
  });
}

// ─── Price cache ─────────────────────────────────────────────────────────────
const priceCache = new Map<string, { price: number; ts: number }>();

async function fetchTokenPrice(chainId: number, tokenAddress: `0x${string}`): Promise<number> {
  const isEth = tokenAddress === ETH_ADDRESS ||
    tokenAddress.toLowerCase() === "0x4200000000000000000000000000000000000006" ||
    tokenAddress.toLowerCase() === "0xfff9976782d46cc05630d1f6ebab18b2324d6b14";

  const slugMap: Record<number, string> = {
    1: "ethereum", 8453: "base", 42161: "arbitrum",
    10: "optimism", 137: "polygon", 130: "ethereum",
  };
  const slug     = slugMap[chainId] ?? "ethereum";
  const cacheKey = isEth ? "eth" : `${slug}:${tokenAddress.toLowerCase()}`;
  const cached   = priceCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < 60_000) return cached.price;

  try {
    const coinsKey = isEth ? "coingecko:ethereum" : `${slug}:${tokenAddress}`;
    const resp = await axios.get(`https://coins.llama.fi/prices/current/${coinsKey}`, { timeout: 5_000 });
    const price: number = resp.data?.coins?.[coinsKey]?.price ?? 0;
    priceCache.set(cacheKey, { price, ts: Date.now() });
    return price;
  } catch {
    return 0;
  }
}

// ─── Pool ID ─────────────────────────────────────────────────────────────────
export function computePoolId(key: PoolKey): `0x${string}` {
  return keccak256(
    encodeAbiParameters(
      parseAbiParameters("address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks"),
      [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]
    )
  );
}

// ─── TVL from liquidity + price ───────────────────────────────────────────────
function liquidityToTVL(
  liquidity: bigint, sqrtPriceX96: bigint,
  p0: number, p1: number, d0: number, d1: number
): number {
  if (!liquidity || !sqrtPriceX96) return 0;
  const Q96  = 2n ** 96n;
  const amt0 = Number((liquidity * Q96) / sqrtPriceX96) / Math.pow(10, d0);
  const amt1 = Number((liquidity * sqrtPriceX96) / Q96) / Math.pow(10, d1);
  return amt0 * p0 + amt1 * p1;
}

// ─── 24h volume from Swap events ─────────────────────────────────────────────
async function getVolume24h(
  client: PublicClient, poolManager: `0x${string}`,
  poolId: `0x${string}`, blockTime: number, p0: number, d0: number
): Promise<number> {
  const blocksPerDay = Math.ceil(86400 / blockTime);
  try {
    const latest = await client.getBlockNumber();
    const logs   = await client.getLogs({
      address: poolManager, event: SWAP_EVENT,
      args: { id: poolId },
      fromBlock: latest - BigInt(blocksPerDay),
      toBlock:   latest,
    });
    let total = 0n;
    for (const log of logs) {
      const a = log.args.amount0;
      if (a != null) total += a < 0n ? -a : a;
    }
    return (Number(total) / Math.pow(10, d0)) * p0;
  } catch { return 0; }
}

// ─── On-chain scan for a single chain ────────────────────────────────────────
async function onchainScan(cfg: ChainConfig): Promise<PoolState[]> {
  const client = createPublicClient({
    chain: cfg.chain, transport: http(cfg.rpcUrl, { timeout: 8_000 }),
  }) as any as PublicClient;

  // Discover pools from Initialize events (last 7 days)
  const blocksToScan = Math.ceil((7 * 86400) / cfg.blockTime);
  let discovered: PoolKey[] = [];
  try {
    const latest = await client.getBlockNumber();
    const logs   = await client.getLogs({
      address:   cfg.contracts.poolManager,
      event:     INITIALIZE_EVENT,
      fromBlock: latest - BigInt(blocksToScan),
      toBlock:   latest,
    });
    discovered = logs.map((log) => ({
      currency0:   log.args.currency0 as `0x${string}`,
      currency1:   log.args.currency1 as `0x${string}`,
      fee:         Number(log.args.fee),
      tickSpacing: Number(log.args.tickSpacing),
      hooks:       log.args.hooks as `0x${string}`,
    }));
  } catch { /* RPC failed — continue with seed only */ }

  // Seed well-known pairs
  const tokens    = KNOWN_TOKENS[cfg.chainId] ?? {};
  const tokenList = Object.values(tokens);
  const seedKeys: PoolKey[] = [];
  for (let i = 0; i < tokenList.length; i++) {
    for (let j = i + 1; j < tokenList.length; j++) {
      const [t0, t1] = [tokenList[i], tokenList[j]].sort(
        (a, b) => (a.address.toLowerCase() < b.address.toLowerCase() ? -1 : 1)
      );
      for (const fee of FEE_TIERS) {
        seedKeys.push({ currency0: t0.address, currency1: t1.address, fee,
                        tickSpacing: TICK_SPACINGS[fee as FeeTier], hooks: ETH_ADDRESS });
      }
    }
  }

  // Deduplicate
  const seen    = new Set(seedKeys.map(computePoolId));
  const allKeys = [...seedKeys];
  for (const k of discovered) {
    const id = computePoolId(k);
    if (!seen.has(id)) { seen.add(id); allKeys.push(k); }
  }

  function tokenMeta(addr: `0x${string}`) {
    return Object.values(tokens).find(
      (t) => t.address.toLowerCase() === addr.toLowerCase()
    ) ?? { symbol: addr.slice(0, 6), decimals: 18 };
  }

  const results: PoolState[] = [];

  // Process in batches of 5
  for (let i = 0; i < allKeys.length; i += 5) {
    const batch = allKeys.slice(i, i + 5);
    const settled = await Promise.allSettled(
      batch.map(async (key): Promise<PoolState | null> => {
        const poolId = computePoolId(key);
        let slot0: any, liquidity: bigint;
        try {
          [slot0, liquidity] = await Promise.all([
            client.readContract({ address: cfg.contracts.stateView, abi: STATE_VIEW_ABI,
              functionName: "getSlot0", args: [poolId] }),
            client.readContract({ address: cfg.contracts.stateView, abi: STATE_VIEW_ABI,
              functionName: "getLiquidity", args: [poolId] }),
          ]);
        } catch { return null; }

        if (!slot0?.sqrtPriceX96 || slot0.sqrtPriceX96 === 0n) return null;

        const m0 = tokenMeta(key.currency0);
        const m1 = tokenMeta(key.currency1);
        const [p0, p1] = await Promise.all([
          fetchTokenPrice(cfg.chainId, key.currency0),
          fetchTokenPrice(cfg.chainId, key.currency1),
        ]);

        const tvlUsd      = liquidityToTVL(liquidity as bigint, slot0.sqrtPriceX96, p0, p1, m0.decimals, m1.decimals);
        const volume24hUsd = await getVolume24h(client, cfg.contracts.poolManager, poolId, cfg.blockTime, p0, m0.decimals);
        const dailyFees   = volume24hUsd * (key.fee / 1_000_000);
        const liveAPY     = tvlUsd > 1000 ? (dailyFees / tvlUsd) * 365 * 100 : 0;

        return {
          poolId, poolKey: key, chainId: cfg.chainId, chainName: cfg.name, network: cfg.network,
          sqrtPriceX96: slot0.sqrtPriceX96 as bigint, tick: slot0.tick as number,
          liquidity: liquidity as bigint, tvlUsd, volume24hUsd, liveAPY, referenceAPY: 0,
          token0Symbol: m0.symbol, token1Symbol: m1.symbol,
          token0Price: p0, token1Price: p1,
          dataSource: "onchain",
          hookFlags:      decodeHookFlags(key.hooks),
          hasCustomHooks: key.hooks !== ETH_ADDRESS,
          lastUpdated: Date.now(),
        };
      })
    );
    for (const r of settled)
      if (r.status === "fulfilled" && r.value) results.push(r.value);
  }

  return results;
}

// ─── Public scanner ───────────────────────────────────────────────────────────
export class UniswapV4Scanner {
  async scanAllChains(network?: "mainnet" | "testnet"): Promise<PoolState[]> {
    const chains = network ? ALL_CHAINS.filter((c) => c.network === network) : ALL_CHAINS;

    // Run DefiLlama (fast, always works) + on-chain (slower, may fail) in parallel
    const [llamaResults, onchainResults] = await Promise.all([
      Promise.allSettled(chains.map(defiLlamaPoolsForChain)),
      Promise.allSettled(chains.map(onchainScan)),
    ]);

    // Flatten DefiLlama pools
    const llamaMap = new Map<string, PoolState>();
    for (const r of llamaResults)
      if (r.status === "fulfilled") for (const p of r.value) llamaMap.set(p.poolId, p);

    // Overwrite with on-chain data where available (it's more accurate)
    for (const r of onchainResults)
      if (r.status === "fulfilled") for (const p of r.value) llamaMap.set(p.poolId, p);

    const all = Array.from(llamaMap.values()).filter(
      (p) => p.referenceAPY > 0 || p.liveAPY > 0 || p.tvlUsd > 0
    );

    return all
      .sort((a, b) => {
        const sa = a.liveAPY > 0 ? a.liveAPY : a.referenceAPY * 0.01;
        const sb = b.liveAPY > 0 ? b.liveAPY : b.referenceAPY * 0.01;
        return sb - sa;
      });
  }

  async scanMainnet():  Promise<PoolState[]> { return this.scanAllChains("mainnet"); }
  async scanTestnets(): Promise<PoolState[]> { return this.scanAllChains("testnet"); }

  async scanChain(chainId: number): Promise<PoolState[]> {
    const cfg = ALL_CHAINS.find((c) => c.chainId === chainId);
    if (!cfg) throw new Error(`Chain ${chainId} not supported`);
    const [llama, onchain] = await Promise.all([
      defiLlamaPoolsForChain(cfg),
      onchainScan(cfg),
    ]);
    const map = new Map<string, PoolState>();
    for (const p of llama)   map.set(p.poolId, p);
    for (const p of onchain) map.set(p.poolId, p);
    return Array.from(map.values());
  }
}
