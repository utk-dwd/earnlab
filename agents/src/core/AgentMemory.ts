import { AgentMemoryState } from "../types";
import { ZeroGStorage } from "../integrations/zeroG/ZeroGStorage";
export class AgentMemory {
  private state: AgentMemoryState;
  private storage: ZeroGStorage;
  constructor(agentId: number, storage: ZeroGStorage) {
    this.storage = storage;
    this.state = { agentId, lastExecution: 0, totalExecutions: 0, cumulativePnl: 0, strategyHistory: [] };
  }
  async load(storageCid: string): Promise<void> { this.state = JSON.parse(await this.storage.retrieve(storageCid)); }
  async persist(): Promise<string> { const cid = await this.storage.store(JSON.stringify(this.state)); this.state.storageCid = cid; return cid; }
  update(partial: Partial<AgentMemoryState>): void { this.state = { ...this.state, ...partial }; }
  get(): AgentMemoryState { return { ...this.state }; }
}
