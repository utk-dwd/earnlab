import { ethers } from "ethers";
import { AgentMemoryState } from "../types";
import { ZeroGStorage } from "../integrations/zeroG/ZeroGStorage";
import { INFTManager } from "../integrations/zeroG/INFTManager";
import { MetadataManager, AgentMetadataPayload } from "../integrations/zeroG/MetadataManager";

export class AgentMemory {
  private state: AgentMemoryState;
  private storage: ZeroGStorage;
  private inftManager?: INFTManager;
  private metadataManager: MetadataManager;

  constructor(agentId: number, storage: ZeroGStorage, inftManager?: INFTManager) {
    this.storage = storage;
    this.inftManager = inftManager;
    this.metadataManager = new MetadataManager(storage);
    this.state = {
      agentId,
      lastExecution: 0,
      totalExecutions: 0,
      cumulativePnl: 0,
      strategyHistory: [],
    };
  }

  /** Load state from 0G Storage URI (stored in iNFT metadata) */
  async load(encryptedURI: string, ownerAddress: string): Promise<void> {
    try {
      const raw = await this.storage.retrieve(encryptedURI);
      this.state = JSON.parse(Buffer.from(raw, "base64").toString("utf-8"));
      console.log(`[AgentMemory] Loaded state for agent ${this.state.agentId}`);
    } catch (e) {
      console.warn(`[AgentMemory] Could not load state from ${encryptedURI}, using fresh state`);
    }
  }

  /**
   * Persist state — stores on 0G Storage AND updates the on-chain iNFT metadata.
   * This makes the agent's "brain" fully on-chain and verifiable.
   */
  async persist(inftTokenId: number, ownerAddress: string): Promise<string> {
    // 1. Build ERC-7857 payload
    const payload: AgentMetadataPayload = {
      agentId:         this.state.agentId,
      strategyType:    this.state.strategyHistory[0]?.strategy ?? "yield_farming",
      riskProfile:     "moderate",
      executionHistory: this.state.strategyHistory.slice(-20), // last 20 executions
      config:          {},
      version:         "1.0",
    };

    if (this.inftManager) {
      // Update on-chain iNFT metadata — agent memory is now on the blockchain
      const uri = await this.inftManager.updateAgentMemory(inftTokenId, payload, ownerAddress);
      this.state.storageCid = uri;
      console.log(`[AgentMemory] State persisted to iNFT #${inftTokenId} | URI: ${uri}`);
      return uri;
    } else {
      // Fallback: store raw on 0G without iNFT update
      const data = Buffer.from(JSON.stringify(this.state)).toString("base64");
      const uri = await this.storage.store(data);
      this.state.storageCid = uri;
      return uri;
    }
  }

  update(partial: Partial<AgentMemoryState>): void {
    this.state = { ...this.state, ...partial };
  }

  get(): AgentMemoryState {
    return { ...this.state };
  }
}
