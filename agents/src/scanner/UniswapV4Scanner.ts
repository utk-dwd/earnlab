import {
  createPublicClient,
  http,
  keccak256,
  encodeAbiParameters,
  parseAbiParameters,
  parseAbi,
  formatUnits,
  type PublicClient,
} from "viem";
import axios from "axios";
import {
  ALL_CHAINS,
  MAINNET_CHAINS,
  TESTNET_CHAINS,
  KNOWN_TOKENS,
  FEE_TIERS,
  TICK_SPACINGS,
  ETH_ADDRESS,
  type ChainConfig,
  type FeeTier,
} from "../config/chains";

// ─── ABIs (minimal) ──────────────────────────────────────────────────────────
const STATE_VIEW_ABI = parseAbi([
  "function getSlot0(bytes32 poolId) external view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
  "function getLiquidity(bytes32 poolId) external view returns (uint128 liquidity)",
]);

const POOL_MANAGER_ABI = parseAbi([
  "event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)",
  "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)",
]);

// ─── Types ───────────────────────────────────────────────────────────────────
export interface PoolKey {
  currency0: `0x${string}`;
  currency1: `0x${string}`;
  fee: number;
  tickSpacing: number;
  hooks: `0x${string}`;
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
  /** USD value of total liquidity in pool */
  tvlUsd:       number;
  /** Raw volume in USD over last 24h (from on-chain Swap events) */
  volume24hUsd: number;
  /** On-chain APY computed from fee income / TVL */
  liveAPY:      number;
  /** Mainnet reference APY for same pair from DefiLlama (0 if not found) */
  referenceAPY: number;
  token0Symbol: string;
  token1Symbol: string;
  token0Price:  number; // USD
  token1Price:  number; // USD
  lastUpdated:  number;
}

// ─── Price cache (CoinGecko-compatible via DefiLlama) ────────────────────────
const priceCache = new Map<string, { price: number; ts: number }>();
const PRICE_TTL_MS = 60_000;

async function fetchTokenPrice(
  chainId: number,
  tokenAddress: `0x${string}`
): Promise<number> {
  // ETH/WETH → use ethereum native price
  const isEth =
    tokenAddress === ETH_ADDRESS ||
    tokenAddress.toLowerCase() === "0x4200000000000000000000000000000000000006" || // OP-stack WETH
    tokenAddress.toLowerCase() === "0xfff9976782d46cc05630d1f6ebab18b2324d6b14";  // Sepolia WETH

  const chainSlug: Record<number, string> = {
    11155111: "ethereum",
    84532:    "base",
    421614:   "arbitrum",
    1301:     "ethereum",
  };
  const slug = chainSlug[chainId] ?? "ethereum";

  const cacheKey = isEth ? "eth" : `${slug}:${tokenAddress.toLowerCase()}`;
  const cached = priceCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < PRICE_TTL_MS) return cached.price;

  try {
    // DefiLlama prices API — free, no key required
    const coinsKey = isEth ? "coingecko:ethereum" : `${slug}:${tokenAddress}`;
    const resp = await axios.get(
      `https://coins.llama.fi/prices/current/${coinsKey}`,
      { timeout: 5000 }
    );
    const price: number = resp.data?.coins?.[coinsKey]?.price ?? 0;
    priceCache.set(cacheKey, { price, ts: Date.now() });
    return price;
  } catch {
    return 0;
  }
}

// ─── DefiLlama reference APY for mainnet same-pair ──────────────────────────
let defiLlamaCache: any[] | null = null;
let defiLlamaCacheTs = 0;

async function fetchDefiLlamaReferenceAPY(
  symbol0: string,
  symbol1: string,
  feeTier: number
): Promise<number> {
  // Refresh at most once per 5 min
  if (!defiLlamaCache || Date.now() - defiLlamaCacheTs > 300_000) {
    try {
      const resp = await axios.get("https://yields.llama.fi/pools", { timeout: 8000 });
      defiLlamaCache = resp.data?.data ?? [];
      defiLlamaCacheTs = Date.now();
    } catch {
      return 0;
    }
  }

  const feeStr = (feeTier / 10_000).toFixed(2); // e.g. "0.30" for 3000
  const pair = [symbol0, symbol1].sort().join("-").toUpperCase();
  const match = defiLlamaCache!.find((p: any) => {
    const poolPair = (p.symbol ?? "").toUpperCase().replace("/", "-");
    return (
      p.project === "uniswap-v4" &&
      p.chain === "Ethereum" &&
      poolPair === pair &&
      Math.abs((p.feeTier ?? 0) - feeTier) < 100
    );
  });
  return match?.apy ?? 0;
}

// ─── Pool ID computation ─────────────────────────────────────────────────────
export function computePoolId(key: PoolKey): `0x${string}` {
  return keccak256(
    encodeAbiParameters(
      parseAbiParameters("address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks"),
      [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]
    )
  );
}

// ─── TVL from on-chain liquidity + price ────────────────────────────────────
function sqrtPriceX96ToPrice(sqrtPriceX96: bigint, decimals0: number, decimals1: number): number {
  // price1in0 = (sqrtPriceX96 / 2^96)^2 * 10^(decimals0-decimals1)
  const Q96 = 2n ** 96n;
  const ratio = Number(sqrtPriceX96) / Number(Q96);
  return ratio * ratio * Math.pow(10, decimals0 - decimals1);
}

function liquidityToTVL(
  liquidity: bigint,
  sqrtPriceX96: bigint,
  token0Price: number,
  token1Price: number,
  decimals0: number,
  decimals1: number
): number {
  if (liquidity === 0n || sqrtPriceX96 === 0n) return 0;
  const Q96 = 2n ** 96n;
  // Approximate: treat full-range position
  // amount0 ≈ L * 2^96 / sqrtPriceX96
  // amount1 ≈ L * sqrtPriceX96 / 2^96
  const amt0 = Number((liquidity * Q96) / sqrtPriceX96) / Math.pow(10, decimals0);
  const amt1 = Number((liquidity * sqrtPriceX96) / Q96) / Math.pow(10, decimals1);
  return amt0 * token0Price + amt1 * token1Price;
}

// ─── Volume from Swap events (last 24 h) ────────────────────────────────────
async function getVolume24h(
  client: PublicClient,
  poolManagerAddress: `0x${string}`,
  poolId: `0x${string}`,
  blockTime: number,
  token0Price: number,
  decimals0: number
): Promise<number> {
  const blocksPerDay = Math.ceil(86400 / blockTime);
  try {
    const latest = await client.getBlockNumber();
    const fromBlock = latest - BigInt(blocksPerDay);

    const logs = await client.getLogs({
      address: poolManagerAddress,
      event: POOL_MANAGER_ABI[1] as any, // Swap event
      args: { id: poolId } as any,
      fromBlock: fromBlock > 0n ? fromBlock : 0n,
      toBlock: latest,
    });

    let totalAmount0 = 0n;
    for (const log of logs) {
      const args = log.args as any;
      if (args?.amount0) {
        totalAmount0 += args.amount0 < 0n ? -args.amount0 : args.amount0;
      }
    }
    const volumeToken0 = Number(totalAmount0) / Math.pow(10, decimals0);
    return volumeToken0 * token0Price;
  } catch {
    return 0;
  }
}

// ─── Discover pools via Initialize events (recent blocks only) ───────────────
async function discoverPools(
  client: PublicClient,
  poolManagerAddress: `0x${string}`,
  chainId: number,
  blockTime: number
): Promise<PoolKey[]> {
  const blocksToScan = Math.ceil((7 * 86400) / blockTime); // last 7 days
  try {
    const latest = await client.getBlockNumber();
    const fromBlock = latest - BigInt(blocksToScan);

    const logs = await client.getLogs({
      address: poolManagerAddress,
      event: POOL_MANAGER_ABI[0] as any, // Initialize event
      fromBlock: fromBlock > 0n ? fromBlock : 0n,
      toBlock: latest,
    });

    return logs.map((log) => {
      const args = log.args as any;
      return {
        currency0:   args.currency0 as `0x${string}`,
        currency1:   args.currency1 as `0x${string}`,
        fee:         Number(args.fee),
        tickSpacing: Number(args.tickSpacing),
        hooks:       args.hooks as `0x${string}`,
      };
    });
  } catch {
    return [];
  }
}

// ─── Build well-known seed pool keys for each chain ─────────────────────────
function seedPoolKeys(chainId: number): PoolKey[] {
  const tokens = KNOWN_TOKENS[chainId];
  if (!tokens) return [];

  const keys: PoolKey[] = [];
  const tokenList = Object.values(tokens);

  for (let i = 0; i < tokenList.length; i++) {
    for (let j = i + 1; j < tokenList.length; j++) {
      // Sort by address (v4 requires currency0 < currency1)
      const [t0, t1] = [tokenList[i], tokenList[j]].sort((a, b) =>
        a.address.toLowerCase() < b.address.toLowerCase() ? -1 : 1
      );
      for (const fee of FEE_TIERS) {
        keys.push({
          currency0:   t0.address,
          currency1:   t1.address,
          fee,
          tickSpacing: TICK_SPACINGS[fee as FeeTier],
          hooks:       ETH_ADDRESS,
        });
      }
    }
  }
  return keys;
}

// ─── Scan a single chain ─────────────────────────────────────────────────────
async function scanChain(cfg: ChainConfig): Promise<PoolState[]> {
  const client = createPublicClient({
    chain: cfg.chain,
    transport: http(cfg.rpcUrl),
  });

  // Merge seed pools + discovered pools (deduplicate by poolId)
  const seedKeys = seedPoolKeys(cfg.chainId);
  const discovered = await discoverPools(
    client as any,
    cfg.contracts.poolManager,
    cfg.chainId,
    cfg.blockTime
  );

  const allKeys = [...seedKeys];
  const seenIds = new Set(seedKeys.map(computePoolId));
  for (const key of discovered) {
    const id = computePoolId(key);
    if (!seenIds.has(id)) {
      seenIds.add(id);
      allKeys.push(key);
    }
  }

  const results: PoolState[] = [];
  const tokens = KNOWN_TOKENS[cfg.chainId] ?? {};

  // Resolve token metadata helper
  function tokenMeta(addr: `0x${string}`): { symbol: string; decimals: number } {
    const known = Object.values(tokens).find(
      (t) => t.address.toLowerCase() === addr.toLowerCase()
    );
    return known ?? { symbol: addr.slice(0, 6), decimals: 18 };
  }

  // Process pools in parallel (batches of 5 to avoid rate limiting)
  for (let i = 0; i < allKeys.length; i += 5) {
    const batch = allKeys.slice(i, i + 5);
    const settled = await Promise.allSettled(
      batch.map(async (key): Promise<PoolState | null> => {
        const poolId = computePoolId(key);

        let slot0: { sqrtPriceX96: bigint; tick: number; protocolFee: number; lpFee: number };
        let liquidity: bigint;
        try {
          [slot0, liquidity] = await Promise.all([
            client.readContract({
              address: cfg.contracts.stateView,
              abi: STATE_VIEW_ABI,
              functionName: "getSlot0",
              args: [poolId],
            }) as any,
            client.readContract({
              address: cfg.contracts.stateView,
              abi: STATE_VIEW_ABI,
              functionName: "getLiquidity",
              args: [poolId],
            }) as any,
          ]);
        } catch {
          return null; // Pool not initialized
        }

        if ((slot0 as any).sqrtPriceX96 === 0n) return null;

        const meta0 = tokenMeta(key.currency0);
        const meta1 = tokenMeta(key.currency1);

        const [price0, price1] = await Promise.all([
          fetchTokenPrice(cfg.chainId, key.currency0),
          fetchTokenPrice(cfg.chainId, key.currency1),
        ]);

        const tvlUsd = liquidityToTVL(
          (liquidity as any) as bigint,
          (slot0 as any).sqrtPriceX96 as bigint,
          price0,
          price1,
          meta0.decimals,
          meta1.decimals
        );

        const volume24hUsd = await getVolume24h(
          client as any,
          cfg.contracts.poolManager,
          poolId,
          cfg.blockTime,
          price0,
          meta0.decimals
        );

        // Fee APY = (dailyFeeIncome / tvl) * 365 * 100
        const dailyFeeIncome = volume24hUsd * (key.fee / 1_000_000);
        const liveAPY = tvlUsd > 1000 ? (dailyFeeIncome / tvlUsd) * 365 * 100 : 0;

        const referenceAPY = await fetchDefiLlamaReferenceAPY(
          meta0.symbol,
          meta1.symbol,
          key.fee
        );

        return {
          poolId,
          poolKey:      key,
          chainId:      cfg.chainId,
          chainName:    cfg.name,
          network:      cfg.network,
          sqrtPriceX96: (slot0 as any).sqrtPriceX96 as bigint,
          tick:         (slot0 as any).tick as number,
          liquidity:    (liquidity as any) as bigint,
          tvlUsd,
          volume24hUsd,
          liveAPY,
          referenceAPY,
          token0Symbol: meta0.symbol,
          token1Symbol: meta1.symbol,
          token0Price:  price0,
          token1Price:  price1,
          lastUpdated:  Date.now(),
        };
      })
    );

    for (const r of settled) {
      if (r.status === "fulfilled" && r.value) results.push(r.value);
    }
  }

  return results;
}

// ─── Public scanner API ──────────────────────────────────────────────────────
export class UniswapV4Scanner {
  /**
   * Scan all chains (mainnet + testnet by default).
   * Pass `network` to restrict to one environment.
   */
  async scanAllChains(network?: "mainnet" | "testnet"): Promise<PoolState[]> {
    const chains = network
      ? ALL_CHAINS.filter((c) => c.network === network)
      : ALL_CHAINS;

    const perChain = await Promise.allSettled(chains.map((cfg) => scanChain(cfg)));

    const all: PoolState[] = [];
    for (const r of perChain) {
      if (r.status === "fulfilled") all.push(...r.value);
    }

    return all
      .filter((p) => p.referenceAPY > 0 || p.tvlUsd > 0)
      .sort((a, b) => {
        // Mainnet live APY is the most valuable signal; float it to top
        const scoreA = a.liveAPY > 0 ? a.liveAPY : a.referenceAPY * 0.01;
        const scoreB = b.liveAPY > 0 ? b.liveAPY : b.referenceAPY * 0.01;
        return scoreB - scoreA;
      });
  }

  async scanMainnet(): Promise<PoolState[]> {
    return this.scanAllChains("mainnet");
  }

  async scanTestnets(): Promise<PoolState[]> {
    return this.scanAllChains("testnet");
  }

  async scanChain(chainId: number): Promise<PoolState[]> {
    const cfg = ALL_CHAINS.find((c) => c.chainId === chainId);
    if (!cfg) throw new Error(`Chain ${chainId} not supported`);
    return scanChain(cfg);
  }
}
