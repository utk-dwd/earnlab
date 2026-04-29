export type EarnlabNetwork = "mainnet" | "testnet" | "all";

export interface EarnlabYieldsQuery {
  chainId?: number;
  network?: EarnlabNetwork;
  minAPY?: number;
  limit?: number;
}

export interface EarnlabYield {
  poolId: string;
  chainId: number;
  network: EarnlabNetwork;
  pair: string;
  displayAPY: number;
  riskScore?: number;
}

export interface EarnlabYieldsResponse {
  count: number;
  data: EarnlabYield[];
}

export interface EarnlabPortfolioSummary {
  cash: number;
  invested: number;
  positions: number;
  unrealizedPnL?: number;
  fees?: number;
  regime?: string;
}

export interface EarnlabPortfolioResponse extends EarnlabPortfolioSummary {}

export interface TemplateInputs {
  earnlabBaseUrl: string;
  chainId?: number;
  network?: EarnlabNetwork;
  minAPY: number;
  maxRiskScore?: number;
  limit?: number;
  notifyProvider: "discord" | "telegram" | "webhook";
  notifyTarget: string;
}

export interface KeeperhubTemplate {
  name: string;
  description: string;
  nodes: Array<Record<string, unknown>>;
  edges: Array<Record<string, unknown>>;
}

export class KeeperhubError extends Error {
  public status: number;
  public details?: string;

  constructor(message: string, status = 500, details?: string) {
    super(message);
    this.status = status;
    this.details = details;
  }
}
