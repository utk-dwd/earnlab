import { AXLClient, AXLMessage } from "../integrations/axl/AXLClient";
import {
  ScanRequest, ScanResult, ExecuteCommand,
  AgentReady, Heartbeat, AXLPayload,
} from "../types/messages";
import { YieldOpportunity } from "../types";
import { KeeperHubClient } from "../integrations/keeperHub/KeeperHubClient";

export abstract class YieldScannerAgent {
  protected axl:     AXLClient;
  protected keeper:  KeeperHubClient;
  readonly agentId:  string;
  readonly protocols: string[];

  private orchestratorPublicKey: string;

  constructor(
    agentId:             string,
    axlPort:             number,
    protocols:           string[],
    orchestratorPublicKey: string
  ) {
    this.agentId              = agentId;
    this.protocols            = protocols;
    this.orchestratorPublicKey = orchestratorPublicKey;
    this.axl                  = new AXLClient(axlPort);
    this.keeper               = new KeeperHubClient();
  }

  async start(): Promise<void> {
    console.log(`[${this.agentId}] Starting...`);
    await this.axl.waitForNode();
    await this.axl.init();
    console.log(`[${this.agentId}] AXL public key: ${this.axl.publicKey}`);

    // Announce to orchestrator
    await this.announceReady();

    // Start heartbeat
    this.startHeartbeat();

    // Start polling for messages from orchestrator
    this.axl.startPolling(this.handleMessage.bind(this), 300);
    console.log(`[${this.agentId}] Ready, waiting for scan requests...`);

    // Keep process alive
    await new Promise(() => {});
  }

  private async announceReady(): Promise<void> {
    const msg: AgentReady = {
      type:      "AGENT_READY",
      taskId:    "init",
      timestamp: Date.now(),
      fromAgent: this.agentId,
      agentId:   this.agentId,
      publicKey: this.axl.publicKey,
      protocols: this.protocols,
    };
    // Retry until orchestrator is reachable
    for (let i = 0; i < 10; i++) {
      try {
        await this.axl.send(this.orchestratorPublicKey, msg);
        console.log(`[${this.agentId}] ✓ Announced to orchestrator`);
        return;
      } catch {
        await new Promise(r => setTimeout(r, 1000));
      }
    }
    console.warn(`[${this.agentId}] Could not reach orchestrator — will retry on next heartbeat`);
  }

  private startHeartbeat(): void {
    setInterval(async () => {
      const hb: Heartbeat = {
        type:      "HEARTBEAT",
        taskId:    "hb",
        timestamp: Date.now(),
        fromAgent: this.agentId,
        status:    "alive",
      };
      try {
        await this.axl.send(this.orchestratorPublicKey, hb);
      } catch {}
    }, 30_000);
  }

  private async handleMessage(raw: AXLMessage, body: AXLPayload): Promise<void> {
    console.log(`[${this.agentId}] ← ${body.type}`);

    switch (body.type) {
      case "SCAN_REQUEST":
        await this.handleScanRequest(body);
        break;
      case "EXECUTE_COMMAND":
        await this.handleExecuteCommand(body);
        break;
    }
  }

  private async handleScanRequest(req: ScanRequest): Promise<void> {
    const start = Date.now();
    console.log(`[${this.agentId}] Scanning ${this.protocols.join(", ")} (risk: ${req.riskProfile})...`);

    const opportunities = await this.scan(req.riskProfile, req.minTvlUsd, req.maxResults);

    const result: ScanResult = {
      type:           "SCAN_RESULT",
      taskId:         req.taskId,
      timestamp:      Date.now(),
      fromAgent:      this.agentId,
      opportunities,
      protocol:       this.protocols[0],
      scanDurationMs: Date.now() - start,
    };

    await this.axl.send(this.orchestratorPublicKey, result);
    console.log(`[${this.agentId}] → SCAN_RESULT: ${opportunities.length} opportunities (${result.scanDurationMs}ms)`);
  }

  private async handleExecuteCommand(cmd: ExecuteCommand): Promise<void> {
    console.log(`[${this.agentId}] Executing: ${cmd.opportunity.tokenA}/${cmd.opportunity.tokenB}`);
    try {
      const txHash = await this.keeper.triggerRebalance({
        agentId:    0,
        targetPool: cmd.opportunity.poolAddress,
        tokenA:     cmd.opportunity.tokenA,
        tokenB:     cmd.opportunity.tokenB,
        slippageBps: cmd.slippageBps,
      });
      await this.axl.send(this.orchestratorPublicKey, {
        type:      "EXECUTE_RESULT",
        taskId:    cmd.taskId,
        timestamp: Date.now(),
        fromAgent: this.agentId,
        txHash,
        success:   true,
      });
    } catch (err: any) {
      await this.axl.send(this.orchestratorPublicKey, {
        type:      "EXECUTE_RESULT",
        taskId:    cmd.taskId,
        timestamp: Date.now(),
        fromAgent: this.agentId,
        success:   false,
        error:     err.message,
      });
    }
  }

  /** Subclasses implement protocol-specific scanning */
  abstract scan(
    riskProfile: string,
    minTvlUsd:   number,
    maxResults:  number
  ): Promise<YieldOpportunity[]>;
}
