"use client";

import { useState } from "react";
import type { RankedOpportunity } from "../types/api";

interface Props {
  opportunities: RankedOpportunity[];
  isLoading:     boolean;
}

type NetworkFilter = "all" | "mainnet" | "testnet";
type SortKey = "displayAPY" | "tvlUsd" | "volume24hUsd";

export function YieldTable({ opportunities, isLoading }: Props) {
  const [networkFilter, setNetworkFilter] = useState<NetworkFilter>("all");
  const [sortKey, setSortKey]             = useState<SortKey>("displayAPY");
  const [showRefOnly, setShowRefOnly]     = useState(false);

  const filtered = opportunities
    .filter((o) => networkFilter === "all" || o.network === networkFilter)
    .filter((o) => !showRefOnly || o.apySource === "reference")
    .sort((a, b) => b[sortKey] - a[sortKey]);

  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
      {/* ── Toolbar ── */}
      <div className="flex flex-wrap items-center gap-3 px-4 py-3 bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
        <span className="text-sm font-medium text-gray-600 dark:text-gray-300">
          {filtered.length} pools
        </span>

        {/* Network toggle */}
        <div className="flex rounded-lg overflow-hidden border border-gray-300 dark:border-gray-600 text-xs">
          {(["all", "mainnet", "testnet"] as NetworkFilter[]).map((n) => (
            <button
              key={n}
              onClick={() => setNetworkFilter(n)}
              className={`px-3 py-1 capitalize ${
                networkFilter === n
                  ? "bg-indigo-600 text-white"
                  : "bg-white dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-100"
              }`}
            >
              {n}
            </button>
          ))}
        </div>

        {/* Sort */}
        <select
          value={sortKey}
          onChange={(e) => setSortKey(e.target.value as SortKey)}
          className="text-xs border border-gray-300 dark:border-gray-600 rounded-md px-2 py-1 bg-white dark:bg-gray-700 dark:text-gray-200"
        >
          <option value="displayAPY">Sort: APY</option>
          <option value="tvlUsd">Sort: TVL</option>
          <option value="volume24hUsd">Sort: Volume 24h</option>
        </select>

        <label className="flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-300 cursor-pointer">
          <input
            type="checkbox"
            checked={showRefOnly}
            onChange={(e) => setShowRefOnly(e.target.checked)}
            className="rounded"
          />
          Reference APY only
        </label>
      </div>

      {/* ── Table ── */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-100 dark:bg-gray-800 text-left text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wider">
              <th className="px-4 py-3 w-10">#</th>
              <th className="px-4 py-3">Chain</th>
              <th className="px-4 py-3">Pair</th>
              <th className="px-4 py-3">Fee</th>
              <th className="px-4 py-3">APY</th>
              <th className="px-4 py-3">Source</th>
              <th className="px-4 py-3">TVL</th>
              <th className="px-4 py-3">Vol 24h</th>
              <th className="px-4 py-3">Risk</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
            {isLoading && (
              <tr>
                <td colSpan={9} className="px-4 py-8 text-center text-gray-400">
                  Scanning {filtered.length === 0 ? "chains…" : "updating…"}
                </td>
              </tr>
            )}
            {!isLoading && filtered.length === 0 && (
              <tr>
                <td colSpan={9} className="px-4 py-8 text-center text-gray-400">
                  No pools found for current filters
                </td>
              </tr>
            )}
            {filtered.map((o) => (
              <tr
                key={`${o.chainId}-${o.poolId}`}
                className="hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors"
              >
                <td className="px-4 py-3 text-gray-400">{o.rank}</td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-1.5">
                    <NetworkBadge network={o.network} />
                    <span className="font-medium dark:text-gray-200">{o.chainName}</span>
                  </div>
                </td>
                <td className="px-4 py-3 font-mono font-semibold dark:text-gray-100">
                  {o.pair}
                </td>
                <td className="px-4 py-3 text-gray-500 dark:text-gray-400">
                  {o.feeTierLabel}
                </td>
                <td className="px-4 py-3">
                  <span className={`font-bold tabular-nums ${apyColor(o.displayAPY)}`}>
                    {o.displayAPY.toFixed(2)}%
                  </span>
                </td>
                <td className="px-4 py-3">
                  <span
                    className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                      o.apySource === "live"
                        ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
                        : "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400"
                    }`}
                  >
                    {o.apySource === "live" ? "live" : "ref"}
                  </span>
                </td>
                <td className="px-4 py-3 tabular-nums text-gray-600 dark:text-gray-300">
                  {fmtUsd(o.tvlUsd)}
                </td>
                <td className="px-4 py-3 tabular-nums text-gray-600 dark:text-gray-300">
                  {fmtUsd(o.volume24hUsd)}
                </td>
                <td className="px-4 py-3">
                  <RiskBadge risk={o.risk} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* ── Footer note ── */}
      <div className="px-4 py-2 bg-gray-50 dark:bg-gray-800 border-t border-gray-200 dark:border-gray-700 text-xs text-gray-400">
        <strong>live</strong> = on-chain APY from StateView + Swap events &nbsp;·&nbsp;
        <strong>ref</strong> = mainnet DefiLlama reference for the same pair
      </div>
    </div>
  );
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function NetworkBadge({ network }: { network: "mainnet" | "testnet" }) {
  return (
    <span
      className={`w-2 h-2 rounded-full inline-block ${
        network === "mainnet" ? "bg-green-500" : "bg-yellow-400"
      }`}
      title={network}
    />
  );
}

function RiskBadge({ risk }: { risk: string }) {
  const styles: Record<string, string> = {
    low:     "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
    medium:  "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400",
    high:    "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400",
    extreme: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
  };
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${styles[risk] ?? ""}`}>
      {risk}
    </span>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function apyColor(apy: number): string {
  if (apy >= 50)  return "text-red-500";
  if (apy >= 20)  return "text-orange-500";
  if (apy >= 5)   return "text-green-600 dark:text-green-400";
  return "text-gray-700 dark:text-gray-200";
}

function fmtUsd(n: number): string {
  if (!n || n === 0) return "—";
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000)     return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)         return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}
