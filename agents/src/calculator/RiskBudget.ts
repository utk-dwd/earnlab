/**
 * RiskBudget — portfolio-level risk constraints.
 *
 * Six limits enforced on every entry decision:
 *
 *   maxChainExposure            = 40%  no single chain > 40% of total capital
 *   maxTokenExposure            = 40%  no single token > 40% of total capital (50/50 LP split)
 *   maxVolatilePairExposure     = 50%  non-stable/non-stable positions combined < 50%
 *   maxStablecoinIssuerExposure = 60%  no single stable issuer (Circle, Tether…) > 60%
 *   maxSinglePoolExposure       = 30%  no individual position > 30%
 *   minCashBuffer               = 10%  always keep ≥ 10% cash
 *
 * `computeRiskBudgetState` — full portfolio snapshot (used in getSummary / API response).
 * `checkRiskBudget`        — pre-entry violation check (used in toolOpen / rebalance).
 *
 * Exported helpers (rbPairTokens, rbIssuerOf, rbIsVolatile) are used by the
 * deploy() greedy loop so it can do incremental checks without constructing
 * MockPosition objects for not-yet-opened provisional selections.
 */

import type { MockPosition } from "../PortfolioManager";

// ─── Budget limits ────────────────────────────────────────────────────────────

export const RISK_BUDGET = {
  maxChainExposurePct:            40,
  maxTokenExposurePct:            40,
  maxVolatilePairExposurePct:     50,
  maxStablecoinIssuerExposurePct: 60,
  maxSinglePoolPct:               30,
  minCashBufferPct:               10,
} as const;

// ─── Stablecoin → issuer ──────────────────────────────────────────────────────

const STABLECOIN_ISSUERS: Record<string, string> = {
  USDC:    "Circle",
  USDBC:   "Circle",
  "USDC.E":"Circle",
  USDT:    "Tether",
  DAI:     "Sky",
  USDS:    "Sky",
  FRAX:    "Frax",
  LUSD:    "Liquity",
  BOLD:    "Liquity",
  USDB:    "Blur",
  CUSD:    "Celo",
  GHO:     "Aave",
  CRVUSD:  "Curve",
  PYUSD:   "PayPal",
  SUSD:    "Synthetix",
  MIM:     "Abracadabra",
  BUSD:    "Binance",
};

const STABLES = new Set(Object.keys(STABLECOIN_ISSUERS));

const TOKEN_EQUIV: Record<string, string> = {
  WETH: "ETH", CBETH: "ETH", WSTETH: "ETH",
  RETH: "ETH", EZETH: "ETH", WEETH:  "ETH",
  WBTC: "BTC",
};

// ─── Exported helpers (used by PortfolioManager.deploy() greedy loop) ─────────

/** Normalise and split "WETH/USDC" → ["ETH", "USDC"]. */
export function rbPairTokens(pair: string): [string, string] {
  const parts = pair.split("/").map(s => {
    const u = s.trim().toUpperCase();
    return TOKEN_EQUIV[u] ?? u;
  });
  return [parts[0] ?? "", parts[1] ?? parts[0] ?? ""];
}

/** Returns the stablecoin issuer for a token, or null if it is not a stablecoin. */
export function rbIssuerOf(token: string): string | null {
  return STABLECOIN_ISSUERS[token.toUpperCase()] ?? null;
}

/**
 * True when the pair is NOT stable/stable (i.e. at least one token is volatile).
 * Volatile pairs carry IL risk; stable pairs don't.
 */
export function rbIsVolatile(pair: string): boolean {
  const [t0, t1] = rbPairTokens(pair);
  return !STABLES.has(t0) || !STABLES.has(t1);
}

// ─── Public types ─────────────────────────────────────────────────────────────

export interface RiskBudgetDimension {
  id:       string;
  label:    string;
  usedPct:  number;
  limitPct: number;
  ok:       boolean;
  topItem?: string;
}

export interface RiskBudgetState {
  dimensions:    RiskBudgetDimension[];
  cashBufferPct: number;
  cashOk:        boolean;
  canOpenNew:    boolean;
  violations:    string[];
}

export interface BudgetViolation {
  dimension: string;
  message:   string;
}

// ─── Portfolio snapshot ────────────────────────────────────────────────────────

export function computeRiskBudgetState(
  positions: MockPosition[],
  cash:      number,
  total:     number,
): RiskBudgetState {
  if (total <= 0) return emptyState(cash, total);

  const open = positions.filter(p => p.status === "open");

  // Chain
  const chainMap = new Map<string, number>();
  for (const p of open) chainMap.set(p.chainName, (chainMap.get(p.chainName) ?? 0) + p.currentValueUsd);
  const [topChain, topChainUsd] = maxOf(chainMap);

  // Token (50/50 split)
  const tokenMap = new Map<string, number>();
  for (const p of open) {
    const half = p.currentValueUsd / 2;
    for (const t of rbPairTokens(p.pair)) tokenMap.set(t, (tokenMap.get(t) ?? 0) + half);
  }
  const [topToken, topTokenUsd] = maxOf(tokenMap);

  // Volatile pairs (combined)
  const volatileUsd = open.filter(p => rbIsVolatile(p.pair)).reduce((s, p) => s + p.currentValueUsd, 0);

  // Stablecoin issuer (50/50 split)
  const issuerMap = new Map<string, number>();
  for (const p of open) {
    const half = p.currentValueUsd / 2;
    for (const t of rbPairTokens(p.pair)) {
      const iss = rbIssuerOf(t);
      if (iss) issuerMap.set(iss, (issuerMap.get(iss) ?? 0) + half);
    }
  }
  const [topIssuer, topIssuerUsd] = maxOf(issuerMap);

  // Single pool
  let maxPoolPct = 0, maxPoolLabel = "";
  for (const p of open) {
    const pct = p.currentValueUsd / total * 100;
    if (pct > maxPoolPct) { maxPoolPct = pct; maxPoolLabel = p.pair; }
  }

  const cashPct = cash / total * 100;
  const cashOk  = cashPct >= RISK_BUDGET.minCashBufferPct;

  const dims: RiskBudgetDimension[] = [
    mkDim("chain",    "Chain",           topChainUsd  / total * 100, RISK_BUDGET.maxChainExposurePct,            topChain    || undefined),
    mkDim("token",    "Token",           topTokenUsd  / total * 100, RISK_BUDGET.maxTokenExposurePct,            topToken    || undefined),
    mkDim("volatile", "Volatile Pairs",  volatileUsd  / total * 100, RISK_BUDGET.maxVolatilePairExposurePct),
    mkDim("issuer",   "Stable Issuer",   topIssuerUsd / total * 100, RISK_BUDGET.maxStablecoinIssuerExposurePct, topIssuer   || undefined),
    mkDim("pool",     "Single Pool",     maxPoolPct,                  RISK_BUDGET.maxSinglePoolPct,               maxPoolLabel || undefined),
  ];

  const violations = [
    ...dims.filter(d => !d.ok).map(d =>
      `${d.label} ${d.usedPct.toFixed(0)}%>${d.limitPct}%${d.topItem ? ` (${d.topItem})` : ""}`
    ),
    ...(!cashOk ? [`Cash ${cashPct.toFixed(0)}%<${RISK_BUDGET.minCashBufferPct}% min`] : []),
  ];

  return {
    dimensions:    dims,
    cashBufferPct: +cashPct.toFixed(1),
    cashOk,
    canOpenNew:    cashOk && dims.every(d => d.ok),
    violations,
  };
}

// ─── Entry pre-check ──────────────────────────────────────────────────────────

/**
 * Returns every budget constraint that would be violated by opening `oppPair`
 * on `oppChain` with `newValueUsd`.  Empty = all clear.
 *
 * For rebalances, pass simulated cash (this.cash + exit proceeds) so the
 * cash-buffer check doesn't falsely block funded switches.
 */
export function checkRiskBudget(
  oppPair:     string,
  oppChain:    string,
  newValueUsd: number,
  positions:   MockPosition[],
  cash:        number,
  total:       number,
): BudgetViolation[] {
  if (total <= 0 || newValueUsd <= 0) return [];
  const open = positions.filter(p => p.status === "open");
  const half = newValueUsd / 2;
  const viols: BudgetViolation[] = [];

  // Cash buffer
  const cashAfterPct = (cash - newValueUsd) / total * 100;
  if (cashAfterPct < RISK_BUDGET.minCashBufferPct) {
    viols.push({ dimension: "cash",
      message: `Cash buffer would fall to ${cashAfterPct.toFixed(0)}% (min ${RISK_BUDGET.minCashBufferPct}%)` });
  }

  // Chain
  const chainCur    = open.filter(p => p.chainName === oppChain).reduce((s, p) => s + p.currentValueUsd, 0);
  const chainAfterPct = (chainCur + newValueUsd) / total * 100;
  if (chainAfterPct > RISK_BUDGET.maxChainExposurePct) {
    viols.push({ dimension: "chain",
      message: `${oppChain} chain ${chainAfterPct.toFixed(0)}%>${RISK_BUDGET.maxChainExposurePct}% limit` });
  }

  // Token
  const tokenMap = new Map<string, number>();
  for (const p of open) {
    const h = p.currentValueUsd / 2;
    for (const t of rbPairTokens(p.pair)) tokenMap.set(t, (tokenMap.get(t) ?? 0) + h);
  }
  for (const t of rbPairTokens(oppPair)) {
    const after = ((tokenMap.get(t) ?? 0) + half) / total * 100;
    if (after > RISK_BUDGET.maxTokenExposurePct) {
      viols.push({ dimension: "token",
        message: `${t} token ${after.toFixed(0)}%>${RISK_BUDGET.maxTokenExposurePct}% limit` });
    }
  }

  // Volatile pairs
  if (rbIsVolatile(oppPair)) {
    const volCur     = open.filter(p => rbIsVolatile(p.pair)).reduce((s, p) => s + p.currentValueUsd, 0);
    const afterPct   = (volCur + newValueUsd) / total * 100;
    if (afterPct > RISK_BUDGET.maxVolatilePairExposurePct) {
      viols.push({ dimension: "volatile",
        message: `Volatile pairs ${afterPct.toFixed(0)}%>${RISK_BUDGET.maxVolatilePairExposurePct}% limit` });
    }
  }

  // Stablecoin issuer
  const issuerMap = new Map<string, number>();
  for (const p of open) {
    const h = p.currentValueUsd / 2;
    for (const t of rbPairTokens(p.pair)) {
      const iss = rbIssuerOf(t);
      if (iss) issuerMap.set(iss, (issuerMap.get(iss) ?? 0) + h);
    }
  }
  const seen = new Set<string>();
  for (const t of rbPairTokens(oppPair)) {
    const iss = rbIssuerOf(t);
    if (iss && !seen.has(iss)) {
      seen.add(iss);
      const after = ((issuerMap.get(iss) ?? 0) + half) / total * 100;
      if (after > RISK_BUDGET.maxStablecoinIssuerExposurePct) {
        viols.push({ dimension: "issuer",
          message: `${iss} issuer ${after.toFixed(0)}%>${RISK_BUDGET.maxStablecoinIssuerExposurePct}% limit` });
      }
    }
  }

  // Single pool
  const poolPct = newValueUsd / total * 100;
  if (poolPct > RISK_BUDGET.maxSinglePoolPct) {
    viols.push({ dimension: "pool",
      message: `Position ${poolPct.toFixed(0)}%>${RISK_BUDGET.maxSinglePoolPct}% single-pool limit` });
  }

  return viols;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function mkDim(id: string, label: string, usedPct: number, limitPct: number, topItem?: string): RiskBudgetDimension {
  return { id, label, usedPct: +usedPct.toFixed(1), limitPct, ok: usedPct <= limitPct, topItem };
}

function maxOf(map: Map<string, number>): [string, number] {
  let mk = "", mv = 0;
  for (const [k, v] of map) if (v > mv) { mk = k; mv = v; }
  return [mk, mv];
}

function emptyState(cash: number, total: number): RiskBudgetState {
  const cashPct = total > 0 ? cash / total * 100 : 100;
  return {
    dimensions: [
      mkDim("chain",    "Chain",          0, RISK_BUDGET.maxChainExposurePct),
      mkDim("token",    "Token",          0, RISK_BUDGET.maxTokenExposurePct),
      mkDim("volatile", "Volatile Pairs", 0, RISK_BUDGET.maxVolatilePairExposurePct),
      mkDim("issuer",   "Stable Issuer",  0, RISK_BUDGET.maxStablecoinIssuerExposurePct),
      mkDim("pool",     "Single Pool",    0, RISK_BUDGET.maxSinglePoolPct),
    ],
    cashBufferPct: +cashPct.toFixed(1),
    cashOk:        cashPct >= RISK_BUDGET.minCashBufferPct,
    canOpenNew:    cashPct >= RISK_BUDGET.minCashBufferPct,
    violations:    [],
  };
}
