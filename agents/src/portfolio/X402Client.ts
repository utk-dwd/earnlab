import { createHash, randomBytes } from "crypto";

export interface PaymentProof {
  proof: string;
  amount: string;
  recipient: string;
  nonce: string;
  timestamp: number;
}

/**
 * X402Client — mock x402 payment protocol.
 *
 * Real x402 flow:
 *   1. Requester receives HTTP 402 with payment details
 *   2. Requester signs a payment tx and submits on-chain
 *   3. Requester retries with payment receipt in header/body
 *   4. Server verifies tx inclusion and serves content
 *
 * Here we generate a deterministic mock proof (sha256 of amount+recipient+nonce).
 * The executor verifies by checking proof format — upgrade to real chain tx later.
 */
export class X402Client {
  async pay(amount: string, recipient: string): Promise<string> {
    const nonce = randomBytes(8).toString("hex");
    const timestamp = Date.now();
    const proof = createHash("sha256")
      .update(`x402:${amount}:${recipient}:${nonce}:${timestamp}`)
      .digest("hex");

    console.log(`[x402] Generating payment proof: ${amount} ETH → ${recipient.slice(0, 12)}...`);
    // In production: sign + submit on-chain, return tx hash
    await new Promise(r => setTimeout(r, 100)); // simulate tx latency

    return `x402:${proof}:${nonce}:${timestamp}`;
  }

  /** Executor calls this to verify a payment proof */
  verify(proof: string, amount: string, recipient: string): boolean {
    // In production: verify tx hash on-chain (Ethereum/Sepolia)
    // Here: just check format
    const valid = proof.startsWith("x402:") && proof.split(":").length === 4;
    console.log(`[x402] Verify proof: ${valid ? "✓" : "✗"}`);
    return valid;
  }
}
