"use client";

import { useState } from "react";
import { useBalance } from "wagmi";
import { formatUnits } from "viem";

const APP_WALLET_ADDRESS = process.env.NEXT_PUBLIC_APP_WALLET_ADDRESS as `0x${string}` | undefined;

// ── Per-chain token list (address + metadata) ─────────────────────────────────

const CHAINS = [
  { id: 11155111, label: "Sepolia" },
  { id: 84532,    label: "Base Sep" },
  { id: 11155420, label: "OP Sep" },
  { id: 421614,   label: "Arb Sep" },
  { id: 1301,     label: "Uni Sep" },
] as const;

type ChainId = typeof CHAINS[number]["id"];

interface TokenDef {
  symbol:   string;
  decimals: number;
  address?: `0x${string}`; // undefined = native ETH
}

const TOKENS: Record<ChainId, TokenDef[]> = {
  11155111: [
    { symbol: "ETH",  decimals: 18 },
    { symbol: "USDC", decimals: 6,  address: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238" },
    { symbol: "WETH", decimals: 18, address: "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14" },
    { symbol: "LINK", decimals: 18, address: "0x779877A7B0D9E8603169DdbD7836e478b4624789" },
    { symbol: "DAI",  decimals: 18, address: "0xFF34B3d4Aee8ddCd6F9AFFFB6Fe49bD371b8a357" },
  ],
  84532: [
    { symbol: "ETH",  decimals: 18 },
    { symbol: "USDC", decimals: 6,  address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" },
  ],
  11155420: [
    { symbol: "ETH",  decimals: 18 },
    { symbol: "USDC", decimals: 6,  address: "0x5fd84259d66Cd46123540766Be93DFE6D43130D7" },
  ],
  421614: [
    { symbol: "ETH",  decimals: 18 },
    { symbol: "USDC", decimals: 6,  address: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d" },
  ],
  1301: [
    { symbol: "ETH",  decimals: 18 },
  ],
};

// ── Single balance cell ───────────────────────────────────────────────────────

function BalanceCell({
  chainId, token,
}: {
  chainId: ChainId;
  token:   TokenDef;
}) {
  const { data, isLoading } = useBalance({
    address: APP_WALLET_ADDRESS,
    token:   token.address,
    chainId,
  });

  if (!APP_WALLET_ADDRESS) return null;

  const formatted = data
    ? parseFloat(formatUnits(data.value, token.decimals))
    : null;

  const display = formatted === null
    ? (isLoading ? "…" : "—")
    : formatted < 0.0001 && formatted > 0
    ? "< 0.0001"
    : formatted.toFixed(4);

  return (
    <div className="flex flex-col items-center px-3 py-2 min-w-[72px]">
      <span className="text-[10px] font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider mb-0.5">
        {token.symbol}
      </span>
      <span className={`text-sm font-mono font-semibold ${
        formatted && formatted > 0
          ? "text-gray-900 dark:text-gray-100"
          : "text-gray-400 dark:text-gray-600"
      }`}>
        {display}
      </span>
    </div>
  );
}

// ── Main widget ───────────────────────────────────────────────────────────────

export function AppWalletBalances() {
  const [chainId, setChainId] = useState<ChainId>(11155111);

  if (!APP_WALLET_ADDRESS) return null;

  const tokens    = TOKENS[chainId];
  const chainName = CHAINS.find(c => c.id === chainId)!.label;

  return (
    <div className="rounded-xl border border-indigo-200 dark:border-indigo-800 bg-white dark:bg-gray-900 overflow-hidden">
      {/* Header row */}
      <div className="flex items-center justify-between px-4 py-2.5 bg-indigo-50 dark:bg-indigo-900/30 border-b border-indigo-100 dark:border-indigo-800">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xs font-bold text-indigo-700 dark:text-indigo-300 uppercase tracking-wider whitespace-nowrap">
            App Wallet
          </span>
          <span className="font-mono text-xs text-gray-500 dark:text-gray-400 truncate">
            {APP_WALLET_ADDRESS.slice(0, 6)}…{APP_WALLET_ADDRESS.slice(-4)}
          </span>
        </div>

        {/* Chain selector */}
        <div className="flex gap-1 flex-shrink-0">
          {CHAINS.map(c => (
            <button
              key={c.id}
              onClick={() => setChainId(c.id)}
              className={`px-2 py-0.5 rounded text-[10px] font-semibold transition-colors ${
                chainId === c.id
                  ? "bg-indigo-600 text-white"
                  : "text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800"
              }`}
            >
              {c.label}
            </button>
          ))}
        </div>
      </div>

      {/* Balance cells */}
      <div className="flex items-stretch divide-x divide-gray-100 dark:divide-gray-800 overflow-x-auto">
        {tokens.map(t => (
          <BalanceCell key={t.symbol} chainId={chainId} token={t} />
        ))}
      </div>
    </div>
  );
}
