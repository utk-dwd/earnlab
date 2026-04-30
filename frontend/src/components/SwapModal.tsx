"use client";

import { useState, useEffect, useCallback } from "react";
import { useBalance } from "wagmi";
import { formatUnits } from "viem";
import type { RankedOpportunity } from "../types/api";

const APP_WALLET_ADDRESS = process.env.NEXT_PUBLIC_APP_WALLET_ADDRESS as `0x${string}` | undefined;
const AGENT_API_URL      = process.env.NEXT_PUBLIC_AGENT_API_URL ?? "http://localhost:3001";

// ── Types ─────────────────────────────────────────────────────────────────────

interface SwapToken {
  symbol:   string;
  name:     string;
  address:  `0x${string}`;
  decimals: number;
}

// ── Chain + token registry (mirrors server SWAP_REGISTRY) ────────────────────

const SWAP_CHAINS = [
  {
    chainId:      11155111,
    name:         "Sepolia",
    dexName:      "Uniswap V3",
    explorerBase: "https://sepolia.etherscan.io/tx",
    wagmiSupported: true,
    tokens: [
      { symbol: "WETH", name: "Wrapped Ether",  address: "0xfFf9976782d46CC05630D1f6ebab18b2324d6B14" as `0x${string}`, decimals: 18 },
      { symbol: "USDC", name: "USD Coin",        address: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238" as `0x${string}`, decimals: 6  },
      { symbol: "LINK", name: "Chainlink",       address: "0x779877A7B0D9E8603169DdbD7836e478b4624789" as `0x${string}`, decimals: 18 },
      { symbol: "DAI",  name: "Dai",             address: "0xFF34B3d4Aee8ddCd6F9AFFFB6Fe49bD371b8a357" as `0x${string}`, decimals: 18 },
    ] as SwapToken[],
  },
  {
    chainId:        84532,
    name:           "Base Sepolia",
    dexName:        "Uniswap V3",
    explorerBase:   "https://sepolia.basescan.org/tx",
    wagmiSupported: true,
    tokens: [
      { symbol: "WETH", name: "Wrapped Ether", address: "0x4200000000000000000000000000000000000006" as `0x${string}`, decimals: 18 },
      { symbol: "USDC", name: "USD Coin",       address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as `0x${string}`, decimals: 6  },
    ] as SwapToken[],
  },
  {
    chainId:        11155420,
    name:           "OP Sepolia",
    dexName:        "Uniswap V3",
    explorerBase:   "https://sepolia-optimism.etherscan.io/tx",
    wagmiSupported: true,
    tokens: [
      { symbol: "WETH", name: "Wrapped Ether", address: "0x4200000000000000000000000000000000000006" as `0x${string}`, decimals: 18 },
      { symbol: "USDC", name: "USD Coin",       address: "0x5fd84259d66Cd46123540766Be93DFE6D43130D7" as `0x${string}`, decimals: 6  },
    ] as SwapToken[],
  },
  {
    chainId:        421614,
    name:           "Arb Sepolia",
    dexName:        "Uniswap V3",
    explorerBase:   "https://sepolia.arbiscan.io/tx",
    wagmiSupported: true,
    tokens: [
      { symbol: "WETH", name: "Wrapped Ether", address: "0x980B62Da83eFf3D4576C647993b0c1D7faf17c73" as `0x${string}`, decimals: 18 },
      { symbol: "USDC", name: "USD Coin",       address: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d" as `0x${string}`, decimals: 6  },
    ] as SwapToken[],
  },
  {
    chainId:        1301,
    name:           "Unichain Sepolia",
    dexName:        "Uniswap V3",
    explorerBase:   "https://unichain-sepolia.blockscout.com/tx",
    wagmiSupported: true,
    tokens: [
      { symbol: "WETH", name: "Wrapped Ether", address: "0x4200000000000000000000000000000000000006" as `0x${string}`, decimals: 18 },
    ] as SwapToken[],
  },
  {
    chainId:        16661,
    name:           "0G Network",
    dexName:        "JAINE DEX (0G)",
    explorerBase:   "https://chainscan.0g.ai/tx",
    wagmiSupported: false,
    tokens: [
      { symbol: "WKOG", name: "Wrapped KOG", address: "0x1Cd0690fF9a693f5EF2dD976660a8dAFc81A109c" as `0x${string}`, decimals: 18 },
    ] as SwapToken[],
  },
] as const;

type SwapChain = typeof SWAP_CHAINS[number];

// ── Suggested tokens — pool tokens on the selected chain from top yields ──────

function getSuggestedTokenSymbols(
  yields:   RankedOpportunity[],
  chainId:  number,
  tokens:   readonly SwapToken[],
): string[] {
  const chainYields = yields.filter(y => y.chainId === chainId).slice(0, 5);
  const seen = new Set<string>();
  for (const y of chainYields) {
    const parts = y.pair?.split("/") ?? [];
    for (const p of parts) seen.add(p.trim().toUpperCase());
  }
  return tokens.map(t => t.symbol).filter(s => seen.has(s));
}

// ── Token balance (app wallet, via wagmi) ─────────────────────────────────────

function AppWalletBalance({ token, chainId }: { token: SwapToken; chainId: number }) {
  const { data } = useBalance({
    address: APP_WALLET_ADDRESS,
    token:   token.address,
    chainId,
  });
  if (!APP_WALLET_ADDRESS || !data) return <span className="text-gray-400">—</span>;
  const val = parseFloat(formatUnits(data.value, token.decimals));
  return (
    <span className="font-mono">
      {val < 0.0001 && val > 0 ? "< 0.0001" : val.toFixed(4)}
    </span>
  );
}

// ── Modal shell ───────────────────────────────────────────────────────────────

function ModalShell({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} aria-hidden="true" />
      <div className="relative z-10 w-full max-w-md bg-white dark:bg-gray-900 rounded-2xl shadow-2xl border border-gray-200 dark:border-gray-700 p-6 max-h-[90vh] overflow-y-auto">
        <button
          onClick={onClose}
          aria-label="Close"
          className="absolute top-4 right-4 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 transition-colors text-xl leading-none"
        >
          ✕
        </button>
        {children}
      </div>
    </div>
  );
}

// ── Main modal ────────────────────────────────────────────────────────────────

export function SwapModal({ onClose, yields = [] }: { onClose: () => void; yields?: RankedOpportunity[] }) {
  const defaultChain = SWAP_CHAINS[0];

  const [chain,       setChain]       = useState<SwapChain>(defaultChain);
  const [tokenIn,     setTokenIn]     = useState<SwapToken>(defaultChain.tokens[0]);
  const [tokenOut,    setTokenOut]    = useState<SwapToken | null>(
    defaultChain.tokens.length > 1 ? defaultChain.tokens[1] : null,
  );
  const [amountIn,    setAmountIn]    = useState("");
  const [slippageBps, setSlippageBps] = useState(50);

  // Quote state
  const [quoteOut,    setQuoteOut]    = useState<string | null>(null);
  const [quoteFee,    setQuoteFee]    = useState<number | null>(null);
  const [quoteLoading,setQuoteLoading]= useState(false);
  const [quoteError,  setQuoteError]  = useState<string | null>(null);

  // Execute state
  const [swapTxHash,  setSwapTxHash]  = useState<string | null>(null);
  const [swapError,   setSwapError]   = useState<string | null>(null);
  const [swapLoading, setSwapLoading] = useState(false);
  const [explorerUrl, setExplorerUrl] = useState<string | null>(null);

  // ── Reset on chain change ─────────────────────────────────────────────────
  function handleChainChange(chainId: number) {
    const newChain = SWAP_CHAINS.find(c => c.chainId === chainId) ?? SWAP_CHAINS[0];
    setChain(newChain as SwapChain);
    setTokenIn(newChain.tokens[0]);
    setTokenOut(newChain.tokens.length > 1 ? newChain.tokens[1] : null);
    setAmountIn("");
    resetSwapState();
  }

  function handleTokenInChange(symbol: string) {
    const t = (chain.tokens as readonly SwapToken[]).find(x => x.symbol === symbol);
    if (!t) return;
    setTokenIn(t);
    if (tokenOut?.symbol === symbol) setTokenOut(null);
    resetQuoteState();
  }

  function handleTokenOutChange(symbol: string) {
    const t = (chain.tokens as readonly SwapToken[]).find(x => x.symbol === symbol);
    setTokenOut(t ?? null);
    resetQuoteState();
  }

  function handleSwapDirection() {
    if (!tokenOut) return;
    const prev = tokenIn;
    setTokenIn(tokenOut);
    setTokenOut(prev);
    setAmountIn("");
    resetQuoteState();
  }

  function resetQuoteState() {
    setQuoteOut(null); setQuoteFee(null); setQuoteError(null);
  }
  function resetSwapState() {
    resetQuoteState(); setSwapTxHash(null); setSwapError(null);
  }

  // ── Live quote (debounced 500 ms) ─────────────────────────────────────────
  const fetchQuote = useCallback(async (
    ci: number, tin: SwapToken, tout: SwapToken, amt: string,
  ) => {
    if (!amt || parseFloat(amt) <= 0) { resetQuoteState(); return; }
    setQuoteLoading(true);
    setQuoteError(null);
    setQuoteOut(null);
    try {
      const res = await fetch(`${AGENT_API_URL}/swap/quote`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chainId:    ci,
          tokenIn:    tin.address,
          tokenOut:   tout.address,
          amountIn:   amt,
          decimalsIn: tin.decimals,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setQuoteError(data.error ?? "Quote failed");
      } else {
        setQuoteOut(`${parseFloat(data.amountOutFormatted).toFixed(6)} ${data.tokenOutSymbol}`);
        setQuoteFee(data.fee);
      }
    } catch (e: any) {
      setQuoteError("Network error");
    } finally {
      setQuoteLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!tokenOut) return;
    const id = setTimeout(() => fetchQuote(chain.chainId, tokenIn, tokenOut, amountIn), 500);
    return () => clearTimeout(id);
  }, [chain.chainId, tokenIn, tokenOut, amountIn, fetchQuote]);

  // ── Execute swap ──────────────────────────────────────────────────────────
  async function handleSwap() {
    if (!tokenOut || !amountIn || !quoteFee) return;
    setSwapLoading(true);
    setSwapError(null);
    setSwapTxHash(null);
    try {
      const res = await fetch(`${AGENT_API_URL}/swap/execute`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chainId:    chain.chainId,
          tokenIn:    tokenIn.address,
          tokenOut:   tokenOut.address,
          amountIn,
          decimalsIn: tokenIn.decimals,
          fee:        quoteFee,
          slippageBps,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setSwapError(data.error ?? "Swap failed");
      } else {
        setSwapTxHash(data.txHash);
        setExplorerUrl(`${chain.explorerBase}/${data.txHash}`);
        setAmountIn("");
        resetQuoteState();
      }
    } catch (e: any) {
      setSwapError(e?.message ?? "Network error");
    } finally {
      setSwapLoading(false);
    }
  }

  const suggested = getSuggestedTokenSymbols(yields, chain.chainId, chain.tokens as readonly SwapToken[]);
  const canSwap   = !!tokenOut && !!amountIn && parseFloat(amountIn) > 0 && !!quoteFee && !swapLoading && !quoteLoading;
  const tokensOut = (chain.tokens as readonly SwapToken[]).filter(t => t.symbol !== tokenIn.symbol);

  return (
    <ModalShell onClose={onClose}>
      {/* Header */}
      <div className="flex items-center justify-between mb-5">
        <h2 className="text-lg font-bold text-gray-900 dark:text-gray-100">🔄 Swap Tokens</h2>
        {APP_WALLET_ADDRESS && (
          <span className="text-xs font-mono text-gray-400 dark:text-gray-500 bg-gray-100 dark:bg-gray-800 px-2 py-1 rounded">
            {APP_WALLET_ADDRESS.slice(0, 6)}…{APP_WALLET_ADDRESS.slice(-4)}
          </span>
        )}
      </div>

      {/* Chain selector */}
      <div className="mb-4">
        <label className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-1.5 block">
          Network
        </label>
        <select
          value={chain.chainId}
          onChange={e => handleChainChange(Number(e.target.value))}
          disabled={swapLoading}
          className="w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-50"
        >
          {SWAP_CHAINS.map(c => (
            <option key={c.chainId} value={c.chainId}>{c.name}</option>
          ))}
        </select>
        <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">
          DEX: <span className="font-semibold text-indigo-600 dark:text-indigo-400">{chain.dexName}</span>
          {chain.chainId === 16661 && (
            <span className="ml-2 text-amber-600 dark:text-amber-400">⚠ mainnet — real funds</span>
          )}
        </p>
      </div>

      {/* From */}
      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 p-4 mb-1">
        <div className="flex items-center justify-between mb-2">
          <label className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">
            From (app wallet)
          </label>
          {chain.wagmiSupported && APP_WALLET_ADDRESS && (
            <span className="text-xs text-gray-400 dark:text-gray-500">
              Balance: <AppWalletBalance token={tokenIn} chainId={chain.chainId} />
              {" "}{tokenIn.symbol}
            </span>
          )}
        </div>
        <div className="flex gap-2">
          <select
            value={tokenIn.symbol}
            onChange={e => handleTokenInChange(e.target.value)}
            disabled={swapLoading}
            className="rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 px-2 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-50"
          >
            {(chain.tokens as readonly SwapToken[]).map(t => (
              <option key={t.symbol} value={t.symbol}>{t.symbol}</option>
            ))}
          </select>
          <input
            type="number"
            placeholder="0.00"
            value={amountIn}
            onChange={e => { setAmountIn(e.target.value); resetSwapState(); }}
            disabled={swapLoading}
            min="0"
            step="any"
            className="flex-1 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 placeholder-gray-400 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-50"
          />
        </div>
      </div>

      {/* Swap direction button */}
      <div className="flex justify-center my-1">
        <button
          onClick={handleSwapDirection}
          disabled={!tokenOut || swapLoading}
          title="Swap direction"
          className="p-1.5 rounded-full bg-gray-100 dark:bg-gray-800 hover:bg-indigo-100 dark:hover:bg-indigo-900/40 text-gray-500 dark:text-gray-400 hover:text-indigo-600 dark:hover:text-indigo-400 transition-colors disabled:opacity-40"
        >
          ⇅
        </button>
      </div>

      {/* To */}
      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 p-4 mb-4">
        <div className="flex items-center justify-between mb-2">
          <label className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">
            To
          </label>
          {quoteLoading && (
            <span className="text-xs text-indigo-500 dark:text-indigo-400 animate-pulse">Getting quote…</span>
          )}
          {quoteOut && !quoteLoading && (
            <span className="text-xs text-green-600 dark:text-green-400 font-semibold">≈ {quoteOut}</span>
          )}
        </div>
        {tokensOut.length > 0 ? (
          <select
            value={tokenOut?.symbol ?? ""}
            onChange={e => handleTokenOutChange(e.target.value)}
            disabled={swapLoading}
            className="w-full rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 px-2 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-50"
          >
            <option value="">Select token…</option>
            {tokensOut.map(t => (
              <option key={t.symbol} value={t.symbol}>{t.symbol} — {t.name}</option>
            ))}
          </select>
        ) : (
          <p className="text-xs text-gray-400 dark:text-gray-500 py-2">
            Only one token available on this chain. Add more tokens to enable swaps.
          </p>
        )}
        {quoteError && !quoteLoading && (
          <p className="text-xs text-amber-600 dark:text-amber-400 mt-1.5">{quoteError}</p>
        )}
      </div>

      {/* Suggested tokens for yield pools */}
      {suggested.length > 0 && (
        <div className="mb-4 rounded-lg bg-indigo-50 dark:bg-indigo-900/20 border border-indigo-100 dark:border-indigo-800 px-3 py-2.5">
          <p className="text-xs font-semibold text-indigo-700 dark:text-indigo-300 mb-1.5">
            Suggested for top yield pools on this chain:
          </p>
          <div className="flex flex-wrap gap-1.5">
            {suggested.map(sym => (
              <button
                key={sym}
                onClick={() => sym !== tokenIn.symbol ? handleTokenOutChange(sym) : undefined}
                className={`px-2 py-0.5 rounded-full text-xs font-semibold border transition-colors ${
                  tokenOut?.symbol === sym
                    ? "bg-indigo-600 border-indigo-600 text-white"
                    : sym === tokenIn.symbol
                    ? "bg-gray-100 dark:bg-gray-700 border-gray-200 dark:border-gray-600 text-gray-400 cursor-default"
                    : "bg-white dark:bg-gray-800 border-indigo-300 dark:border-indigo-600 text-indigo-700 dark:text-indigo-300 hover:bg-indigo-50 dark:hover:bg-indigo-900/40"
                }`}
              >
                {sym}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Slippage + fee info */}
      <div className="flex items-center justify-between mb-4 text-xs text-gray-500 dark:text-gray-400">
        <div className="flex items-center gap-2">
          <span>Slippage:</span>
          {[25, 50, 100].map(bps => (
            <button
              key={bps}
              onClick={() => setSlippageBps(bps)}
              className={`px-2 py-0.5 rounded font-semibold transition-colors ${
                slippageBps === bps
                  ? "bg-indigo-600 text-white"
                  : "bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-600 dark:text-gray-300"
              }`}
            >
              {bps / 100}%
            </button>
          ))}
        </div>
        {quoteFee && (
          <span>Pool fee: <span className="font-semibold">{quoteFee / 10000}%</span></span>
        )}
      </div>

      {/* Swap button */}
      <button
        onClick={handleSwap}
        disabled={!canSwap}
        className="w-full py-3 rounded-xl font-semibold text-sm transition-colors bg-indigo-600 hover:bg-indigo-700 text-white disabled:bg-gray-200 dark:disabled:bg-gray-700 disabled:text-gray-400 dark:disabled:text-gray-500 disabled:cursor-not-allowed"
      >
        {swapLoading
          ? "⏳ Swapping… (may take 30–60s)"
          : !tokenOut
          ? "Select output token"
          : !amountIn || parseFloat(amountIn) <= 0
          ? "Enter amount"
          : !quoteFee
          ? "Waiting for quote…"
          : `Swap ${tokenIn.symbol} → ${tokenOut.symbol}`}
      </button>

      {/* Success */}
      {swapTxHash && (
        <div className="mt-4 rounded-lg bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 px-3 py-2.5 text-xs text-green-700 dark:text-green-400">
          <p className="font-semibold mb-0.5">✓ Swap submitted</p>
          {explorerUrl && (
            <a href={explorerUrl} target="_blank" rel="noopener noreferrer" className="underline font-medium break-all">
              View on explorer →
            </a>
          )}
        </div>
      )}

      {/* Error */}
      {swapError && (
        <div className="mt-4 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 px-3 py-2.5 text-xs text-red-700 dark:text-red-400">
          <p className="font-semibold mb-0.5">Swap failed</p>
          <p className="leading-relaxed">{swapError}</p>
        </div>
      )}

      {/* No app wallet warning */}
      {!APP_WALLET_ADDRESS && (
        <p className="mt-3 text-xs text-amber-600 dark:text-amber-400 text-center">
          NEXT_PUBLIC_APP_WALLET_ADDRESS not set — balance display unavailable
        </p>
      )}
    </ModalShell>
  );
}
