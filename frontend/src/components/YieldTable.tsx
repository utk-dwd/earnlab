"use client";

import { useState, useRef } from "react";
import { createPortal } from "react-dom";
import type { RankedOpportunity } from "../types/api";

interface Props {
  opportunities: RankedOpportunity[];
  isLoading:     boolean;
}

type NetworkFilter = "all" | "mainnet" | "testnet";
type SortKey = "netAPY" | "displayAPY" | "rar7d" | "rar24h" | "tvlUsd" | "volume24hUsd";

// ─── Tooltip component (portal-based to escape overflow containers) ───────────
function Tooltip({ text, children }: { text: string; children: React.ReactNode }) {
  const [visible, setVisible] = useState(false);
  const [coords, setCoords]   = useState({ top: 0, left: 0 });
  const anchorRef             = useRef<HTMLSpanElement>(null);

  const handleMouseEnter = () => {
    if (anchorRef.current) {
      const rect = anchorRef.current.getBoundingClientRect();
      setCoords({ top: rect.top - 8, left: rect.left + rect.width / 2 });
    }
    setVisible(true);
  };

  return (
    <span ref={anchorRef} className="inline-flex items-center gap-1"
      onMouseEnter={handleMouseEnter} onMouseLeave={() => setVisible(false)}>
      {children}
      {visible && createPortal(
        <span style={{ position: "fixed", top: coords.top, left: coords.left,
          transform: "translate(-50%, -100%)", zIndex: 9999 }}
          className="w-80 px-3 py-2.5 rounded-lg shadow-xl bg-gray-900 text-gray-100 text-xs leading-relaxed whitespace-pre-wrap pointer-events-none border border-gray-700">
          {text}
          <span className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-gray-900" />
        </span>,
        document.body
      )}
    </span>
  );
}

// ─── Tooltip text (mirrors VolatilityCalculator.ts constants) ─────────────────
const RAR_TOOLTIP_24H = `Risk-Adjusted Return (24 h)
= APY ÷ σ₂₄ₕ

σ₂₄ₕ = stdDev[ ln(Pₜ/Pₜ₋₁) ] × √8760
  · 24 hourly log-returns of the pool's
    most volatile token
  · ×√8760 annualises to 1 year
  · Uses MAX vol of the two tokens
    (worst-case LP exposure)

Higher = better return per unit of risk.
Equivalent to Sharpe ratio (Rf = 0).
"…" = volatility still loading.`;

const RAR_TOOLTIP_7D = `Risk-Adjusted Return (7 d)
= APY ÷ σ₇ₐ

σ₇ₐ = stdDev[ ln(Pₜ/Pₜ₋₁) ] × √8760
  · 168 hourly log-returns (7 d × 24 h)
  · More stable estimate than 24 h —
    smooths out single-day vol spikes
  · Uses MAX vol of the two tokens
    (worst-case LP exposure)

Higher = better return per unit of risk.
Equivalent to Sharpe ratio (Rf = 0).
"…" = volatility still loading.`;

const NET_APY_TOOLTIP = `Net APY = Fee APY − Expected IL

Expected IL = 0.5 × σ₇ₐ²  (annualised)
  where σ₇ₐ is the 7d annualised volatility of
  the more volatile token in the pair.

Stable pairs (σ ≈ 0): Net APY ≈ Fee APY
Volatile pairs: Net APY is substantially lower
  and can be negative in drawdowns.

Example: AAVE/USDC
  Fee APY 154%, vol7d 80%
  Expected IL = 0.5 × 0.80² × 100 = 32%
  Net APY ≈ 122%

"—" = volatility not yet computed.
Sorted by Net APY by default (★).`;

const PRICE_CHANGE_24H_TOOLTIP = `Pair Price Change (24 h)
= (rate_now − rate_24h_ago) / rate_24h_ago

rate = token0 price / token1 price
e.g. WETH/ARB = how many ARB per 1 WETH

Computed from the same hourly DefiLlama
data used for volatility.
"—" = no data yet.`;

const PRICE_CHANGE_7D_TOOLTIP = `Pair Price Change (7 d)
= (rate_now − rate_7d_ago) / rate_7d_ago

rate = token0 price / token1 price
e.g. WETH/ARB = how many ARB per 1 WETH

Computed from the same hourly DefiLlama
data used for volatility.
"—" = no data yet.`;

// ─── Main table ───────────────────────────────────────────────────────────────
export function YieldTable({ opportunities, isLoading }: Props) {
  const [networkFilter, setNetworkFilter] = useState<NetworkFilter>("all");
  const [sortKey,       setSortKey]       = useState<SortKey>("netAPY");
  const [showRefOnly,   setShowRefOnly]   = useState(false);

  const filtered = opportunities
    .filter((o) => networkFilter === "all" || o.network === networkFilter)
    .filter((o) => !showRefOnly || o.apySource === "reference")
    .sort((a, b) => {
      // For netAPY, fall back to displayAPY when expectedIL hasn't been computed yet
      if (sortKey === "netAPY") {
        const aN = a.expectedIL > 0 ? a.netAPY : a.displayAPY;
        const bN = b.expectedIL > 0 ? b.netAPY : b.displayAPY;
        return bN - aN;
      }
      return (b[sortKey] as number) - (a[sortKey] as number);
    });

  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">

      {/* ── Toolbar ── */}
      <div className="flex flex-wrap items-center gap-3 px-4 py-3 bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
        <span className="text-sm font-medium text-gray-600 dark:text-gray-300">
          {filtered.length} pools
        </span>

        <div className="flex rounded-lg overflow-hidden border border-gray-300 dark:border-gray-600 text-xs">
          {(["all", "mainnet", "testnet"] as NetworkFilter[]).map((n) => (
            <button key={n} onClick={() => setNetworkFilter(n)}
              className={`px-3 py-1 capitalize ${networkFilter === n
                ? "bg-indigo-600 text-white"
                : "bg-white dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-100"}`}>
              {n}
            </button>
          ))}
        </div>

        <select value={sortKey} onChange={(e) => setSortKey(e.target.value as SortKey)}
          className="text-xs border border-gray-300 dark:border-gray-600 rounded-md px-2 py-1 bg-white dark:bg-gray-700 dark:text-gray-200">
          <option value="netAPY">Sort: Net APY ★</option>
          <option value="displayAPY">Sort: Fee APY</option>
          <option value="rar7d">Sort: RAR (7d)</option>
          <option value="rar24h">Sort: RAR (24h)</option>
          <option value="tvlUsd">Sort: TVL</option>
          <option value="volume24hUsd">Sort: Volume 24h</option>
        </select>

        <label className="flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-300 cursor-pointer">
          <input type="checkbox" checked={showRefOnly} onChange={(e) => setShowRefOnly(e.target.checked)} className="rounded" />
          Reference APY only
        </label>
      </div>

      {/* ── Table ── */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-100 dark:bg-gray-800 text-left text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wider">
              <th className="px-3 py-3 w-8">#</th>
              <th className="px-3 py-3">Chain</th>
              <th className="px-3 py-3">Pair</th>
              <th className="px-3 py-3">Fee</th>
              <th className="px-3 py-3">Fee APY</th>
              <th className="px-3 py-3">
                <Tooltip text={NET_APY_TOOLTIP}>
                  <span className="border-b border-dashed border-gray-400 cursor-help">Net APY ★</span>
                  <InfoIcon />
                </Tooltip>
              </th>
              <th className="px-3 py-3">Src</th>
              <th className="px-3 py-3">TVL</th>
              <th className="px-3 py-3">Vol 24h</th>
              <th className="px-3 py-3">Risk</th>

              {/* RAR columns with tooltips */}
              <th className="px-3 py-3">
                <Tooltip text={RAR_TOOLTIP_24H}>
                  <span className="border-b border-dashed border-gray-400 cursor-help">RAR 24h</span>
                  <InfoIcon />
                </Tooltip>
              </th>
              <th className="px-3 py-3">
                <Tooltip text={RAR_TOOLTIP_7D}>
                  <span className="border-b border-dashed border-gray-400 cursor-help">RAR 7d</span>
                  <InfoIcon />
                </Tooltip>
              </th>

              {/* Price change columns */}
              <th className="px-3 py-3">
                <Tooltip text={PRICE_CHANGE_24H_TOOLTIP}>
                  <span className="border-b border-dashed border-gray-400 cursor-help">Δ 24h</span>
                  <InfoIcon />
                </Tooltip>
              </th>
              <th className="px-3 py-3">
                <Tooltip text={PRICE_CHANGE_7D_TOOLTIP}>
                  <span className="border-b border-dashed border-gray-400 cursor-help">Δ 7d</span>
                  <InfoIcon />
                </Tooltip>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
            {isLoading && filtered.length === 0 && (
              <tr><td colSpan={14} className="px-4 py-8 text-center text-gray-400">Scanning chains…</td></tr>
            )}
            {!isLoading && filtered.length === 0 && (
              <tr><td colSpan={14} className="px-4 py-8 text-center text-gray-400">No pools found</td></tr>
            )}
            {filtered.map((o) => (
              <tr key={`${o.chainId}-${o.poolId}`}
                className="hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors">
                <td className="px-3 py-2.5 text-gray-400 text-xs">{o.rank}</td>
                <td className="px-3 py-2.5">
                  <div className="flex items-center gap-1.5">
                    <NetworkDot network={o.network} />
                    <span className="font-medium dark:text-gray-200 text-xs">{o.chainName}</span>
                  </div>
                </td>
                <td className="px-3 py-2.5 font-mono font-semibold dark:text-gray-100">{o.pair}</td>
                <td className="px-3 py-2.5 text-gray-500 dark:text-gray-400 text-xs">{o.feeTierLabel}</td>
                <td className="px-3 py-2.5">
                  <span className={`tabular-nums ${apyColor(o.displayAPY)}`}>
                    {o.displayAPY.toFixed(2)}%
                  </span>
                </td>
                <td className="px-3 py-2.5">
                  <NetAPYCell feeAPY={o.displayAPY} expectedIL={o.expectedIL} netAPY={o.netAPY} />
                </td>
                <td className="px-3 py-2.5">
                  <SourceBadge source={o.apySource} />
                </td>
                <td className="px-3 py-2.5 tabular-nums text-gray-600 dark:text-gray-300 text-xs">{fmtUsd(o.tvlUsd)}</td>
                <td className="px-3 py-2.5 tabular-nums text-gray-600 dark:text-gray-300 text-xs">{fmtUsd(o.volume24hUsd)}</td>
                <td className="px-3 py-2.5"><RiskBadge risk={o.risk} /></td>

                {/* RAR 24h */}
                <td className="px-3 py-2.5">
                  <RARCell rar={o.rar24h} vol={o.vol24h} quality={o.rarQuality} window="24h" />
                </td>

                {/* RAR 7d */}
                <td className="px-3 py-2.5">
                  <RARCell rar={o.rar7d} vol={o.vol7d} quality={o.rarQuality} window="7d" />
                </td>

                {/* Pair price change 24h */}
                <td className="px-3 py-2.5">
                  <PriceChangeVal chg={o.pairPriceChange24h} />
                </td>

                {/* Pair price change 7d */}
                <td className="px-3 py-2.5">
                  <PriceChangeVal chg={o.pairPriceChange7d} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* ── Legend ── */}
      <div className="px-4 py-2 bg-gray-50 dark:bg-gray-800 border-t border-gray-200 dark:border-gray-700 text-xs text-gray-400 flex flex-wrap gap-4">
        <span><strong>live</strong> = on-chain fee APY &nbsp;·&nbsp; <strong>ref</strong> = DefiLlama reference</span>
        <span><strong>Net APY ★</strong> = Fee APY − Expected IL &nbsp;·&nbsp; default sort</span>
        <span><strong>RAR</strong> = APY ÷ annualised vol (Sharpe, Rf=0) &nbsp;·&nbsp; higher is better</span>
        <span className="flex gap-2">
          {([["excellent","≥2.0","text-emerald-600"],["good","≥1.0","text-green-500"],["fair","≥0.5","text-yellow-500"],["poor","<0.5","text-red-500"]] as const).map(([q,v,c])=>(
            <span key={q}><span className={`font-semibold ${c}`}>{q}</span> {v}</span>
          ))}
        </span>
      </div>
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function RARCell({ rar, vol, quality, window: win }: {
  rar: number; vol: number; quality: string; window: string;
}) {
  if (rar === 0) {
    return <span className="text-gray-300 dark:text-gray-600 text-xs">…</span>;
  }
  const color: Record<string, string> = {
    excellent: "text-emerald-600 dark:text-emerald-400",
    good:      "text-green-500 dark:text-green-400",
    fair:      "text-yellow-500 dark:text-yellow-400",
    poor:      "text-red-500 dark:text-red-400",
    "n/a":     "text-gray-400",
  };
  const tooltip = `RAR (${win}) = ${rar.toFixed(3)}\nVol ${win} = ${vol.toFixed(1)}% annualised`;
  return (
    <Tooltip text={tooltip}>
      <span className={`font-mono font-semibold tabular-nums text-xs cursor-help ${color[quality] ?? "text-gray-500"}`}>
        {rar.toFixed(2)}
      </span>
    </Tooltip>
  );
}

function NetAPYCell({ feeAPY, expectedIL, netAPY }: { feeAPY: number; expectedIL: number; netAPY: number }) {
  if (!Number.isFinite(netAPY) || !Number.isFinite(expectedIL) || expectedIL === 0) {
    return <span className="text-gray-300 dark:text-gray-600 text-xs">—</span>;
  }
  const tooltip = `Net APY = ${netAPY.toFixed(2)}%\nFee APY = ${feeAPY.toFixed(2)}%\nExpected IL = ${expectedIL.toFixed(2)}%`;
  const color = netAPY >= 20 ? "text-emerald-600 dark:text-emerald-400"
    : netAPY >= 5  ? "text-green-500 dark:text-green-400"
    : netAPY >= 0  ? "text-yellow-500 dark:text-yellow-400"
    : "text-red-500 dark:text-red-400";
  return (
    <Tooltip text={tooltip}>
      <span className={`font-bold tabular-nums text-xs cursor-help ${color}`}>
        {netAPY >= 0 ? "" : "−"}{Math.abs(netAPY).toFixed(1)}%
      </span>
    </Tooltip>
  );
}

function PriceChangeVal({ chg }: { chg: number }) {
  if (!chg || !Number.isFinite(chg)) return <span className="text-gray-300 dark:text-gray-600">—</span>;
  const pct   = (chg * 100).toFixed(1);
  const color = chg > 0 ? "text-green-500 dark:text-green-400" : "text-red-500 dark:text-red-400";
  const sign  = chg > 0 ? "+" : "";
  return <span className={`font-mono tabular-nums ${color}`}>{sign}{pct}%</span>;
}

function NetworkDot({ network }: { network: "mainnet" | "testnet" }) {
  return <span className={`w-2 h-2 rounded-full inline-block flex-shrink-0 ${network === "mainnet" ? "bg-green-500" : "bg-yellow-400"}`} title={network} />;
}

function SourceBadge({ source }: { source: string }) {
  return (
    <span className={`text-xs px-1.5 py-0.5 rounded-full font-medium ${
      source === "live"
        ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
        : "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400"}`}>
      {source === "live" ? "live" : "ref"}
    </span>
  );
}

function RiskBadge({ risk }: { risk: string }) {
  const s: Record<string, string> = {
    low:     "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
    medium:  "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400",
    high:    "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400",
    extreme: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
  };
  return <span className={`text-xs px-1.5 py-0.5 rounded-full font-medium ${s[risk] ?? ""}`}>{risk}</span>;
}

function InfoIcon() {
  return (
    <svg className="w-3 h-3 text-gray-400 inline" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="10" strokeWidth="2"/>
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 16v-4M12 8h.01"/>
    </svg>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function apyColor(apy: number) {
  if (apy >= 50) return "text-red-500";
  if (apy >= 20) return "text-orange-500";
  if (apy >= 5)  return "text-green-600 dark:text-green-400";
  return "text-gray-700 dark:text-gray-200";
}

function fmtUsd(n: number) {
  if (!n) return "—";
  if (n >= 1e9) return `$${(n/1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n/1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n/1e3).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}
