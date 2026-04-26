import { createHash } from "crypto";

/**
 * KeeperHubClient — mock strategy marketplace registration.
 *
 * In production:
 *   - Executor registers strategy on KeeperHub contract
 *   - Strategy logic stays private (encrypted on 0G Storage)
 *   - Seekers subscribe via on-chain tx
 *   - KeeperHub triggers execution on schedule
 *
 * Here: generate job IDs, log registrations.
 */
export class KeeperHubClient {
  private jobs = new Map<string, { strategyId: string; subscriberKey: string; created: number }>();

  /** Executor calls this to register a strategy and add a subscriber */
  async registerSubscriber(strategyId: string, subscriberKey: string): Promise<string> {
    const jobId =
      "khub:" +
      createHash("sha256")
        .update(`${strategyId}:${subscriberKey}:${Date.now()}`)
        .digest("hex")
        .slice(0, 12);

    this.jobs.set(jobId, { strategyId, subscriberKey, created: Date.now() });
    console.log(`[KeeperHub] Job registered: ${jobId} (strategy: ${strategyId})`);
    return jobId;
  }

  /** Returns active job count */
  activeJobs(): number {
    return this.jobs.size;
  }
}
