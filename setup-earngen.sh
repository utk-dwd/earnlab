#!/usr/bin/env bash
# Run from: ~/projects/ethGlobalAiAgents/earnGen
set -e
BASE="$(pwd)"
echo "Setting up earnGen AXL multi-agent system at $BASE ..."

# ── Directory structure ────────────────────────────────────────────────────
mkdir -p agents/src/integrations/axl
mkdir -p agents/src/orchestrator
mkdir -p agents/src/tasks
mkdir -p agents/src/types
mkdir -p agents/axl/keys
mkdir -p agents/axl/configs

# ════════════════════════════════════════════════════════════════════════════
# AXL NODE CONFIGS
# 3 nodes on same machine — different api_port and tcp_port
# Orchestrator peers with both agents; agents peer back to orchestrator
# ════════════════════════════════════════════════════════════════════════════

cat > agents/axl/configs/node-orchestrator.json << 'EOF'
{
  "PrivateKeyPath": "keys/orchestrator.pem",
  "Peers": [],
  "Listen": ["tls://0.0.0.0:7000"],
  "api_port": 9002,
  "tcp_port": 7000
}
EOF

cat > agents/axl/configs/node-agent1.json << 'EOF'
{
  "PrivateKeyPath": "keys/agent1.pem",
  "Peers": ["tls://127.0.0.1:7000"],
  "api_port": 9003,
  "tcp_port": 7001
}
EOF

cat > agents/axl/configs/node-agent2.json << 'EOF'
{
  "PrivateKeyPath": "keys/agent2.pem",
  "Peers": ["tls://127.0.0.1:7000"],
  "api_port": 9004,
  "tcp_port": 7002
}
EOF

# ════════════════════════════════════════════════════════════════════════════
# AXL SETUP SCRIPT — clones repo, builds binary, generates keys
# ════════════════════════════════════════════════════════════════════════════
cat > agents/axl/setup-axl.sh << 'SCRIPT'
#!/usr/bin/env bash
set -e
AXL_DIR="$HOME/axl"
KEYS_DIR="$(dirname "$0")/keys"

echo "==> Checking Go version..."
GO_VER=$(go version 2>/dev/null | grep -oP 'go\K[0-9]+\.[0-9]+' | head -1)
if [[ -z "$GO_VER" ]]; then
  echo "ERROR: Go not found. Install Go 1.25.x from https://go.dev/dl/"
  exit 1
fi
echo "Go $GO_VER found"

echo "==> Cloning AXL..."
if [ ! -d "$AXL_DIR" ]; then
  git clone https://github.com/gensyn-ai/axl.git "$AXL_DIR"
else
  echo "AXL already cloned at $AXL_DIR"
fi

echo "==> Building AXL node binary..."
cd "$AXL_DIR"
GOTOOLCHAIN=go1.25.5 go build -o node ./cmd/node/ 2>/dev/null || \
  go build -o node ./cmd/node/
echo "✓ Built: $AXL_DIR/node"

# Symlink binary to axl dir for convenience
ln -sf "$AXL_DIR/node" "$(dirname "$0")/node" 2>/dev/null || \
  cp "$AXL_DIR/node" "$(dirname "$0")/node"

echo "==> Generating ed25519 keys..."
mkdir -p "$KEYS_DIR"
for AGENT in orchestrator agent1 agent2; do
  KEY_FILE="$KEYS_DIR/$AGENT.pem"
  if [ ! -f "$KEY_FILE" ]; then
    # Try openssl (Linux) then brew openssl (macOS)
    openssl genpkey -algorithm ed25519 -out "$KEY_FILE" 2>/dev/null || \
    /usr/local/opt/openssl/bin/openssl genpkey -algorithm ed25519 -out "$KEY_FILE" || \
    /opt/homebrew/opt/openssl/bin/openssl genpkey -algorithm ed25519 -out "$KEY_FILE"
    echo "✓ Key: $KEY_FILE"
  else
    echo "  Key exists: $KEY_FILE"
  fi
done

echo ""
echo "✓ AXL setup complete!"
echo "  Run: bash agents/axl/start-all.sh"
SCRIPT
chmod +x agents/axl/setup-axl.sh

# ════════════════════════════════════════════════════════════════════════════
# START-ALL SCRIPT — starts 3 AXL nodes and captures their public keys
# ════════════════════════════════════════════════════════════════════════════
cat > agents/axl/start-all.sh << 'SCRIPT'
#!/usr/bin/env bash
set -e
AXL="$(dirname "$0")/node"
CONFIGS="$(dirname "$0")/configs"
LOGS="$(dirname "$0")/logs"
mkdir -p "$LOGS"

if [ ! -f "$AXL" ]; then
  echo "ERROR: AXL binary not found. Run setup-axl.sh first."
  exit 1
fi

echo "==> Starting 3 AXL nodes..."

# Kill any existing nodes
lsof -ti :9002 | xargs kill -9 2>/dev/null || true
lsof -ti :9003 | xargs kill -9 2>/dev/null || true
lsof -ti :9004 | xargs kill -9 2>/dev/null || true
lsof -ti :7000 | xargs kill -9 2>/dev/null || true
lsof -ti :7001 | xargs kill -9 2>/dev/null || true
lsof -ti :7002 | xargs kill -9 2>/dev/null || true

# Start nodes (config paths must be relative to cwd)
cd "$(dirname "$0")"

"$AXL" -config configs/node-orchestrator.json > logs/orchestrator.log 2>&1 &
echo "  ✓ Orchestrator node (port 9002, tcp 7000) PID=$!"

sleep 1  # let orchestrator start before agents peer to it

"$AXL" -config configs/node-agent1.json > logs/agent1.log 2>&1 &
echo "  ✓ Agent1 node      (port 9003, tcp 7001) PID=$!"

"$AXL" -config configs/node-agent2.json > logs/agent2.log 2>&1 &
echo "  ✓ Agent2 node      (port 9004, tcp 7002) PID=$!"

sleep 2  # wait for nodes to connect and get public keys

echo ""
echo "==> Fetching public keys..."
ORCH_KEY=$(curl -s http://127.0.0.1:9002/topology | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('self',{}).get('public_key',''))" 2>/dev/null || echo "pending")
A1_KEY=$(curl -s http://127.0.0.1:9003/topology | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('self',{}).get('public_key',''))" 2>/dev/null || echo "pending")
A2_KEY=$(curl -s http://127.0.0.1:9004/topology | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('self',{}).get('public_key',''))" 2>/dev/null || echo "pending")

echo "  Orchestrator public key: $ORCH_KEY"
echo "  Agent1      public key: $A1_KEY"
echo "  Agent2      public key: $A2_KEY"

# Write keys to a shared file for the TypeScript agents to read
cat > keys/public-keys.json << KEYS
{
  "orchestrator": "$ORCH_KEY",
  "agent1":       "$A1_KEY",
  "agent2":       "$A2_KEY"
}
KEYS
echo ""
echo "✓ Public keys saved to keys/public-keys.json"
echo "  Nodes running. Logs: agents/axl/logs/"
SCRIPT
chmod +x agents/axl/start-all.sh

# ════════════════════════════════════════════════════════════════════════════
# STOP SCRIPT
# ════════════════════════════════════════════════════════════════════════════
cat > agents/axl/stop-all.sh << 'SCRIPT'
#!/usr/bin/env bash
for PORT in 9002 9003 9004 7000 7001 7002; do
  lsof -ti :$PORT | xargs kill -9 2>/dev/null || true
done
echo "✓ All AXL nodes stopped"
SCRIPT
chmod +x agents/axl/stop-all.sh

# ════════════════════════════════════════════════════════════════════════════
# agents/src/integrations/axl/AXLClient.ts
# HTTP wrapper for the AXL node API
# ════════════════════════════════════════════════════════════════════════════
cat > agents/src/integrations/axl/AXLClient.ts << 'EOF'
import axios, { AxiosInstance } from "axios";

export interface AXLMessage {
  from:    string;   // sender public key
  body:    string;   // raw message body (JSON string)
  timestamp?: number;
}

export interface AXLTopology {
  self: {
    public_key: string;
    address:    string;   // IPv6 on the Yggdrasil mesh
  };
  peers: Array<{
    public_key: string;
    address:    string;
  }>;
}

/**
 * AXLClient — thin HTTP wrapper around the local AXL node API.
 * Each agent runs its own AXL node on a different port.
 *
 * API endpoints (per AXL docs):
 *   POST /send         — send a message to a peer
 *   GET  /receive      — poll for the next queued message
 *   GET  /topology     — get this node's public key and peer list
 */
export class AXLClient {
  private http: AxiosInstance;
  public readonly port: number;
  public publicKey: string = "";

  constructor(port: number = 9002) {
    this.port = port;
    this.http = axios.create({
      baseURL: `http://127.0.0.1:${port}`,
      timeout: 10_000,
    });
  }

  /** Fetch and cache this node's public key */
  async init(): Promise<string> {
    const topo = await this.topology();
    this.publicKey = topo.self.public_key;
    return this.publicKey;
  }

  /** Send a message to a peer by their public key */
  async send(toPublicKey: string, body: object): Promise<void> {
    await this.http.post("/send", {
      to:   toPublicKey,
      body: JSON.stringify(body),
    });
  }

  /**
   * Poll for one message from the queue.
   * Returns null if the queue is empty.
   */
  async receive(): Promise<AXLMessage | null> {
    try {
      const resp = await this.http.get("/receive");
      if (!resp.data || !resp.data.body) return null;
      return resp.data as AXLMessage;
    } catch (err: any) {
      if (err.response?.status === 204 || err.response?.status === 404) return null;
      throw err;
    }
  }

  /**
   * Poll continuously, calling handler for each message.
   * @param handler   async function receiving the parsed message body
   * @param intervalMs  polling interval in ms (default 500)
   */
  startPolling(
    handler: (msg: AXLMessage, body: any) => Promise<void>,
    intervalMs = 500
  ): NodeJS.Timer {
    return setInterval(async () => {
      try {
        const msg = await this.receive();
        if (!msg) return;
        let body: any;
        try { body = JSON.parse(msg.body); } catch { body = msg.body; }
        await handler(msg, body);
      } catch (err) {
        console.error(`[AXL:${this.port}] Poll error:`, err);
      }
    }, intervalMs);
  }

  /** Get topology — includes own public key and connected peers */
  async topology(): Promise<AXLTopology> {
    const resp = await this.http.get("/topology");
    return resp.data;
  }

  /** Wait until the node is reachable (retry loop) */
  async waitForNode(retries = 20, delayMs = 500): Promise<void> {
    for (let i = 0; i < retries; i++) {
      try {
        await this.topology();
        return;
      } catch {
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
    throw new Error(`AXL node on port ${this.port} did not start in time`);
  }
}
EOF

# ════════════════════════════════════════════════════════════════════════════
# agents/src/types/messages.ts
# All AXL message types between orchestrator and task agents
# ════════════════════════════════════════════════════════════════════════════
cat > agents/src/types/messages.ts << 'EOF'
import { YieldOpportunity, RiskProfile } from "./index";

export type MessageType =
  | "SCAN_REQUEST"
  | "SCAN_RESULT"
  | "EXECUTE_COMMAND"
  | "EXECUTE_RESULT"
  | "HEARTBEAT"
  | "AGENT_READY";

export interface BaseMessage {
  type:      MessageType;
  taskId:    string;
  timestamp: number;
  fromAgent: string;   // "orchestrator" | "agent1" | "agent2"
}

// ── Orchestrator → Task Agents ────────────────────────────────────────────

/** Orchestrator asks a task agent to scan for yield opportunities */
export interface ScanRequest extends BaseMessage {
  type:        "SCAN_REQUEST";
  riskProfile: RiskProfile;
  protocols:   string[];         // e.g. ["uniswap-v3", "aave"]
  minTvlUsd:   number;
  maxResults:  number;
}

/** Orchestrator tells a task agent to execute a rebalance */
export interface ExecuteCommand extends BaseMessage {
  type:        "EXECUTE_COMMAND";
  opportunity: YieldOpportunity;
  slippageBps: number;
}

// ── Task Agents → Orchestrator ────────────────────────────────────────────

/** Task agent returns discovered yield opportunities */
export interface ScanResult extends BaseMessage {
  type:          "SCAN_RESULT";
  opportunities: YieldOpportunity[];
  protocol:      string;
  scanDurationMs: number;
}

/** Task agent confirms execution */
export interface ExecuteResult extends BaseMessage {
  type:    "EXECUTE_RESULT";
  txHash?: string;
  success: boolean;
  error?:  string;
}

// ── Lifecycle ─────────────────────────────────────────────────────────────

export interface Heartbeat extends BaseMessage {
  type:   "HEARTBEAT";
  status: "alive" | "busy" | "error";
}

export interface AgentReady extends BaseMessage {
  type:      "AGENT_READY";
  agentId:   string;
  publicKey: string;
  protocols: string[];
}

export type AXLPayload =
  | ScanRequest
  | ScanResult
  | ExecuteCommand
  | ExecuteResult
  | Heartbeat
  | AgentReady;
EOF

# ════════════════════════════════════════════════════════════════════════════
# agents/src/orchestrator/OrchestratorAgent.ts
# ════════════════════════════════════════════════════════════════════════════
cat > agents/src/orchestrator/OrchestratorAgent.ts << 'EOF'
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
EOF

# ════════════════════════════════════════════════════════════════════════════
# agents/src/tasks/YieldScannerAgent.ts  — base class for task agents
# ════════════════════════════════════════════════════════════════════════════
cat > agents/src/tasks/YieldScannerAgent.ts << 'EOF'
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
EOF

# ════════════════════════════════════════════════════════════════════════════
# agents/src/tasks/UniswapScannerAgent.ts — Task Agent 1
# Scans Uniswap V3 for top yield pools
# ════════════════════════════════════════════════════════════════════════════
cat > agents/src/tasks/UniswapScannerAgent.ts << 'EOF'
import { YieldScannerAgent } from "./YieldScannerAgent";
import { UniswapClient }     from "../integrations/uniswap/UniswapClient";
import { YieldOpportunity, RiskProfile } from "../types";

const RISK_TVL: Record<string, number> = {
  conservative: 10_000_000,
  moderate:     1_000_000,
  aggressive:   100_000,
};

export class UniswapScannerAgent extends YieldScannerAgent {
  private uniswap: UniswapClient;

  constructor(orchestratorPublicKey: string) {
    super("agent1-uniswap", 9003, ["uniswap-v3"], orchestratorPublicKey);
    this.uniswap = new UniswapClient();
  }

  async scan(riskProfile: string, minTvlUsd: number, maxResults: number): Promise<YieldOpportunity[]> {
    const minTvl = BigInt(RISK_TVL[riskProfile] ?? minTvlUsd);
    const pools  = await this.uniswap.getTopPools(100);
    return pools
      .filter(p => p.tvl >= minTvl)
      .sort((a, b) => b.apy - a.apy)
      .slice(0, maxResults);
  }
}
EOF

# ════════════════════════════════════════════════════════════════════════════
# agents/src/tasks/StablecoinScannerAgent.ts — Task Agent 2
# Scans stablecoin pairs for low-risk looping opportunities
# ════════════════════════════════════════════════════════════════════════════
cat > agents/src/tasks/StablecoinScannerAgent.ts << 'EOF'
import { YieldScannerAgent } from "./YieldScannerAgent";
import { UniswapClient }     from "../integrations/uniswap/UniswapClient";
import { YieldOpportunity }  from "../types";

const STABLECOINS = new Set(["USDC", "USDT", "DAI", "FRAX", "LUSD", "USDE"]);

export class StablecoinScannerAgent extends YieldScannerAgent {
  private uniswap: UniswapClient;

  constructor(orchestratorPublicKey: string) {
    super("agent2-stablecoin", 9004, ["uniswap-v3-stable", "curve"], orchestratorPublicKey);
    this.uniswap = new UniswapClient();
  }

  async scan(_riskProfile: string, _minTvlUsd: number, maxResults: number): Promise<YieldOpportunity[]> {
    const pools = await this.uniswap.getTopPools(100);
    return pools
      .filter(p => STABLECOINS.has(p.tokenA) && STABLECOINS.has(p.tokenB))
      .sort((a, b) => b.apy - a.apy)
      .slice(0, maxResults);
  }
}
EOF

# ════════════════════════════════════════════════════════════════════════════
# Entry points — one per role
# ════════════════════════════════════════════════════════════════════════════
cat > agents/src/orchestrator/index.ts << 'EOF'
import * as dotenv from "dotenv";
import { OrchestratorAgent } from "./OrchestratorAgent";
dotenv.config({ path: "../../.env" });

new OrchestratorAgent(9002).start().catch(console.error);
EOF

cat > agents/src/tasks/agent1.ts << 'EOF'
import * as dotenv from "dotenv";
import * as fs from "fs";
import { UniswapScannerAgent } from "./UniswapScannerAgent";
dotenv.config({ path: "../../.env" });

// Read orchestrator public key from keys file (written by start-all.sh)
const keys = JSON.parse(fs.readFileSync("../axl/keys/public-keys.json", "utf-8"));
new UniswapScannerAgent(keys.orchestrator).start().catch(console.error);
EOF

cat > agents/src/tasks/agent2.ts << 'EOF'
import * as dotenv from "dotenv";
import * as fs from "fs";
import { StablecoinScannerAgent } from "./StablecoinScannerAgent";
dotenv.config({ path: "../../.env" });

const keys = JSON.parse(fs.readFileSync("../axl/keys/public-keys.json", "utf-8"));
new StablecoinScannerAgent(keys.orchestrator).start().catch(console.error);
EOF

# ════════════════════════════════════════════════════════════════════════════
# Update package.json with new scripts and uuid dependency
# ════════════════════════════════════════════════════════════════════════════
cat > agents/package.json << 'EOF'
{
  "name": "@earngen/agents",
  "version": "0.1.0",
  "scripts": {
    "orchestrator": "ts-node src/orchestrator/index.ts",
    "agent1":       "ts-node src/tasks/agent1.ts",
    "agent2":       "ts-node src/tasks/agent2.ts",
    "build":        "tsc"
  },
  "dependencies": {
    "ethers":            "^6.11.0",
    "axios":             "^1.6.0",
    "dotenv":            "^16.4.0",
    "uuid":              "^9.0.0",
    "@uniswap/v3-sdk":   "^3.13.0",
    "@uniswap/sdk-core": "^5.3.0"
  },
  "devDependencies": {
    "typescript":    "^5.4.0",
    "ts-node":       "^10.9.0",
    "@types/node":   "^20.0.0",
    "@types/uuid":   "^9.0.0"
  }
}
EOF

cd agents && npm install --silent 2>/dev/null || true

echo ""
echo "✓ earnGen AXL multi-agent setup complete!"
echo ""
echo "Architecture:"
echo "  Orchestrator (port 9002)"
echo "    ├── agent1-uniswap    (port 9003) — scans Uniswap V3 all pairs"
echo "    └── agent2-stablecoin (port 9004) — scans stable-only pairs"
echo ""
echo "Next steps:"
echo ""
echo "  1. Install Go 1.25.x and build AXL:"
echo "     bash agents/axl/setup-axl.sh"
echo ""
echo "  2. Start all 3 AXL nodes:"
echo "     bash agents/axl/start-all.sh"
echo ""
echo "  3. In 3 separate terminals:"
echo "     cd agents && npm run orchestrator"
echo "     cd agents && npm run agent1"
echo "     cd agents && npm run agent2"
