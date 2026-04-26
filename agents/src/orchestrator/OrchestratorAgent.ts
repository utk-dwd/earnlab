import { v4 as uuidv4 } from "uuid";
import { AXLClient, AXLMessage } from "../integrations/axl/AXLClient";
import {
  ScanRequest, ScanResult, ExecuteCommand,
  ExecuteResult, AgentReady, AXLPayload,
} from "../types/messages";
import { YieldOpportunity, RiskProfile } from "../types";

interface TaskAgentInfo {
  publicKey: string;
  agentId:   string;
  protocols: string[];
  status:    "idle" | "scanning" | "executing";
}

export class OrchestratorAgent {
  private axl: AXLClient;
  private taskAgents: Map<string, TaskAgentInfo> = new Map(); // agentId → info
  private pendingScans: Map<string, ScanResult[]> = new Map(); // taskId → results

  constructor(axlPort = 9002) {
    this.axl = new AXLClient(axlPort);
  }

  async start(): Promise<void> {
    console.log("[Orchestrator] Starting...");
    await this.axl.waitForNode();
    await this.axl.init();
    console.log(`[Orchestrator] AXL public key: ${this.axl.publicKey}`);

    // Start listening for messages from task agents
    this.axl.startPolling(this.handleMessage.bind(this), 300);
    console.log("[Orchestrator] Listening for task agents...");

    // Main orchestration loop
    await this.orchestrationLoop();
  }

  private async handleMessage(raw: AXLMessage, body: AXLPayload): Promise<void> {
    console.log(`[Orchestrator] ← ${body.type} from ${body.fromAgent}`);

    switch (body.type) {
      case "AGENT_READY":
        this.onAgentReady(body);
        break;
      case "SCAN_RESULT":
        this.onScanResult(body);
        break;
      case "EXECUTE_RESULT":
        this.onExecuteResult(body);
        break;
      case "HEARTBEAT":
        console.log(`[Orchestrator]   ${body.fromAgent} status: ${body.status}`);
        break;
    }
  }

  private onAgentReady(msg: AgentReady): void {
    this.taskAgents.set(msg.agentId, {
      publicKey: msg.publicKey,
      agentId:   msg.agentId,
      protocols: msg.protocols,
      status:    "idle",
    });
    console.log(`[Orchestrator] ✓ Task agent registered: ${msg.agentId} (${msg.protocols.join(", ")})`);
  }

  private onScanResult(msg: ScanResult): void {
    const existing = this.pendingScans.get(msg.taskId) ?? [];
    existing.push(msg);
    this.pendingScans.set(msg.taskId, existing);

    const agent = [...this.taskAgents.values()].find(a => a.agentId === msg.fromAgent);
    if (agent) agent.status = "idle";

    console.log(`[Orchestrator]   taskId=${msg.taskId}: ${msg.opportunities.length} opportunities from ${msg.fromAgent}`);
    this.tryRankAndExecute(msg.taskId);
  }

  private onExecuteResult(msg: ExecuteResult): void {
    if (msg.success) {
      console.log(`[Orchestrator] ✓ Execution confirmed. txHash=${msg.txHash}`);
    } else {
      console.error(`[Orchestrator] ✗ Execution failed: ${msg.error}`);
    }
  }

  /** When all agents have responded for a taskId, rank and execute best opportunity */
  private async tryRankAndExecute(taskId: string): Promise<void> {
    const results = this.pendingScans.get(taskId) ?? [];
    const allAgents = [...this.taskAgents.values()];

    // Wait for all task agents to respond (or timeout)
    if (results.length < allAgents.length) return;

    console.log(`[Orchestrator] All ${results.length} agents responded. Ranking...`);

    // Merge and rank by APY
    const allOpportunities: YieldOpportunity[] = results
      .flatMap(r => r.opportunities)
      .sort((a, b) => b.apy - a.apy);

    if (allOpportunities.length === 0) {
      console.log("[Orchestrator] No opportunities found.");
      this.pendingScans.delete(taskId);
      return;
    }

    const best = allOpportunities[0];
    console.log(`[Orchestrator] Best opportunity: ${best.tokenA}/${best.tokenB} APY=${(best.apy * 100).toFixed(2)}% on ${best.protocol}`);

    // Assign execution to the agent that found this opportunity
    const execAgent = allAgents.find(a => a.status === "idle");
    if (!execAgent) {
      console.log("[Orchestrator] No idle agents for execution, deferring.");
      return;
    }

    execAgent.status = "executing";
    const execCmd: ExecuteCommand = {
      type:        "EXECUTE_COMMAND",
      taskId,
      timestamp:   Date.now(),
      fromAgent:   "orchestrator",
      opportunity: best,
      slippageBps: 50,
    };
    await this.axl.send(execAgent.publicKey, execCmd);
    console.log(`[Orchestrator] → EXECUTE_COMMAND sent to ${execAgent.agentId}`);
    this.pendingScans.delete(taskId);
  }

  /** Dispatch scan requests to all registered task agents */
  private async dispatchScan(riskProfile: RiskProfile): Promise<string> {
    const taskId = uuidv4();
    const agents = [...this.taskAgents.values()].filter(a => a.status === "idle");

    if (agents.length === 0) {
      console.log("[Orchestrator] No idle task agents available.");
      return taskId;
    }

    this.pendingScans.set(taskId, []);
    console.log(`[Orchestrator] Dispatching SCAN_REQUEST (taskId=${taskId.slice(0,8)}...) to ${agents.length} agents`);

    for (const agent of agents) {
      agent.status = "scanning";
      const req: ScanRequest = {
        type:        "SCAN_REQUEST",
        taskId,
        timestamp:   Date.now(),
        fromAgent:   "orchestrator",
        riskProfile,
        protocols:   agent.protocols,
        minTvlUsd:   1_000_000,
        maxResults:  10,
      };
      await this.axl.send(agent.publicKey, req);
      console.log(`[Orchestrator] → SCAN_REQUEST sent to ${agent.agentId}`);
    }

    return taskId;
  }

  /** Main loop: every 60s, dispatch a scan to all task agents */
  private async orchestrationLoop(): Promise<void> {
    // Wait for at least 1 task agent
    console.log("[Orchestrator] Waiting for task agents to connect...");
    while (this.taskAgents.size === 0) {
      await new Promise(r => setTimeout(r, 1000));
    }

    console.log("[Orchestrator] Starting orchestration loop (60s interval)");
    while (true) {
      await this.dispatchScan(RiskProfile.Moderate);
      await new Promise(r => setTimeout(r, 60_000));
    }
  }
}
