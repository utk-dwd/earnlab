"use client";

import { useState, useRef } from "react";
import { createPortal } from "react-dom";
import type { RankedOpportunity, PoolRiskResult, StablecoinRiskResult, AdverseSelectionResult, StressTestResult, DecisionScorecard, HookAnalysisResult } from "../types/api";

interface Props {
  opportunities: RankedOpportunity[];
  isLoading:     boolean;
}

type NetworkFilter = "all" | "mainnet" | "testnet";
type SortKey = "effectiveNetAPY" | "netAPY" | "displayAPY" | "rar7d" | "rar24h" | "tvlUsd" | "volume24hUsd" | "liquidityQuality" | "apyPersistence" | "downsideScore" | "composite";

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

const PERSIST_TOOLTIP = `APY Persistence
= min(medianFeeAPY_7d / currentFeeAPY, 1.0)

Measures whether the current APY reflects
sustained fee generation or a temporary spike.

  100% = current APY ≤ 7-day median (durable)
   13% = current APY is 7.5× the median (spike!)

The 7-day median is built from hourly snapshots
stored while the agent runs.  Shows "…" for the
first 6 hours (not enough history yet).

Used as a direct multiplier on RAR in ranking:
  RAR × √(lq/100) × persistence
A 150% APY pool with 13% persistence ranks far
below an 80% APY pool with 95% persistence.`;

const LQ_TOOLTIP = `Liquidity Quality Score (0–100)
= geomean(TVL, activity, stability, depth)

TVL — pool size vs fee-tier target
  • 0.01% pools: target $2M
  • 0.05%: $500K · 0.3%: $200K · 1%: $100K

Activity — daily vol/TVL turnover (capped at 1×)
  Prevents one-day spikes from scoring 100%.

Stability — sqrt(min(liveAPY, refAPY)/max)
  Penalises when live and reference APYs diverge
  sharply (volume spike or sudden collapse).

Depth — TVL vs volatility-adjusted requirement
  Volatile pairs need proportionally more TVL
  to stay deep in their concentrated range.
  Required TVL = max($50K, vol7d × $10K).

Score interpretation:
  80–100  deep, active, consistent pool
  50–80   adequate but has one weak signal
  25–50   meaningful concern — thin or unstable
  < 25    discounted heavily in ranking`;

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

"—" = volatility not yet computed.`;

const ADV_SEL_TOOLTIP = `Adverse Selection Score (0–100)
Detects whether LP fees are earned from
informed directional traders — a sign that
LPs are paying more in IL than they earn.

Four sub-signals (each 0–100):

  Fee vs Price Move
    Fee APY spike aligned with a sharp
    directional 24h price move.
    High → informed traders paid fees while
    extracting LP value.

  Volume During Moves
    High daily turnover (vol/TVL) coinciding
    with vol24h > vol7d baseline.
    High → volume is concentrated in
    adversely selected periods.

  Price Drift (momentum)
    Blend of trendiness and lag-1 return
    autocorrelation. >55% = price keeps
    moving in the same direction — LPs are
    on the wrong side of a trend.

  Vol Acceleration
    Late-session vol / early-session vol.
    >1.5× = volatility building, not dissipating.
    Suggests ongoing informed price discovery.

Score  0–24   low      — balanced flow
Score 25–44   moderate — minor signals
Score 45–69   elevated — worth scrutiny
Score 70+     high     — likely toxic flow`;

const EFF_APY_TOOLTIP = `Effective Net APY ★ (default sort)
= Net APY × Capital Utilization

Capital Utilization = TimeInRange × FeeCaptureEfficiency

TimeInRange (TiR):
  Fraction of the last 7 d (168 hourly prices)
  where the pair price stayed within ±2σ₇ₐ
  of today's price. Out-of-range = zero fees.

FeeCaptureEfficiency (FCE):
  √(min(liveAPY, refAPY) / max(liveAPY, refAPY))
  Measures whether fees are spike-driven (FCE ≈ 0.3)
  or consistently earned (FCE ≈ 1.0).

Example:
  Pool A: netAPY=120%  TiR=55%  FCE=70%  → effAPY=46%
  Pool B: netAPY=35%   TiR=92%  FCE=95%  → effAPY=31%
  Pool A looks better on netAPY but Pool B
  delivers more reliable real-world yield.

"—" = capital efficiency not yet computed.`;

const STRESS_TOOLTIP = `Scenario Stress Test (30-day horizon)
Simulates 8 adversarial scenarios before LP entry.
Returns net P&L as % of position over 30 days.

Scenarios:
  Token −5%   one-time 5% price drop; position held
  Token −10%  one-time 10% drop
  Token −20%  severe market stress
  Vol ×2      volatility doubles; IL ×4, TiR falls
  Vol −50%    trading volume halves; fee APY halves
  APY reverts fee APY reverts to 7d median
  Gas ×5      entry gas cost spikes 5×
  Stable −50bps  stablecoin depegs 50 bps from $1

Downside Score (0–100):
  = min(100, max(0, −worstCase × 5))
  0   all scenarios profitable
  100 worst case ≥ −20% loss

Expected Shortfall (ES):
  Average of the 3 worst scenario returns.
  CVaR proxy — measures tail risk, not just
  the single worst outcome.

Color: green <0 (all profitable) · yellow 0–30
       orange 30–60 · red ≥ 60`;

const SCORECARD_TOOLTIP = `Decision Scorecard (0–100 per dimension)
Composite = weighted sum of 9 dimensions.
Higher = better on every dimension.

Neutral weights shown below:
  Yield      22%  effectiveNetAPY × hook multiplier
                  × incentive haircut (adv-sel adj)
  IL         18%  protection from impermanent loss
                  0% IL eats = 100; IL ≥ APY = 0
  Liquidity  13%  pool depth, activity, APY stability
                  (= liquidityQuality score)
  Volatility  9%  time-in-range + price move penalty
  Token Risk  9%  inverse GoPlus score
                  0 = BLOCKED; 100 = fully clean
  Gas         4%  break-even speed
                  7-day BE → 0; same-block BE → 100
  Correlation 9%  portfolio diversification benefit
                  new tokens + chain → 100
                  full overlap → 20
  Regime      4%  macro fit
                  risk-off+stable → 90
                  risk-on+volatile → 90
  Hook Risk  12%  100 − hook riskScore
                  100 = vanilla or low-risk hook
                  0   = critical/blocked hook

Composite 80–100  exceptional across all dimensions
Composite 60–79   solid — enter with confidence
Composite 40–59   mixed — one or more weak spots
Composite < 40    significant concern — review labels
Composite < 25    avoid — multiple red flags

AllocationPct = Kelly × composite/100 (max 30%)`;

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

const HOOKS_TOOLTIP = `Uniswap v4 Hook Risk
Decoded from the pool's hooks contract address.
Risk score accumulation (0–100):
  beforeRemoveLiquidity  +30  can trap capital
  beforeAddLiquidity     +15  can restrict entry
  beforeSwap             +10  dynamic fees
  6+ callbacks           +15  high attack surface
  Source unverified      +25  (Sourcify check)
  TVL > $500K unverified +10
  Pool age < 7 days      +15

Risk levels:
  ✓ low      score < 25   APY ×1.10
  ⚠ medium   score < 50   APY ×0.95
  ⚡ high     score < 85   APY ×0.85
  🚫 critical score ≥ 85   blocked

Fee types:
  static          — fixed fee tier
  dynamic-unknown — beforeSwap modifies fees

Incentive haircuts on APY:
  real-fees           ×1.00
  hook-native-rewards ×0.60
  points-airdrop      ×0.10

Rebalance: none / auto-compound / range-rebalance`;

const TOKEN_RISK_TOOLTIP = `Token Risk Score (0–100)
Powered by GoPlus Security API (free).
Lower score = safer. TIER1 tokens = 5.

Hard blocks — agent will NOT enter:
  • Honeypot: cannot sell tokens
  • Owner can change holder balances
  • Stablecoin depegged > 5% from $1

Advisory scoring (+points per flag):
  Unverified source code   +20
  Upgradeable proxy        +15
  Hidden owner             +25
  Selfdestruct present     +30
  Blacklist / pause        +20
  Ownership reclaim        +25
  Transfers pausable       +15
  High buy/sell tax >10%   +15 each
  Top holder > 30% supply  +15
  Fewer than 100 holders   +10

Score  0–15  safe (TIER1 or clean API data)
Score 16–40  advisory — minor concerns
Score 41–70  caution — notable risks
Score  71+   high risk — agent avoids

"?" = not yet assessed (runs async after RAR)
BLOCKED = hard-blocked, agent will skip`;

const STABLE_RISK_TOOLTIP = `Stablecoin Risk Score (0–100)
Only shown for pools containing at least one stablecoin.

Six tracked dimensions (lower = safer):

  pegDeviation     current |price − $1| in %
                   > 1% = warning, > 5% = BLOCKED

  poolImbalance    |token0/token1 ratio − 1| × 100
                   stable/stable pools only — a skewed
                   ratio means the pool absorbed a depeg

  issuerRisk       protocol + collateral model tier
                   USDC/USDT ≈ 5–8  FRAX/crvUSD ≈ 18
                   USDe/USDB ≈ 25–30

  bridgeRisk       native = 0  /  CCTP = 0
                   bridged (.e / axl / cel) = 15–35
                   old Multichain wrappers = 35

  chainRisk        chain maturity (Ethereum=0, new L2=22)

  depegVolatility  stdDev(hourly price − $1) over 7 d
                   > 0.3% = the peg has been unstable recently

Score 0–20   healthy — low structural risk
Score 21–40  acceptable — some minor concerns
Score 41–60  caution — notable risk, worth scrutiny
Score 61+    high risk — stable yield may be misleading
BLOCKED      peg deviation > 5%, agent will skip`;

// ─── Main table ───────────────────────────────────────────────────────────────
export function YieldTable({ opportunities, isLoading }: Props) {
  const [networkFilter, setNetworkFilter] = useState<NetworkFilter>("all");
  const [sortKey,       setSortKey]       = useState<SortKey>("effectiveNetAPY");
  const [showRefOnly,   setShowRefOnly]   = useState(false);

  const filtered = opportunities
    .filter((o) => networkFilter === "all" || o.network === networkFilter)
    .filter((o) => !showRefOnly || o.apySource === "reference")
    .sort((a, b) => {
        if (sortKey === "effectiveNetAPY") {
        // Fall back: if not yet computed, use netAPY or displayAPY
        const aN = a.effectiveNetAPY > 0 ? a.effectiveNetAPY : (a.expectedIL > 0 ? a.netAPY : a.displayAPY);
        const bN = b.effectiveNetAPY > 0 ? b.effectiveNetAPY : (b.expectedIL > 0 ? b.netAPY : b.displayAPY);
        return bN - aN;
      }
      // For netAPY, fall back to displayAPY when expectedIL hasn't been computed yet
      if (sortKey === "netAPY") {
        const aN = a.expectedIL > 0 ? a.netAPY : a.displayAPY;
        const bN = b.expectedIL > 0 ? b.netAPY : b.displayAPY;
        return bN - aN;
      }
      // downsideScore: lower is safer — sort ascending (best first)
      if (sortKey === "downsideScore") {
        const aN = a.stressTest?.downsideScore ?? 100;
        const bN = b.stressTest?.downsideScore ?? 100;
        return aN - bN;
      }
      // composite scorecard sort
      if (sortKey === "composite") {
        const aN = a.scorecard?.composite ?? 0;
        const bN = b.scorecard?.composite ?? 0;
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
          <option value="effectiveNetAPY">Sort: Eff. APY ★</option>
          <option value="netAPY">Sort: Net APY</option>
          <option value="displayAPY">Sort: Fee APY</option>
          <option value="rar7d">Sort: RAR (7d)</option>
          <option value="rar24h">Sort: RAR (24h)</option>
          <option value="tvlUsd">Sort: TVL</option>
          <option value="volume24hUsd">Sort: Volume 24h</option>
          <option value="liquidityQuality">Sort: LQ Score</option>
          <option value="apyPersistence">Sort: Persistence</option>
          <option value="downsideScore">Sort: Stress (safest first)</option>
          <option value="composite">Sort: Scorecard</option>
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
                <Tooltip text={PERSIST_TOOLTIP}>
                  <span className="border-b border-dashed border-gray-400 cursor-help">Persist</span>
                  <InfoIcon />
                </Tooltip>
              </th>
              <th className="px-3 py-3">
                <Tooltip text={NET_APY_TOOLTIP}>
                  <span className="border-b border-dashed border-gray-400 cursor-help">Net APY</span>
                  <InfoIcon />
                </Tooltip>
              </th>
              <th className="px-3 py-3">
                <Tooltip text={EFF_APY_TOOLTIP}>
                  <span className="border-b border-dashed border-gray-400 cursor-help">Eff. APY ★</span>
                  <InfoIcon />
                </Tooltip>
              </th>
              <th className="px-3 py-3">Src</th>
              <th className="px-3 py-3">TVL</th>
              <th className="px-3 py-3">Vol 24h</th>
              <th className="px-3 py-3">
                <Tooltip text={LQ_TOOLTIP}>
                  <span className="border-b border-dashed border-gray-400 cursor-help">LQ</span>
                  <InfoIcon />
                </Tooltip>
              </th>
              <th className="px-3 py-3">
                <Tooltip text={TOKEN_RISK_TOOLTIP}>
                  <span className="border-b border-dashed border-gray-400 cursor-help">T.Risk</span>
                  <InfoIcon />
                </Tooltip>
              </th>
              <th className="px-3 py-3">
                <Tooltip text={STABLE_RISK_TOOLTIP}>
                  <span className="border-b border-dashed border-gray-400 cursor-help">S.Risk</span>
                  <InfoIcon />
                </Tooltip>
              </th>
              <th className="px-3 py-3">
                <Tooltip text={ADV_SEL_TOOLTIP}>
                  <span className="border-b border-dashed border-gray-400 cursor-help">Adv.Sel</span>
                  <InfoIcon />
                </Tooltip>
              </th>
              <th className="px-3 py-3">
                <Tooltip text={STRESS_TOOLTIP}>
                  <span className="border-b border-dashed border-gray-400 cursor-help">Stress</span>
                  <InfoIcon />
                </Tooltip>
              </th>
              <th className="px-3 py-3">
                <Tooltip text={SCORECARD_TOOLTIP}>
                  <span className="border-b border-dashed border-gray-400 cursor-help">Score</span>
                  <InfoIcon />
                </Tooltip>
              </th>
              <th className="px-3 py-3">
                <Tooltip text={HOOKS_TOOLTIP}>
                  <span className="border-b border-dashed border-gray-400 cursor-help">Hooks</span>
                  <InfoIcon />
                </Tooltip>
              </th>
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
              <tr><td colSpan={23} className="px-4 py-8 text-center text-gray-400">Scanning chains…</td></tr>
            )}
            {!isLoading && filtered.length === 0 && (
              <tr><td colSpan={23} className="px-4 py-8 text-center text-gray-400">No pools found</td></tr>
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
                <td className="px-3 py-2.5">
                  <div className="flex items-center gap-1.5">
                    <span className="font-mono font-semibold dark:text-gray-100">{o.pair}</span>
                    <EnrichmentBadge degraded={o.enrichmentDegraded} errors={o.enrichmentErrors ?? []} />
                  </div>
                </td>
                <td className="px-3 py-2.5 text-gray-500 dark:text-gray-400 text-xs">{o.feeTierLabel}</td>
                <td className="px-3 py-2.5">
                  <span className={`tabular-nums ${apyColor(o.displayAPY)}`}>
                    {o.displayAPY.toFixed(2)}%
                  </span>
                </td>
                <td className="px-3 py-2.5">
                  <PersistenceCell persistence={o.apyPersistence} median={o.medianAPY7d} current={o.displayAPY} />
                </td>
                <td className="px-3 py-2.5">
                  <NetAPYCell feeAPY={o.displayAPY} expectedIL={o.expectedIL} netAPY={o.netAPY} />
                </td>
                <td className="px-3 py-2.5">
                  <EffectiveAPYCell
                    effectiveNetAPY={o.effectiveNetAPY}
                    netAPY={o.netAPY}
                    capitalUtilization={o.capitalUtilization}
                    timeInRangePct={o.timeInRangePct}
                    feeCaptureEfficiency={o.feeCaptureEfficiency}
                    halfRangePct={o.halfRangePct}
                  />
                </td>
                <td className="px-3 py-2.5">
                  <SourceBadge source={o.apySource} />
                </td>
                <td className="px-3 py-2.5 tabular-nums text-gray-600 dark:text-gray-300 text-xs">{fmtUsd(o.tvlUsd)}</td>
                <td className="px-3 py-2.5 tabular-nums text-gray-600 dark:text-gray-300 text-xs">{fmtUsd(o.volume24hUsd)}</td>
                <td className="px-3 py-2.5"><LQBadge lq={o.liquidityQuality} /></td>
                <td className="px-3 py-2.5"><TokenRiskBadge tokenRisk={o.tokenRisk} /></td>
                <td className="px-3 py-2.5"><StableRiskBadge stableRisk={o.stablecoinRisk} /></td>
                <td className="px-3 py-2.5"><AdvSelBadge adv={o.adverseSelection} /></td>
                <td className="px-3 py-2.5"><StressBadge stress={o.stressTest} /></td>
                <td className="px-3 py-2.5"><ScorecardBadge scorecard={o.scorecard} /></td>
                <td className="px-3 py-2.5"><HooksBadge hookFlags={o.hookFlags ?? []} hasCustom={o.hasCustomHooks ?? false} hookAnalysis={o.hookAnalysis ?? null} /></td>
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
        <span><strong>Eff. APY ★</strong> = Net APY × (TiR × FCE) &nbsp;·&nbsp; realistic yield on deployed capital &nbsp;·&nbsp; default sort</span>
        <span><strong>Net APY</strong> = Fee APY − Expected IL</span>
        <span><strong>RAR</strong> = APY ÷ annualised vol (Sharpe, Rf=0) &nbsp;·&nbsp; higher is better</span>
        <span><strong>LQ</strong> = liquidity quality 0–100 &nbsp;·&nbsp; used as √(lq/100) multiplier on RAR ranking</span>
        <span><strong>Persist</strong> = medianAPY7d / currentAPY &nbsp;·&nbsp; &lt;50% = volume spike, not durable yield</span>
        <span><strong>T.Risk</strong> = GoPlus token safety score 0–100 &nbsp;·&nbsp; BLOCKED = agent will not enter</span>
        <span><strong>S.Risk</strong> = stablecoin risk 0–100 (peg, imbalance, issuer, bridge, chain, depeg vol) &nbsp;·&nbsp; only for stable pools</span>
        <span><strong>Adv.Sel</strong> = adverse selection 0–100 &nbsp;·&nbsp; elevated/high = fees earned from informed directional traders, not balanced flow</span>
        <span><strong>Stress</strong> = downside score 0–100 over 8 adversarial 30-day scenarios &nbsp;·&nbsp; 0 = all profitable, 100 = worst case ≥ −20% loss &nbsp;·&nbsp; ES = avg of 3 worst</span>
        <span><strong>Score</strong> = composite decision scorecard 0–100 (9 dimensions incl. hookRisk; neutral: yield 22%, IL 18%, LQ 13%, vol 9%, token 9%, gas 4%, corr 9%, regime 4%, hook 12%) &nbsp;·&nbsp; hover for breakdown</span>
        <span><strong>Hooks</strong> = v4 hook risk (Sourcify verified + callback risk score) &nbsp;·&nbsp; ⚫ vanilla &nbsp;·&nbsp; ✓ low · ⚠ medium · ⚡ high · 🚫 blocked</span>
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

function EffectiveAPYCell({ effectiveNetAPY, netAPY, capitalUtilization, timeInRangePct, feeCaptureEfficiency, halfRangePct }: {
  effectiveNetAPY: number; netAPY: number; capitalUtilization: number;
  timeInRangePct: number; feeCaptureEfficiency: number; halfRangePct: number;
}) {
  if (!capitalUtilization) {
    return <span className="text-gray-300 dark:text-gray-600 text-xs">—</span>;
  }
  const tip = [
    `Effective Net APY = ${effectiveNetAPY.toFixed(2)}%`,
    `Net APY × capitalUtilization`,
    `  Net APY:     ${netAPY.toFixed(2)}%`,
    `  Utilization: ${(capitalUtilization * 100).toFixed(1)}%`,
    ``,
    `  TimeInRange: ${(timeInRangePct * 100).toFixed(1)}%  (±${halfRangePct.toFixed(2)}% range)`,
    `  FCE:         ${(feeCaptureEfficiency * 100).toFixed(1)}%`,
  ].join("\n");
  const color = effectiveNetAPY >= 20 ? "text-emerald-600 dark:text-emerald-400"
    : effectiveNetAPY >= 5  ? "text-green-500 dark:text-green-400"
    : effectiveNetAPY >= 0  ? "text-yellow-500 dark:text-yellow-400"
    : "text-red-500 dark:text-red-400";
  const cuColor = capitalUtilization >= 0.7 ? "text-emerald-500" : capitalUtilization >= 0.5 ? "text-yellow-500" : "text-red-500";
  return (
    <Tooltip text={tip}>
      <span className="cursor-help flex items-center gap-1">
        <span className={`font-bold tabular-nums text-xs ${color}`}>
          {effectiveNetAPY.toFixed(1)}%
        </span>
        <span className={`tabular-nums text-xs ${cuColor}`}>
          ({(capitalUtilization * 100).toFixed(0)}%)
        </span>
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

function PersistenceCell({ persistence, median, current }: {
  persistence: number; median: number; current: number;
}) {
  if (!median) return <span className="text-gray-300 dark:text-gray-600 text-xs">…</span>;
  const pct   = Math.round(persistence * 100);
  const color = pct >= 80 ? "text-emerald-600 dark:text-emerald-400"
    : pct >= 50 ? "text-yellow-500 dark:text-yellow-400"
    : "text-red-500 dark:text-red-400";
  const spike = pct < 50;
  const tip   = `Persistence: ${pct}%\nCurrent APY: ${current.toFixed(1)}%\n7d median: ${median.toFixed(1)}%\n${spike ? "⚡ Likely volume spike" : "Yield appears durable"}`;
  return (
    <Tooltip text={tip}>
      <span className={`font-mono tabular-nums text-xs cursor-help ${color}`}>
        {spike && <span className="mr-0.5">⚡</span>}{pct}%
      </span>
    </Tooltip>
  );
}

function LQBadge({ lq }: { lq: number }) {
  if (!lq) return <span className="text-gray-300 dark:text-gray-600 text-xs">…</span>;
  const color = lq >= 75 ? "text-emerald-600 dark:text-emerald-400"
    : lq >= 50 ? "text-green-500 dark:text-green-400"
    : lq >= 30 ? "text-yellow-500 dark:text-yellow-400"
    : "text-red-500 dark:text-red-400";
  return (
    <span className={`font-mono font-semibold tabular-nums text-xs ${color}`}>
      {lq}
    </span>
  );
}

function StableRiskBadge({ stableRisk }: { stableRisk: StablecoinRiskResult | null | undefined }) {
  // No stablecoins in this pool — show nothing
  if (stableRisk == null) {
    return <span className="text-gray-200 dark:text-gray-700 text-xs">—</span>;
  }
  if (stableRisk.blockEntry) {
    const tip = `BLOCKED: depeg > 5%\nPeg deviation: ${stableRisk.pegDeviation.toFixed(2)}%\n${stableRisk.flags.join("\n")}`;
    return (
      <Tooltip text={tip}>
        <span className="text-xs px-1.5 py-0.5 rounded-full font-bold bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400 cursor-help">
          BLOCK
        </span>
      </Tooltip>
    );
  }

  const score = stableRisk.compositeScore;
  const color = score <= 20 ? "text-emerald-600 dark:text-emerald-400"
    : score <= 40            ? "text-green-500 dark:text-green-400"
    : score <= 60            ? "text-yellow-500 dark:text-yellow-400"
    : "text-orange-500 dark:text-orange-400";

  // Build tooltip with all 6 dimensions
  const imbalanceLine = stableRisk.isStablePool
    ? `Pool imbalance: ${stableRisk.poolImbalance.toFixed(3)}%`
    : "Pool imbalance: n/a";
  const volLine = stableRisk.depegVolatility > 0
    ? `Depeg vol 7d:   ${stableRisk.depegVolatility.toFixed(3)}% stdDev`
    : "Depeg vol 7d:   no history";
  const tip = [
    `Composite: ${score}/100`,
    `Peg deviation:  ${stableRisk.pegDeviation.toFixed(3)}%`,
    imbalanceLine,
    `Issuer risk:    ${stableRisk.issuerRisk}/30`,
    `Bridge risk:    ${stableRisk.bridgeRisk}/35`,
    `Chain risk:     ${stableRisk.chainRisk}/25`,
    volLine,
    ...(stableRisk.flags.length ? ["", ...stableRisk.flags] : []),
  ].join("\n");

  return (
    <Tooltip text={tip}>
      <span className={`font-mono font-semibold tabular-nums text-xs cursor-help ${color}`}>
        {score}
      </span>
    </Tooltip>
  );
}

function TokenRiskBadge({ tokenRisk }: { tokenRisk: PoolRiskResult | null | undefined }) {
  if (tokenRisk == null) {
    return <span className="text-gray-300 dark:text-gray-600 text-xs">…</span>;
  }
  if (tokenRisk.blockEntry) {
    const tip = `BLOCKED\n${tokenRisk.flags.join("\n")}`;
    return (
      <Tooltip text={tip}>
        <span className="text-xs px-1.5 py-0.5 rounded-full font-bold bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400 cursor-help">
          BLOCK
        </span>
      </Tooltip>
    );
  }
  const score = tokenRisk.poolRiskScore;
  const color = score <= 15 ? "text-emerald-600 dark:text-emerald-400"
    : score <= 40            ? "text-yellow-500 dark:text-yellow-400"
    : score <= 70            ? "text-orange-500 dark:text-orange-400"
    : "text-red-500 dark:text-red-400";
  const tip = tokenRisk.flags.length
    ? `Score: ${score}/100\n${tokenRisk.flags.join("\n")}`
    : `Score: ${score}/100 — no flags`;
  return (
    <Tooltip text={tip}>
      <span className={`font-mono font-semibold tabular-nums text-xs cursor-help ${color}`}>
        {score}
      </span>
    </Tooltip>
  );
}

function AdvSelBadge({ adv }: { adv: AdverseSelectionResult | null | undefined }) {
  if (adv == null) {
    return <span className="text-gray-300 dark:text-gray-600 text-xs">…</span>;
  }
  const { score, quality, feeVsPriceMove, volumeDuringLargeMoves, postTradePriceDrift, volatilityAfterVolumeSpikes, flags } = adv;
  const color = quality === "high"     ? "text-red-500 dark:text-red-400"
    : quality === "elevated"           ? "text-orange-500 dark:text-orange-400"
    : quality === "moderate"           ? "text-yellow-500 dark:text-yellow-400"
    : "text-emerald-600 dark:text-emerald-400";
  const tip = [
    `Adverse selection: ${score}/100 (${quality})`,
    ``,
    `Fee vs price move:    ${feeVsPriceMove.toFixed(0)}/100`,
    `Volume during moves:  ${volumeDuringLargeMoves.toFixed(0)}/100`,
    `Price drift:          ${(postTradePriceDrift * 100).toFixed(0)}%`,
    `Vol acceleration:     ${volatilityAfterVolumeSpikes.toFixed(2)}×`,
    ...(flags.length ? [``, ...flags] : []),
  ].join("\n");
  return (
    <Tooltip text={tip}>
      <span className={`font-mono font-semibold tabular-nums text-xs cursor-help ${color}`}>
        {score}
      </span>
    </Tooltip>
  );
}

function StressBadge({ stress }: { stress: StressTestResult | null | undefined }) {
  if (stress == null) {
    return <span className="text-gray-300 dark:text-gray-600 text-xs">…</span>;
  }
  const { downsideScore, worstCase, expectedShortfall30dPct, baseline30dPct, scenarios } = stress;
  const color = downsideScore === 0 ? "text-emerald-600 dark:text-emerald-400"
    : downsideScore < 30            ? "text-green-500 dark:text-green-400"
    : downsideScore < 60            ? "text-yellow-500 dark:text-yellow-400"
    : "text-red-500 dark:text-red-400";
  const scenarioLines = scenarios.slice(0, 5).map(
    s => `  ${s.name.padEnd(14)} ${s.netReturn30dPct >= 0 ? "+" : ""}${s.netReturn30dPct.toFixed(1)}%${s.breachesRange ? " [out of range]" : ""}`
  );
  const tip = [
    `Stress test (30d horizon)`,
    `Downside score: ${downsideScore.toFixed(0)}/100`,
    `Baseline 30d:   ${baseline30dPct >= 0 ? "+" : ""}${baseline30dPct.toFixed(1)}%`,
    `Worst case:     ${worstCase.netReturn30dPct.toFixed(1)}% (${worstCase.name})`,
    `Exp. shortfall: ${expectedShortfall30dPct.toFixed(1)}% (avg 3 worst)`,
    ``,
    `Worst 5 scenarios:`,
    ...scenarioLines,
  ].join("\n");
  return (
    <Tooltip text={tip}>
      <span className={`font-mono font-semibold tabular-nums text-xs cursor-help ${color}`}>
        {downsideScore.toFixed(0)}
      </span>
    </Tooltip>
  );
}

function ScorecardBadge({ scorecard }: { scorecard: DecisionScorecard | null | undefined }) {
  if (scorecard == null) {
    return <span className="text-gray-300 dark:text-gray-600 text-xs">…</span>;
  }
  const { composite, yield: y, il, liquidity, volatility, tokenRisk, gas, correlation, regime, hookRisk, allocationPct, weightSet, labels } = scorecard;
  const color = composite >= 80 ? "text-emerald-600 dark:text-emerald-400"
    : composite >= 60            ? "text-green-500 dark:text-green-400"
    : composite >= 40            ? "text-yellow-500 dark:text-yellow-400"
    : "text-red-500 dark:text-red-400";

  const REGIME_WEIGHTS: Record<string, Record<string, number>> = {
    "risk-off": { Yield: 0.09, IL: 0.28, Liquidity: 0.14, Volatility: 0.14, "Token Risk": 0.14, Gas: 0.04, Correlation: 0.06, Regime: 0.03, "Hook Risk": 0.08 },
    "neutral":  { Yield: 0.22, IL: 0.18, Liquidity: 0.13, Volatility: 0.09, "Token Risk": 0.09, Gas: 0.04, Correlation: 0.09, Regime: 0.04, "Hook Risk": 0.12 },
    "risk-on":  { Yield: 0.32, IL: 0.09, Liquidity: 0.13, Volatility: 0.07, "Token Risk": 0.07, Gas: 0.04, Correlation: 0.11, Regime: 0.07, "Hook Risk": 0.10 },
  };
  const activeW = REGIME_WEIGHTS[weightSet ?? "neutral"];
  const wLabel  = weightSet === "risk-off" ? "🔴 risk-off weights" : weightSet === "risk-on" ? "🟢 risk-on weights" : "⚪ neutral weights";

  const dim = (name: string, score: number, label: string) => {
    const w = activeW[name];
    return `  ${name.padEnd(12)} ${String(Math.round(score)).padStart(3)}/100  ×${(w * 100).toFixed(0)}%  ${label}`;
  };
  const tip = [
    `Composite: ${composite.toFixed(0)}/100   alloc: ${allocationPct.toFixed(1)}%   ${wLabel}`,
    ``,
    dim("Yield",       y,           labels.yield),
    dim("IL",          il,          labels.il),
    dim("Liquidity",   liquidity,   labels.liquidity),
    dim("Volatility",  volatility,  labels.volatility),
    dim("Token Risk",  tokenRisk,   labels.tokenRisk),
    dim("Gas",         gas,         labels.gas),
    dim("Correlation", correlation, labels.correlation),
    dim("Regime",      regime,      labels.regime),
    dim("Hook Risk",   hookRisk ?? 100, labels.hookRisk ?? "no hook"),
  ].join("\n");
  return (
    <Tooltip text={tip}>
      <span className={`font-mono font-semibold tabular-nums text-xs cursor-help ${color}`}>
        {composite.toFixed(0)}
      </span>
    </Tooltip>
  );
}

function HooksBadge({ hookFlags, hasCustom, hookAnalysis }: {
  hookFlags:    string[];
  hasCustom:    boolean;
  hookAnalysis: HookAnalysisResult | null;
}) {
  if (!hasCustom || hookFlags.length === 0) {
    return <span className="text-gray-300 dark:text-gray-600 text-xs" title="Vanilla pool — no custom hooks">⚫</span>;
  }

  // While hookAnalysis is still loading, fall back to simple blue dot
  if (!hookAnalysis) {
    const tip = [
      `Uniswap v4 Hooked Pool (analysing…)`,
      `${hookFlags.length} active callback${hookFlags.length > 1 ? "s" : ""}:`,
      ...hookFlags.map(f => `  • ${f}`),
    ].join("\n");
    return (
      <Tooltip text={tip}>
        <span className="text-blue-500 dark:text-blue-400 text-xs cursor-help">🔵 {hookFlags.length}</span>
      </Tooltip>
    );
  }

  const { riskLevel, riskScore, feeType, rebalanceType, sourceVerified, isBlocked, callbacks } = hookAnalysis;

  const [icon, colorClass] =
    isBlocked           ? ["🚫", "text-red-500 dark:text-red-400"]
    : riskLevel === "high"   ? ["⚡", "text-orange-500 dark:text-orange-400"]
    : riskLevel === "medium" ? ["⚠", "text-yellow-500 dark:text-yellow-400"]
    : ["✓", "text-emerald-600 dark:text-emerald-400"];

  const tip = [
    `Hook Risk: ${riskScore}/100 (${riskLevel})${isBlocked ? " — BLOCKED" : ""}`,
    `Fee type:    ${feeType}`,
    `Rebalance:   ${rebalanceType}`,
    `Source:      ${sourceVerified ? "verified ✓" : "unverified ✗"}`,
    callbacks.length ? `Callbacks (${callbacks.length}):` : "",
    ...callbacks.map(f => `  • ${f}`),
  ].filter(Boolean).join("\n");

  return (
    <Tooltip text={tip}>
      <span className={`font-mono text-xs cursor-help ${colorClass}`}>
        {icon} {callbacks.length}
      </span>
    </Tooltip>
  );
}

function EnrichmentBadge({ degraded, errors }: {
  degraded: boolean | undefined;
  errors: { stage: string; message: string; timestamp: number }[];
}) {
  if (!degraded || errors.length === 0) return null;
  const tip = errors.map(e => `${e.stage}: ${e.message}`).join("\n");
  return (
    <Tooltip text={`Enrichment degraded\n${tip}`}>
      <span className="inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-semibold bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">
        degraded
      </span>
    </Tooltip>
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
