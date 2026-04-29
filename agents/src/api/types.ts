// Shared API contract types. Keep this file free of runtime imports so the
// frontend can import these types without pulling agent code into the bundle.

export interface TokenRiskResult {
  symbol:     string;
  riskScore:  number;
  blockEntry: boolean;
  flags:      string[];
  tier1:      boolean;
  checkedAt:  number;
}

export interface PoolRiskResult {
  token0:        TokenRiskResult;
  token1:        TokenRiskResult;
  poolRiskScore: number;
  blockEntry:    boolean;
  flags:         string[];
  checkedAt:     number;
}

export interface StableTokenRisk {
  symbol:          string;
  pegDeviation:    number;
  issuerRisk:      number;
  bridgeRisk:      number;
  depegVolatility: number;
  tokenScore:      number;
}

export interface StablecoinRiskResult {
  isStablePool:    boolean;
  hasStable:       boolean;
  token0Risk:      StableTokenRisk | null;
  token1Risk:      StableTokenRisk | null;
  pegDeviation:    number;
  poolImbalance:   number;
  issuerRisk:      number;
  bridgeRisk:      number;
  chainRisk:       number;
  depegVolatility: number;
  compositeScore:  number;
  blockEntry:      boolean;
  flags:           string[];
  checkedAt:       number;
}

export interface AdverseSelectionResult {
  score:                       number;
  quality:                     "low" | "moderate" | "elevated" | "high";
  feeVsPriceMove:              number;
  volumeDuringLargeMoves:      number;
  postTradePriceDrift:         number;
  volatilityAfterVolumeSpikes: number;
  flags:                       string[];
}

export interface DecisionScorecard {
  yield:       number;
  il:          number;
  liquidity:   number;
  volatility:  number;
  tokenRisk:   number;
  gas:         number;
  correlation: number;
  regime:      number;
  composite:   number;
  weightSet:   "risk-off" | "neutral" | "risk-on";
  allocationPct: number;
  labels: {
    yield:       string;
    il:          string;
    liquidity:   string;
    volatility:  string;
    tokenRisk:   string;
    gas:         string;
    correlation: string;
    regime:      string;
  };
}

export interface PortfolioAllocation {
  rank:             number;
  poolId:           string;
  pair:             string;
  chainName:        string;
  feeTierLabel:     string;
  effectiveNetAPY:  number;
  scorecard:        DecisionScorecard;
  allocationPct:    number;
  allocationUsd:    number;
  marginalReturn:   number;
  marginalRisk:     number;
  marginalSharpe:   number;
  /** Pearson rho of this pool's APY series with selected pools. NaN = heuristic used. */
  correlationWithPortfolio: number;
  reasoning:        string;
}

export interface OptimizationResult {
  allocations:     PortfolioAllocation[];
  portfolioReturn: number;
  portfolioRisk:   number;
  portfolioSharpe: number;
  cashReservedPct: number;
}

export interface StressScenario {
  id:              string;
  name:            string;
  description:     string;
  netReturn30dPct: number;
  effAPYUnder:     number;
  breachesRange:   boolean;
  timeInRange:     number;
  feeReturn30dPct: number;
  ilLoss30dPct:    number;
}

export interface StressTestResult {
  baseline30dPct:          number;
  worstCase:               StressScenario;
  expectedShortfall30dPct: number;
  downsideScore:           number;
  scenarios:               StressScenario[];
}

export type EnrichmentStage =
  | "enrichRAR"
  | "capitalEfficiency"
  | "adverseSelection"
  | "stressTest"
  | "scorecard"
  | "tokenRisk"
  | "stablecoinRisk";

export interface EnrichmentError {
  stage:     EnrichmentStage;
  message:   string;
  timestamp: number;
}

export interface RankedOpportunity {
  rank:          number;
  chainId:       number;
  chainName:     string;
  network:       "mainnet" | "testnet";
  poolId:        string;
  pair:          string;
  feeTier:       number;
  feeTierLabel:  string;
  liveAPY:       number;
  referenceAPY:  number;
  displayAPY:    number;
  apySource:     "live" | "reference";
  risk:          "low" | "medium" | "high" | "extreme";
  tvlUsd:        number;
  volume24hUsd:  number;
  token0Price:   number;
  token1Price:   number;
  rar24h:        number;
  rar7d:         number;
  vol24h:        number;
  vol7d:         number;
  rarQuality:           "excellent" | "good" | "fair" | "poor" | "n/a";
  token0PriceChange24h: number;
  token0PriceChange7d:  number;
  token1PriceChange24h: number;
  token1PriceChange7d:  number;
  pairPriceChange24h:   number;
  pairPriceChange7d:    number;
  expectedIL:           number;
  netAPY:               number;
  liquidityQuality:     number;
  medianAPY7d:          number;
  apyPersistence:       number;
  tokenRisk:            PoolRiskResult | null;
  stablecoinRisk:       StablecoinRiskResult | null;
  timeInRangePct:       number;
  feeCaptureEfficiency: number;
  capitalUtilization:   number;
  effectiveNetAPY:      number;
  halfRangePct:         number;
  adverseSelection:     AdverseSelectionResult | null;
  stressTest:           StressTestResult | null;
  scorecard:            DecisionScorecard | null;
  hookFlags:            string[];
  hasCustomHooks:       boolean;
  enrichmentDegraded:   boolean;
  enrichmentErrors:     EnrichmentError[];
  lastUpdated:          number;
}
