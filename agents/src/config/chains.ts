import { defineChain } from "viem";
import {
  mainnet,
  optimism,
  base,
  arbitrum,
  polygon,
  blast,
  avalanche,
  bsc,
  celo,
  zora,
  // testnets
  sepolia,
  baseSepolia,
  arbitrumSepolia,
} from "viem/chains";

// ─── Chains not yet in viem ──────────────────────────────────────────────────

export const unichainMainnet = defineChain({
  id: 130,
  name: "Unichain",
  network: "unichain",
  nativeCurrency: { decimals: 18, name: "Ether", symbol: "ETH" },
  rpcUrls: {
    default: { http: ["https://mainnet.unichain.org"] },
    public:  { http: ["https://mainnet.unichain.org"] },
  },
  blockExplorers: { default: { name: "Uniscan", url: "https://uniscan.xyz" } },
});

export const worldchain = defineChain({
  id: 480,
  name: "Worldchain",
  network: "worldchain",
  nativeCurrency: { decimals: 18, name: "Ether", symbol: "ETH" },
  rpcUrls: {
    default: { http: ["https://worldchain-mainnet.g.alchemy.com/public"] },
    public:  { http: ["https://worldchain-mainnet.g.alchemy.com/public"] },
  },
  blockExplorers: { default: { name: "Worldscan", url: "https://worldscan.org" } },
});

export const xlayer = defineChain({
  id: 196,
  name: "X Layer",
  network: "xlayer",
  nativeCurrency: { decimals: 18, name: "OKB", symbol: "OKB" },
  rpcUrls: {
    default: { http: ["https://rpc.xlayer.tech"] },
    public:  { http: ["https://rpc.xlayer.tech"] },
  },
  blockExplorers: { default: { name: "OKLink", url: "https://www.oklink.com/xlayer" } },
});

export const ink = defineChain({
  id: 57073,
  name: "Ink",
  network: "ink",
  nativeCurrency: { decimals: 18, name: "Ether", symbol: "ETH" },
  rpcUrls: {
    default: { http: ["https://rpc-gel.inkonchain.com"] },
    public:  { http: ["https://rpc-gel.inkonchain.com"] },
  },
  blockExplorers: { default: { name: "Ink Explorer", url: "https://explorer.inkonchain.com" } },
});

export const soneium = defineChain({
  id: 1868,
  name: "Soneium",
  network: "soneium",
  nativeCurrency: { decimals: 18, name: "Ether", symbol: "ETH" },
  rpcUrls: {
    default: { http: ["https://rpc.soneium.org"] },
    public:  { http: ["https://rpc.soneium.org"] },
  },
  blockExplorers: { default: { name: "Soneium Explorer", url: "https://explorer.soneium.org" } },
});

export const monad = defineChain({
  id: 143,
  name: "Monad",
  network: "monad",
  nativeCurrency: { decimals: 18, name: "MON", symbol: "MON" },
  rpcUrls: {
    default: { http: ["https://testnet-rpc.monad.xyz"] }, // Monad is still testnet
    public:  { http: ["https://testnet-rpc.monad.xyz"] },
  },
  blockExplorers: { default: { name: "Monad Explorer", url: "https://testnet.monadexplorer.com" } },
  testnet: true,
});

export const unichainSepolia = defineChain({
  id: 1301,
  name: "Unichain Sepolia",
  network: "unichain-sepolia",
  nativeCurrency: { decimals: 18, name: "Ether", symbol: "ETH" },
  rpcUrls: {
    default: { http: ["https://sepolia.unichain.org"] },
    public:  { http: ["https://sepolia.unichain.org"] },
  },
  blockExplorers: { default: { name: "Uniscan", url: "https://sepolia.uniscan.xyz" } },
  testnet: true,
});

// ─── Chain config type ───────────────────────────────────────────────────────

export interface ChainConfig {
  chain:     ReturnType<typeof defineChain> | typeof mainnet;
  chainId:   number;
  name:      string;
  network:   "mainnet" | "testnet";
  blockTime: number;   // seconds per block (approx)
  rpcUrl:    string;
  contracts: {
    poolManager:     `0x${string}`;
    positionManager: `0x${string}`;
    stateView:       `0x${string}`;
    quoter:          `0x${string}`;
    universalRouter: `0x${string}`;
  };
}

// ─── MAINNET CHAINS ──────────────────────────────────────────────────────────

export const MAINNET_CHAINS: ChainConfig[] = [
  {
    chain:     mainnet as any,
    chainId:   1,
    name:      "Ethereum",
    network:   "mainnet",
    blockTime: 12,
    rpcUrl:    process.env.ETH_RPC_URL        ?? "https://eth.public.blastapi.io",
    contracts: {
      poolManager:     "0x000000000004444c5dc75cB358380D2e3dE08A90",
      positionManager: "0xbd216513d74c8cf14cf4747e6aaa6420ff64ee9e",
      stateView:       "0x7ffe42c4a5deea5b0fec41c94c136cf115597227",
      quoter:          "0x52f0e24d1c21c8a0cb1e5a5dd6198556bd9e1203",
      universalRouter: "0x66a9893cc07d91d95644aedd05d03f95e1dba8af",
    },
  },
  {
    chain:     unichainMainnet as any,
    chainId:   130,
    name:      "Unichain",
    network:   "mainnet",
    blockTime: 1,
    rpcUrl:    process.env.UNICHAIN_RPC_URL   ?? "https://mainnet.unichain.org",
    contracts: {
      poolManager:     "0x1f98400000000000000000000000000000000004",
      positionManager: "0x4529a01c7a0410167c5740c487a8de60232617bf",
      stateView:       "0x86e8631a016f9068c3f085faf484ee3f5fdee8f2",
      quoter:          "0x333e3c607b141b18ff6de9f258db6e77fe7491e0",
      universalRouter: "0xef740bf23acae26f6492b10de645d6b98dc8eaf3",
    },
  },
  {
    chain:     optimism as any,
    chainId:   10,
    name:      "Optimism",
    network:   "mainnet",
    blockTime: 2,
    rpcUrl:    process.env.OP_RPC_URL         ?? "https://mainnet.optimism.io",
    contracts: {
      poolManager:     "0x9a13f98cb987694c9f086b1f5eb990eea8264ec3",
      positionManager: "0x3c3ea4b57a46241e54610e5f022e5c45859a1017",
      stateView:       "0xc18a3169788f4f75a170290584eca6395c75ecdb",
      quoter:          "0x1f3131a13296fb91c90870043742c3cdbff1a8d7",
      universalRouter: "0x851116d9223fabed8e56c0e6b8ad0c31d98b3507",
    },
  },
  {
    chain:     base as any,
    chainId:   8453,
    name:      "Base",
    network:   "mainnet",
    blockTime: 2,
    rpcUrl:    process.env.BASE_RPC_URL       ?? "https://mainnet.base.org",
    contracts: {
      poolManager:     "0x498581ff718922c3f8e6a244956af099b2652b2b",
      positionManager: "0x7c5f5a4bbd8fd63184577525326123b519429bdc",
      stateView:       "0xa3c0c9b65bad0b08107aa264b0f3db444b867a71",
      quoter:          "0x0d5e0f971ed27fbff6c2837bf31316121532048d",
      universalRouter: "0x6ff5693b99212da76ad316178a184ab56d299b43",
    },
  },
  {
    chain:     arbitrum as any,
    chainId:   42161,
    name:      "Arbitrum One",
    network:   "mainnet",
    blockTime: 1,
    rpcUrl:    process.env.ARB_RPC_URL        ?? "https://arb1.arbitrum.io/rpc",
    contracts: {
      poolManager:     "0x360e68faccca8ca495c1b759fd9eee466db9fb32",
      positionManager: "0xd88f38f930b7952f2db2432cb002e7abbf3dd869",
      stateView:       "0x76fd297e2d437cd7f76d50f01afe6160f86e9990",
      quoter:          "0x3972c00f7ed4885e145823eb7c655375d275a1c5",
      universalRouter: "0xa51afafe0263b40edaef0df8781ea9aa03e381a3",
    },
  },
  {
    chain:     polygon as any,
    chainId:   137,
    name:      "Polygon",
    network:   "mainnet",
    blockTime: 2,
    rpcUrl:    process.env.POLYGON_RPC_URL    ?? "https://polygon-rpc.com",
    contracts: {
      poolManager:     "0x67366782805870060151383f4bbff9dab53e5cd6",
      positionManager: "0x1ec2ebf4f37e7363fdfe3551602425af0b3ceef9",
      stateView:       "0x5ea1bd7974c8a611cbab0bdcafcb1d9cc9b3ba5a",
      quoter:          "0xb3d5c3dfc3a7aebff71895a7191796bffc2c81b9",
      universalRouter: "0x1095692a6237d83c6a72f3f5efedb9a670c49223",
    },
  },
  {
    chain:     blast as any,
    chainId:   81457,
    name:      "Blast",
    network:   "mainnet",
    blockTime: 2,
    rpcUrl:    process.env.BLAST_RPC_URL      ?? "https://rpc.blast.io",
    contracts: {
      poolManager:     "0x1631559198a9e474033433b2958dabc135ab6446",
      positionManager: "0x4ad2f4cca2682cbb5b950d660dd458a1d3f1baad",
      stateView:       "0x12a88ae16f46dce4e8b15368008ab3380885df30",
      quoter:          "0x6f71cdcb0d119ff72c6eb501abceb576fbf62bcf",
      universalRouter: "0xeabbcb3e8e415306207ef514f660a3f820025be3",
    },
  },
  {
    chain:     avalanche as any,
    chainId:   43114,
    name:      "Avalanche",
    network:   "mainnet",
    blockTime: 2,
    rpcUrl:    process.env.AVAX_RPC_URL       ?? "https://api.avax.network/ext/bc/C/rpc",
    contracts: {
      poolManager:     "0x06380c0e0912312b5150364b9dc4542ba0dbbc85",
      positionManager: "0xb74b1f14d2754acfcbbe1a221023a5cf50ab8acd",
      stateView:       "0xc3c9e198c735a4b97e3e683f391ccbdd60b69286",
      quoter:          "0xbe40675bb704506a3c2ccfb762dcfd1e979845c2",
      universalRouter: "0x94b75331ae8d42c1b61065089b7d48fe14aa73b7",
    },
  },
  {
    chain:     bsc as any,
    chainId:   56,
    name:      "BNB Chain",
    network:   "mainnet",
    blockTime: 3,
    rpcUrl:    process.env.BSC_RPC_URL        ?? "https://bsc-dataseed.binance.org",
    contracts: {
      poolManager:     "0x28e2ea090877bf75740558f6bfb36a5ffee9e9df",
      positionManager: "0x7a4a5c919ae2541aed11041a1aeee68f1287f95b",
      stateView:       "0xd13dd3d6e93f276fafc9db9e6bb47c1180aee0c4",
      quoter:          "0x9f75dd27d6664c475b90e105573e550ff69437b0",
      universalRouter: "0x1906c1d672b88cd1b9ac7593301ca990f94eae07",
    },
  },
  {
    chain:     celo as any,
    chainId:   42220,
    name:      "Celo",
    network:   "mainnet",
    blockTime: 5,
    rpcUrl:    process.env.CELO_RPC_URL       ?? "https://forno.celo.org",
    contracts: {
      poolManager:     "0x288dc841A52FCA2707c6947B3A777c5E56cd87BC",
      positionManager: "0xf7965f3981e4d5bc383bfbcb61501763e9068ca9",
      stateView:       "0xbc21f8720babf4b20d195ee5c6e99c52b76f2bfb",
      quoter:          "0x28566da1093609182dff2cb2a91cfd72e61d66cd",
      universalRouter: "0xcb695bc5d3aa22cad1e6df07801b061a05a0233a",
    },
  },
  {
    chain:     zora as any,
    chainId:   7777777,
    name:      "Zora",
    network:   "mainnet",
    blockTime: 2,
    rpcUrl:    process.env.ZORA_RPC_URL       ?? "https://rpc.zora.energy",
    contracts: {
      poolManager:     "0x0575338e4c17006ae181b47900a84404247ca30f",
      positionManager: "0xf66c7b99e2040f0d9b326b3b7c152e9663543d63",
      stateView:       "0x385785af07d63b50d0a0ea57c4ff89d06adf7328",
      quoter:          "0x5edaccc0660e0a2c44b06e07ce8b915e625dc2c6",
      universalRouter: "0x3315ef7ca28db74abadc6c44570efdf06b04b020",
    },
  },
  {
    chain:     worldchain as any,
    chainId:   480,
    name:      "Worldchain",
    network:   "mainnet",
    blockTime: 2,
    rpcUrl:    process.env.WORLDCHAIN_RPC_URL ?? "https://worldchain-mainnet.g.alchemy.com/public",
    contracts: {
      poolManager:     "0xb1860d529182ac3bc1f51fa2abd56662b7d13f33",
      positionManager: "0xc585e0f504613b5fbf874f21af14c65260fb41fa",
      stateView:       "0x51d394718bc09297262e368c1a481217fdeb71eb",
      quoter:          "0x55d235b3ff2daf7c3ede0defc9521f1d6fe6c5c0",
      universalRouter: "0x8ac7bee993bb44dab564ea4bc9ea67bf9eb5e743",
    },
  },
  {
    chain:     ink as any,
    chainId:   57073,
    name:      "Ink",
    network:   "mainnet",
    blockTime: 1,
    rpcUrl:    process.env.INK_RPC_URL        ?? "https://rpc-gel.inkonchain.com",
    contracts: {
      poolManager:     "0x360e68faccca8ca495c1b759fd9eee466db9fb32",
      positionManager: "0x1b35d13a2e2528f192637f14b05f0dc0e7deb566",
      stateView:       "0x76fd297e2d437cd7f76d50f01afe6160f86e9990",
      quoter:          "0x3972c00f7ed4885e145823eb7c655375d275a1c5",
      universalRouter: "0x112908dac86e20e7241b0927479ea3bf935d1fa0",
    },
  },
  {
    chain:     soneium as any,
    chainId:   1868,
    name:      "Soneium",
    network:   "mainnet",
    blockTime: 2,
    rpcUrl:    process.env.SONEIUM_RPC_URL    ?? "https://rpc.soneium.org",
    contracts: {
      poolManager:     "0x360e68faccca8ca495c1b759fd9eee466db9fb32",
      positionManager: "0x1b35d13a2e2528f192637f14b05f0dc0e7deb566",
      stateView:       "0x76fd297e2d437cd7f76d50f01afe6160f86e9990",
      quoter:          "0x3972c00f7ed4885e145823eb7c655375d275a1c5",
      universalRouter: "0x4cded7edf52c8aa5259a54ec6a3ce7c6d2a455df",
    },
  },
];

// ─── TESTNET CHAINS ──────────────────────────────────────────────────────────

export const TESTNET_CHAINS: ChainConfig[] = [
  {
    chain:     sepolia as any,
    chainId:   11155111,
    name:      "Sepolia",
    network:   "testnet",
    blockTime: 12,
    rpcUrl:    process.env.SEPOLIA_RPC_URL      ?? "https://eth-sepolia.public.blastapi.io",
    contracts: {
      poolManager:     "0xE03A1074c86CFeDd5C142C4F04F1a1536e203543",
      positionManager: "0x429ba70129df741B2Ca2a85BC3A2a3328e5c09b4",
      stateView:       "0xe1dd9c3fa50edb962e442f60dfbc432e24537e4c",
      quoter:          "0x61b3f2011a92d183c7dbadbda940a7555ccf9227",
      universalRouter: "0x3A9D48AB9751398BbFa63ad67599Bb04e4BdF98b",
    },
  },
  {
    chain:     baseSepolia as any,
    chainId:   84532,
    name:      "Base Sepolia",
    network:   "testnet",
    blockTime: 2,
    rpcUrl:    process.env.BASE_SEPOLIA_RPC_URL ?? "https://sepolia.base.org",
    contracts: {
      poolManager:     "0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408",
      positionManager: "0x4b2c77d209d3405f41a037ec6c77f7f5b8e2ca80",
      stateView:       "0x571291b572ed32ce6751a2cb2486ebee8defb9b4",
      quoter:          "0x4a6513c898fe1b2d0e78d3b0e0a4a151589b1cba",
      universalRouter: "0x492e6456d9528771018deb9e87ef7750ef184104",
    },
  },
  {
    chain:     arbitrumSepolia as any,
    chainId:   421614,
    name:      "Arbitrum Sepolia",
    network:   "testnet",
    blockTime: 1,
    rpcUrl:    process.env.ARB_SEPOLIA_RPC_URL  ?? "https://sepolia-rollup.arbitrum.io/rpc",
    contracts: {
      poolManager:     "0xFB3e0C6F74eB1a21CC1Da29aeC80D2Dfe6C9a317",
      positionManager: "0xAc631556d3d4019C95769033B5E719dD77124BAc",
      stateView:       "0x9d467fa9062b6e9b1a46e26007ad82db116c67cb",
      quoter:          "0x7de51022d70a725b508085468052e25e22b5c4c9",
      universalRouter: "0xefd1d4bd4cf1e86da286bb4cb1b8bced9c10ba47",
    },
  },
  {
    chain:     unichainSepolia as any,
    chainId:   1301,
    name:      "Unichain Sepolia",
    network:   "testnet",
    blockTime: 1,
    rpcUrl:    process.env.UNICHAIN_SEPOLIA_RPC_URL ?? "https://sepolia.unichain.org",
    contracts: {
      poolManager:     "0x00b036b58a818b1bc34d502d3fe730db729e62ac",
      positionManager: "0xf969aee60879c54baaed9f3ed26147db216fd664",
      stateView:       "0xc199f1072a74d4e905aba1a84d9a45e2546b6222",
      quoter:          "0x56dcd40a3f2d466f48e7f48bdbe5cc9b92ae4472",
      universalRouter: "0xf70536b3bcc1bd1a972dc186a2cf84cc6da6be5d",
    },
  },
];

// ─── Combined + helpers ──────────────────────────────────────────────────────

export const ALL_CHAINS: ChainConfig[] = [...MAINNET_CHAINS, ...TESTNET_CHAINS];

export function getChain(chainId: number): ChainConfig | undefined {
  return ALL_CHAINS.find((c) => c.chainId === chainId);
}

// ─── ETH native address in v4 ────────────────────────────────────────────────
export const ETH_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

// ─── Standard v4 fee tiers ───────────────────────────────────────────────────
export const FEE_TIERS = [100, 500, 3000, 10000] as const;
export type FeeTier = typeof FEE_TIERS[number];

export const TICK_SPACINGS: Record<FeeTier, number> = {
  100:   1,
  500:   10,
  3000:  60,
  10000: 200,
};

// ─── Well-known token addresses ──────────────────────────────────────────────
export interface TokenInfo {
  address:  `0x${string}`;
  symbol:   string;
  decimals: number;
  /** CoinGecko ID for price lookups */
  coingeckoId?: string;
}

export const KNOWN_TOKENS: Record<number, Record<string, TokenInfo>> = {
  // ── Ethereum mainnet ────────────────────────────────────────────────────────
  1: {
    WETH:  { address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", symbol: "WETH",  decimals: 18, coingeckoId: "weth" },
    USDC:  { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", symbol: "USDC",  decimals: 6,  coingeckoId: "usd-coin" },
    USDT:  { address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", symbol: "USDT",  decimals: 6,  coingeckoId: "tether" },
    DAI:   { address: "0x6B175474E89094C44Da98b954EedeAC495271d0F", symbol: "DAI",   decimals: 18, coingeckoId: "dai" },
    WBTC:  { address: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", symbol: "WBTC",  decimals: 8,  coingeckoId: "wrapped-bitcoin" },
    UNI:   { address: "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984", symbol: "UNI",   decimals: 18, coingeckoId: "uniswap" },
    LINK:  { address: "0x514910771AF9Ca656af840dff83E8264EcF986CA", symbol: "LINK",  decimals: 18, coingeckoId: "chainlink" },
    AAVE:  { address: "0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9", symbol: "AAVE",  decimals: 18, coingeckoId: "aave" },
  },
  // ── Unichain mainnet ────────────────────────────────────────────────────────
  130: {
    WETH:  { address: "0x4200000000000000000000000000000000000006", symbol: "WETH",  decimals: 18 },
    USDC:  { address: "0x078D782b760474a361dDA0AF3839290b0EF57E3f", symbol: "USDC",  decimals: 6  },
  },
  // ── Optimism ────────────────────────────────────────────────────────────────
  10: {
    WETH:  { address: "0x4200000000000000000000000000000000000006", symbol: "WETH",  decimals: 18 },
    USDC:  { address: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", symbol: "USDC",  decimals: 6  },
    USDT:  { address: "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58", symbol: "USDT",  decimals: 6  },
    OP:    { address: "0x4200000000000000000000000000000000000042", symbol: "OP",    decimals: 18 },
    DAI:   { address: "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1", symbol: "DAI",   decimals: 18 },
  },
  // ── Base mainnet ─────────────────────────────────────────────────────────────
  8453: {
    WETH:  { address: "0x4200000000000000000000000000000000000006", symbol: "WETH",  decimals: 18 },
    USDC:  { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", symbol: "USDC",  decimals: 6  },
    cbETH: { address: "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22", symbol: "cbETH", decimals: 18 },
    DAI:   { address: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb", symbol: "DAI",   decimals: 18 },
  },
  // ── Arbitrum One ─────────────────────────────────────────────────────────────
  42161: {
    WETH:  { address: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", symbol: "WETH",  decimals: 18 },
    USDC:  { address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", symbol: "USDC",  decimals: 6  },
    USDT:  { address: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", symbol: "USDT",  decimals: 6  },
    ARB:   { address: "0x912CE59144191C1204E64559FE8253a0e49E6548", symbol: "ARB",   decimals: 18 },
    WBTC:  { address: "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f", symbol: "WBTC",  decimals: 8  },
  },
  // ── Polygon ──────────────────────────────────────────────────────────────────
  137: {
    WMATIC: { address: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270", symbol: "WMATIC", decimals: 18 },
    WETH:   { address: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", symbol: "WETH",   decimals: 18 },
    USDC:   { address: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174", symbol: "USDC",   decimals: 6  },
    USDT:   { address: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", symbol: "USDT",   decimals: 6  },
  },
  // ── BNB Chain ────────────────────────────────────────────────────────────────
  56: {
    WBNB:  { address: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", symbol: "WBNB",  decimals: 18 },
    USDC:  { address: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", symbol: "USDC",  decimals: 18 },
    USDT:  { address: "0x55d398326f99059fF775485246999027B3197955", symbol: "USDT",  decimals: 18 },
    ETH:   { address: "0x2170Ed0880ac9A755fd29B2688956BD959F933F8", symbol: "ETH",   decimals: 18 },
  },
  // ── Avalanche ────────────────────────────────────────────────────────────────
  43114: {
    WAVAX: { address: "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7", symbol: "WAVAX", decimals: 18 },
    USDC:  { address: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E", symbol: "USDC",  decimals: 6  },
    USDT:  { address: "0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7", symbol: "USDT",  decimals: 6  },
    WETH:  { address: "0x49D5c2BdFfac6CE2BFdB6640F4F80f226bc10baB", symbol: "WETH",  decimals: 18 },
  },
  // ── Celo ─────────────────────────────────────────────────────────────────────
  42220: {
    CELO:  { address: "0x471EcE3750Da237f93B8E339c536989b8978a438", symbol: "CELO",  decimals: 18 },
    cUSD:  { address: "0x765DE816845861e75A25fCA122bb6898B8B1282a", symbol: "cUSD",  decimals: 18 },
    USDC:  { address: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C", symbol: "USDC",  decimals: 6  },
  },
  // ── Blast ────────────────────────────────────────────────────────────────────
  81457: {
    WETH:  { address: "0x4300000000000000000000000000000000000004", symbol: "WETH",  decimals: 18 },
    USDB:  { address: "0x4300000000000000000000000000000000000003", symbol: "USDB",  decimals: 18 },
    WBTC:  { address: "0xF7bc58b8D8f97ADC129cfC4c9f45Ce3C0d1D2A3d", symbol: "WBTC",  decimals: 8  },
  },
  // ── Sepolia testnet ──────────────────────────────────────────────────────────
  11155111: {
    WETH:  { address: "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14", symbol: "WETH", decimals: 18 },
    USDC:  { address: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238", symbol: "USDC", decimals: 6  },
    DAI:   { address: "0x68194a729C2450ad26072b3D33ADaCbcef39D574", symbol: "DAI",  decimals: 18 },
    UNI:   { address: "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984", symbol: "UNI",  decimals: 18 },
  },
  // ── Base Sepolia testnet ──────────────────────────────────────────────────────
  84532: {
    WETH:  { address: "0x4200000000000000000000000000000000000006", symbol: "WETH", decimals: 18 },
    USDC:  { address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", symbol: "USDC", decimals: 6  },
  },
  // ── Arbitrum Sepolia testnet ──────────────────────────────────────────────────
  421614: {
    WETH:  { address: "0x980B62Da83eFf3D4576C647993b0c1D7faf17c73", symbol: "WETH", decimals: 18 },
    USDC:  { address: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d", symbol: "USDC", decimals: 6  },
  },
  // ── Unichain Sepolia testnet ──────────────────────────────────────────────────
  1301: {
    WETH:  { address: "0x4200000000000000000000000000000000000006", symbol: "WETH", decimals: 18 },
    USDC:  { address: "0x31d0220469e10c4E71834a79b1f276d740d3768F", symbol: "USDC", decimals: 6  },
  },
};
