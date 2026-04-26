import { createHash } from "crypto";

export interface TEEResult {
  action: "INCREASE_ETH" | "INCREASE_STABLE" | "HOLD";
  allocation: Record<string, number>;
  expectedReturn: number;
  attestation: string; // deterministic proof of computation
}

/**
 * ZeroGCompute — mock TEE inference client.
 * In production: submit job to 0G Compute network, receive signed attestation.
 * In demo: deterministic inference with sha256-based attestation.
 */
export class ZeroGCompute {
  private nonce = 0;

  async runInference(
    portfolio: Record<string, number>,
    prices: Record<string, number>
  ): Promise<TEEResult> {
    const ethPrice = prices.ETH ?? 2000;
    const ethDeviation = (ethPrice - 2000) / 2000; // % from baseline
    const currentEth = portfolio.ETH ?? 0.5;
    const currentStable = (portfolio.USDC ?? 0) + (portfolio.DAI ?? 0);

    let action: TEEResult["action"];
    let allocation: Record<string, number>;
    let expectedReturn: number;

    if (ethDeviation > 0.04 && currentEth < 0.65) {
      action = "INCREASE_ETH";
      allocation = { ETH: Math.min(0.65, currentEth + 0.1), USDC: 0.2, DAI: 0.15 };
      expectedReturn = 0.12 + ethDeviation * 0.5;
    } else if (ethDeviation < -0.04 && currentStable < 0.65) {
      action = "INCREASE_STABLE";
      allocation = { ETH: Math.max(0.35, currentEth - 0.1), USDC: 0.35, DAI: 0.3 };
      expectedReturn = 0.06;
    } else {
      action = "HOLD";
      allocation = { ...portfolio };
      expectedReturn = 0.09;
    }

    // Normalize allocation to sum to 1
    const total = Object.values(allocation).reduce((s, v) => s + v, 0);
    Object.keys(allocation).forEach(k => { allocation[k] = allocation[k] / total; });

    // TEE attestation: sha256(inputs + nonce) — in production: 0G Compute signed proof
    const nonce = ++this.nonce;
    const attInput = JSON.stringify({ portfolio, prices, action, allocation, nonce });
    const attestation = "tee:" + createHash("sha256").update(attInput).digest("hex");

    // Simulate ~200ms compute latency
    await new Promise(r => setTimeout(r, 200));

    return { action, allocation, expectedReturn, attestation };
  }
}
