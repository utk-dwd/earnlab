import { ethers } from "ethers";
import { MetadataManager, AgentMetadataPayload } from "./MetadataManager";

const INFT_ABI = [
  "function mintAgent(address to, bytes32 metadataHash, string encryptedURI, address initialExecutor) returns (uint256)",
  "function updateMetadata(uint256 tokenId, bytes32 newHash, string newEncryptedURI)",
  "function secureTransfer(address from, address to, uint256 tokenId, bytes sealedKey, bytes proof)",
  "function clone(address to, uint256 tokenId, bytes sealedKey, bytes proof) returns (uint256)",
  "function authorizeUsage(uint256 tokenId, address executor, bytes permissions)",
  "function revokeUsage(uint256 tokenId, address executor)",
  "function getAgentMetadata(uint256 tokenId) view returns (tuple(bytes32 metadataHash, string encryptedURI, uint256 lastUpdated))",
  "function isAuthorizedExecutor(uint256 tokenId, address executor) view returns (bool)",
  "function ownerOf(uint256 tokenId) view returns (address)",
];

export class INFTManager {
  private contract: ethers.Contract;
  private signer: ethers.Signer;
  private metadataManager: MetadataManager;

  constructor(contractAddress: string, signer: ethers.Signer) {
    this.contract = new ethers.Contract(contractAddress, INFT_ABI, signer);
    this.signer = signer;
    this.metadataManager = new MetadataManager();
  }

  /**
   * Mint a new agent iNFT — encrypts payload, stores on 0G, mints on-chain.
   */
  async mintAgent(
    ownerAddress: string,
    payload: AgentMetadataPayload,
    executorAddress?: string
  ): Promise<{ tokenId: number; uri: string; metadataHash: string }> {
    console.log(`[INFTManager] Storing metadata for agent ${payload.agentId} on 0G...`);
    const stored = await this.metadataManager.store(payload, ownerAddress);

    console.log(`[INFTManager] Minting iNFT on-chain...`);
    const tx = await this.contract.mintAgent(
      ownerAddress,
      stored.metadataHash,
      stored.uri,
      executorAddress ?? ethers.ZeroAddress
    );
    const receipt = await tx.wait();

    // Parse tokenId from Transfer event
    const iface = new ethers.Interface(INFT_ABI);
    let tokenId = 0;
    for (const log of receipt.logs) {
      try {
        const parsed = iface.parseLog(log);
        if (parsed?.name === "Transfer") {
          tokenId = Number(parsed.args.tokenId);
          break;
        }
      } catch {}
    }

    console.log(`[INFTManager] Minted iNFT tokenId=${tokenId} | URI=${stored.uri}`);
    return { tokenId, uri: stored.uri, metadataHash: stored.metadataHash };
  }

  /**
   * Update agent metadata on-chain after a learning cycle.
   */
  async updateAgentMemory(
    tokenId: number,
    payload: AgentMetadataPayload,
    ownerAddress: string
  ): Promise<string> {
    const stored = await this.metadataManager.store(payload, ownerAddress);
    const tx = await this.contract.updateMetadata(
      tokenId,
      stored.metadataHash,
      stored.uri
    );
    await tx.wait();
    console.log(`[INFTManager] Metadata updated for tokenId=${tokenId}`);
    return stored.uri;
  }

  /**
   * Securely transfer an iNFT — generates mock oracle proof for testnet.
   * In production: call the 0G TEE oracle to re-encrypt and get a real proof.
   */
  async secureTransfer(
    tokenId: number,
    fromAddress: string,
    toAddress: string
  ): Promise<void> {
    const meta = await this.contract.getAgentMetadata(tokenId);
    const { newSealedKey } = await this.metadataManager.reencryptForTransfer(
      meta.encryptedURI,
      fromAddress,
      toAddress,
      tokenId
    );
    const proof = await this.metadataManager.generateMockProof(this.signer);

    const tx = await this.contract.secureTransfer(
      fromAddress,
      toAddress,
      tokenId,
      ethers.toUtf8Bytes(newSealedKey),
      ethers.toUtf8Bytes(proof)
    );
    await tx.wait();
    console.log(`[INFTManager] Secure transfer tokenId=${tokenId} to ${toAddress}`);
  }

  /**
   * Authorize an executor (e.g. the KeeperHub bot address) to run agent logic.
   */
  async authorizeExecutor(
    tokenId: number,
    executorAddress: string,
    permissions: string[] = ["execute", "updateMetadata"]
  ): Promise<void> {
    const encodedPerms = ethers.toUtf8Bytes(JSON.stringify(permissions));
    const tx = await this.contract.authorizeUsage(tokenId, executorAddress, encodedPerms);
    await tx.wait();
    console.log(`[INFTManager] Authorized executor ${executorAddress} for tokenId=${tokenId}`);
  }

  async getMetadata(tokenId: number) {
    return this.contract.getAgentMetadata(tokenId);
  }

  async isAuthorized(tokenId: number, executor: string): Promise<boolean> {
    return this.contract.isAuthorizedExecutor(tokenId, executor);
  }
}
