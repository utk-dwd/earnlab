/**
 * PortfolioCorrelation — pairwise Pearson correlation matrix built from
 * the hourly APY snapshots stored in APYHistoryStore.
 *
 * WHY APY SERIES (not price series):
 *   Fee APY = (volume24h × feeTier / tvl) × 365.  Volume and TVL are the
 *   two key drivers of LP revenue and drawdown risk.  Two ETH/stablecoin
 *   pools on different chains will exhibit correlated APY when market stress
 *   drains volume simultaneously — exactly the event the optimizer must
 *   hedge against.  Price series correlation is per-token and would miss
 *   the pool-level effect.
 *
 * ALIGNMENT:
 *   Each pool's series is keyed by `hour_key` (floor(ms/3_600_000)).
 *   Correlation is computed only on hours where BOTH pools have a snapshot
 *   (inner join on hour_key).  Pools with fewer than MIN_OVERLAP common
 *   samples fall back to NaN, which the optimizer treats as "use heuristic".
 *
 * INTERPRETATION:
 *   ρ = +1.0  perfectly in-sync (bad — adds concentrated risk)
 *   ρ =  0.0  uncorrelated (neutral)
 *   ρ = -1.0  perfectly counter-cyclical (good — genuine diversification)
 *
 * The corrMult applied in PortfolioOptimizer:
 *   corrMult = clamp(1 + ρ × 0.8, 0.2, 1.8)
 *
 * So ρ=+1 → corrMult=1.8 (risk amplified 80%)
 *    ρ= 0 → corrMult=1.0 (neutral)
 *    ρ=-1 → corrMult=0.2 (risk reduced 80% — strong diversifier)
 */

const MIN_OVERLAP = 6;   // minimum common hourly samples to trust the estimate

export type APYPoint          = { hourKey: number; apy: number };
export type CorrelationMatrix = Map<string, Map<string, number>>;

// ─── Matrix builder ───────────────────────────────────────────────────────────

/**
 * Build a full pairwise correlation matrix from the given APY time series map.
 * Off-diagonal entries are NaN when the two pools share fewer than MIN_OVERLAP
 * hourly samples (caller should fall back to heuristic in that case).
 */
export function buildCorrelationMatrix(
  seriesMap: Map<string, APYPoint[]>,
): CorrelationMatrix {
  const matrix: CorrelationMatrix = new Map();
  const ids = [...seriesMap.keys()];

  for (const idA of ids) {
    const row = new Map<string, number>();
    const seriesA = seriesMap.get(idA)!;

    for (const idB of ids) {
      if (idA === idB) {
        row.set(idB, 1.0);
      } else {
        row.set(idB, pearsonCorrelation(seriesA, seriesMap.get(idB)!));
      }
    }
    matrix.set(idA, row);
  }

  return matrix;
}

/**
 * Average pairwise correlation between a candidate pool and a set of
 * already-selected portfolio pools.
 *
 * Returns NaN if no pool pair has sufficient overlap — caller should fall back
 * to the token/chain heuristic in that case.
 */
export function avgCorrelationWith(
  candidateId:  string,
  portfolioIds: string[],
  matrix:       CorrelationMatrix,
): number {
  if (portfolioIds.length === 0) return 0;

  const row = matrix.get(candidateId);
  if (!row) return NaN;

  const values: number[] = [];
  for (const pid of portfolioIds) {
    const ρ = row.get(pid);
    if (ρ !== undefined && !isNaN(ρ)) values.push(ρ);
  }

  if (values.length === 0) return NaN;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

// ─── Pearson correlation (aligned on hour_key) ────────────────────────────────

function pearsonCorrelation(a: APYPoint[], b: APYPoint[]): number {
  // Inner join on hour_key — only hours where both pools have a snapshot
  const bMap = new Map<number, number>(b.map(pt => [pt.hourKey, pt.apy]));
  const xVals: number[] = [];
  const yVals: number[] = [];

  for (const pt of a) {
    const bApy = bMap.get(pt.hourKey);
    if (bApy !== undefined && pt.apy > 0 && bApy > 0) {
      xVals.push(pt.apy);
      yVals.push(bApy);
    }
  }

  const n = xVals.length;
  if (n < MIN_OVERLAP) return NaN;

  const meanX = xVals.reduce((s, v) => s + v, 0) / n;
  const meanY = yVals.reduce((s, v) => s + v, 0) / n;

  let cov = 0, varX = 0, varY = 0;
  for (let i = 0; i < n; i++) {
    const dx = xVals[i] - meanX;
    const dy = yVals[i] - meanY;
    cov  += dx * dy;
    varX += dx * dx;
    varY += dy * dy;
  }

  const denom = Math.sqrt(varX * varY);
  if (denom < 1e-10) return 0;  // constant series (stable pool) → 0 corr
  return Math.max(-1, Math.min(1, cov / denom));
}
