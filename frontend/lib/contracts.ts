export const AGENT_REGISTRY_ABI = [
  "function registerAgent(uint256 inftTokenId, address strategyExecutor, bytes32 strategyHash) returns (uint256)",
  "function setStatus(uint256 agentId, uint8 status)",
  "function getAgent(uint256 agentId) view returns (tuple(uint256 inftTokenId, address owner, address strategyExecutor, uint8 status, uint256 createdAt, bytes32 strategyHash))",
  "function getOwnerAgents(address owner) view returns (uint256[])",
] as const;
export const MARKETPLACE_ABI = [
  "function list(uint256 tokenId, uint256 price)",
  "function buy(uint256 tokenId) payable",
  "function leaseAgent(uint256 tokenId, uint256 epochs, uint256 pricePerEpoch) payable",
  "function listings(uint256) view returns (address seller, uint256 tokenId, uint256 price, bool isActive)",
] as const;
export const INFT_ABI = [
  "function mintAgent(address to, bytes32 initialMetadataHash, address executor) returns (uint256)",
  "function updateMetadata(uint256 tokenId, bytes32 newMetadataHash)",
  "function getAgentMetadata(uint256 tokenId) view returns (tuple(bytes32 metadataHash, uint256 lastUpdated, address authorizedUpdater))",
  "function ownerOf(uint256 tokenId) view returns (address)",
] as const;
export const CONTRACT_ADDRESSES = {
  agentRegistry: process.env.NEXT_PUBLIC_AGENT_REGISTRY_ADDRESS as `0x${string}`,
  marketplace: process.env.NEXT_PUBLIC_MARKETPLACE_ADDRESS as `0x${string}`,
  inft: process.env.NEXT_PUBLIC_INFT_ADDRESS as `0x${string}`,
};
