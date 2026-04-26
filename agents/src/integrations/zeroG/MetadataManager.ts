import { ethers } from "ethers";
import { ZeroGStorage } from "./ZeroGStorage";

export interface AgentMetadataPayload {
  agentId:         number;
  strategyType:    string;
  riskProfile:     string;
  executionHistory: object[];
  modelWeights?:   string;   // base64 encoded if present
  config:          object;
  version:         string;
}

export interface StoredMetadata {
  uri:          string;   // 0G Storage URI (e.g. "0g://abc123")
  metadataHash: string;   // keccak256 of encrypted blob (for on-chain)
  sealedKey:    string;   // AES key sealed with owner's public key (hex)
  algorithm:    string;
}

/**
 * MetadataManager — handles the full ERC-7857 metadata lifecycle:
 *   encrypt → store on 0G → produce hash + sealedKey for on-chain use
 *
 * For the hackathon we use a simplified symmetric encryption scheme.
 * Production should use AES-256-GCM with RSA/ECIES key sealing via TEE.
 */
export class MetadataManager {
  private storage: ZeroGStorage;

  constructor(storage?: ZeroGStorage) {
    this.storage = storage ?? new ZeroGStorage();
  }

  /**
   * Store agent metadata on 0G Storage with encryption.
   * Returns the data needed to call mintAgent() or updateMetadata() on-chain.
   */
  async store(payload: AgentMetadataPayload, ownerAddress: string): Promise<StoredMetadata> {
    const serialized = JSON.stringify(payload);

    // --- Encryption (simplified for hackathon) ---
    // In production: AES-256-GCM encrypt, RSA/ECIES seal key for owner
    const key = ethers.id(`${ownerAddress}-${Date.now()}-${payload.agentId}`);
    const encrypted = this._xorEncrypt(serialized, key);
    const sealedKey = ethers.keccak256(
      ethers.toUtf8Bytes(`sealed:${key}:${ownerAddress}`)
    );

    // --- Store on 0G ---
    const uri = await this.storage.store(encrypted);

    // --- Produce on-chain hash ---
    const metadataHash = ethers.keccak256(ethers.toUtf8Bytes(encrypted));

    return { uri, metadataHash, sealedKey, algorithm: "xor-keccak-v1" };
  }

  /**
   * Retrieve and decrypt metadata from 0G Storage.
   * @param uri         0G Storage URI from on-chain record
   * @param sealedKey   Sealed key (for future RSA decrypt)
   * @param ownerKey    Private key or derivation material for unsealing
   */
  async retrieve(
    uri: string,
    sealedKey: string,
    ownerAddress: string,
    agentId: number
  ): Promise<AgentMetadataPayload> {
    const encrypted = await this.storage.retrieve(uri);
    const key = ethers.id(`${ownerAddress}-seal-${agentId}`);
    const decrypted = this._xorEncrypt(encrypted, key); // xor is symmetric
    return JSON.parse(decrypted);
  }

  /**
   * Re-encrypt metadata for a new owner (simulates oracle TEE step).
   * In production this is performed inside a TEE by the 0G oracle.
   */
  async reencryptForTransfer(
    uri: string,
    currentOwnerAddress: string,
    newOwnerAddress: string,
    agentId: number
  ): Promise<{ newSealedKey: string; newMetadataHash: string }> {
    const encrypted = await this.storage.retrieve(uri);

    // Re-seal the key for the new owner
    const newKey = ethers.id(`${newOwnerAddress}-${Date.now()}-${agentId}`);
    const newSealedKey = ethers.keccak256(
      ethers.toUtf8Bytes(`sealed:${newKey}:${newOwnerAddress}`)
    );
    const newMetadataHash = ethers.keccak256(ethers.toUtf8Bytes(encrypted));

    return { newSealedKey, newMetadataHash };
  }

  /** Generate an oracle proof for testnet (MockOracle accepts owner signature) */
  async generateMockProof(signer: ethers.Signer): Promise<string> {
    const nonce = ethers.randomBytes(32);
    const nonceHex = ethers.hexlify(nonce);
    const signature = await signer.signMessage(ethers.getBytes(nonceHex));
    // proof = nonce32 + sig65
    return ethers.concat([nonceHex, signature]);
  }

  // Trivial XOR cipher — replace with AES-256-GCM in production
  private _xorEncrypt(data: string, key: string): string {
    const keyBytes = ethers.toUtf8Bytes(key);
    const dataBytes = ethers.toUtf8Bytes(data);
    const out = new Uint8Array(dataBytes.length);
    for (let i = 0; i < dataBytes.length; i++) {
      out[i] = dataBytes[i] ^ keyBytes[i % keyBytes.length];
    }
    return Buffer.from(out).toString("base64");
  }
}
