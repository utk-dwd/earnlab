// ── Deployed contract addresses (Sepolia) ─────────────────────────────────
export const CONTRACT_ADDRESSES = {
  inft:            process.env.NEXT_PUBLIC_INFT_ADDRESS          as `0x${string}`,
  agentRegistry:   process.env.NEXT_PUBLIC_AGENT_REGISTRY_ADDRESS as `0x${string}`,
  marketplace:     process.env.NEXT_PUBLIC_MARKETPLACE_ADDRESS    as `0x${string}`,
  oracle:          process.env.NEXT_PUBLIC_ORACLE_ADDRESS         as `0x${string}`,
} as const;

// ── ERC7857iNFT ABI ───────────────────────────────────────────────────────
export const INFT_ABI = [
  // Mint
  {
    name: "mintAgent",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to",             type: "address" },
      { name: "metadataHash",   type: "bytes32" },
      { name: "encryptedURI",   type: "string"  },
      { name: "initialExecutor",type: "address" },
    ],
    outputs: [{ name: "tokenId", type: "uint256" }],
  },
  // Metadata
  {
    name: "updateMetadata",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "tokenId",        type: "uint256" },
      { name: "newHash",        type: "bytes32" },
      { name: "newEncryptedURI",type: "string"  },
    ],
    outputs: [],
  },
  {
    name: "getAgentMetadata",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{
      name: "",
      type: "tuple",
      components: [
        { name: "metadataHash",  type: "bytes32" },
        { name: "encryptedURI",  type: "string"  },
        { name: "lastUpdated",   type: "uint256" },
      ],
    }],
  },
  // Secure transfer
  {
    name: "secureTransfer",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "from",      type: "address" },
      { name: "to",        type: "address" },
      { name: "tokenId",   type: "uint256" },
      { name: "sealedKey", type: "bytes"   },
      { name: "proof",     type: "bytes"   },
    ],
    outputs: [],
  },
  // Clone
  {
    name: "clone",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to",        type: "address" },
      { name: "tokenId",   type: "uint256" },
      { name: "sealedKey", type: "bytes"   },
      { name: "proof",     type: "bytes"   },
    ],
    outputs: [{ name: "newTokenId", type: "uint256" }],
  },
  // Authorization
  {
    name: "authorizeUsage",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "tokenId",     type: "uint256" },
      { name: "executor",    type: "address" },
      { name: "permissions", type: "bytes"   },
    ],
    outputs: [],
  },
  {
    name: "revokeUsage",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "tokenId",  type: "uint256" },
      { name: "executor", type: "address" },
    ],
    outputs: [],
  },
  {
    name: "isAuthorizedExecutor",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "tokenId",  type: "uint256" },
      { name: "executor", type: "address" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  // ERC-721
  { name: "ownerOf",    type: "function", stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "address" }] },
  { name: "balanceOf",  type: "function", stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "", type: "uint256" }] },
  { name: "approve",    type: "function", stateMutability: "nonpayable",
    inputs: [{ name: "to", type: "address" }, { name: "tokenId", type: "uint256" }],
    outputs: [] },
  // Events
  { name: "MetadataUpdated", type: "event",
    inputs: [
      { name: "tokenId", type: "uint256", indexed: true },
      { name: "newHash", type: "bytes32", indexed: false },
    ]},
  { name: "UsageAuthorized", type: "event",
    inputs: [
      { name: "tokenId",  type: "uint256", indexed: true },
      { name: "executor", type: "address", indexed: true },
    ]},
  { name: "AgentCloned", type: "event",
    inputs: [
      { name: "originalId", type: "uint256", indexed: true },
      { name: "newId",      type: "uint256", indexed: true },
      { name: "to",         type: "address", indexed: false },
    ]},
  { name: "Transfer", type: "event",
    inputs: [
      { name: "from",    type: "address", indexed: true },
      { name: "to",      type: "address", indexed: true },
      { name: "tokenId", type: "uint256", indexed: true },
    ]},
] as const;

// ── AgentRegistry ABI ─────────────────────────────────────────────────────
export const AGENT_REGISTRY_ABI = [
  {
    name: "registerAgent",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "inftTokenId",      type: "uint256" },
      { name: "strategyExecutor", type: "address" },
      { name: "strategyHash",     type: "bytes32" },
    ],
    outputs: [{ name: "agentId", type: "uint256" }],
  },
  {
    name: "setStatus",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "status",  type: "uint8"   },
    ],
    outputs: [],
  },
  {
    name: "getAgent",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "agentId", type: "uint256" }],
    outputs: [{
      name: "",
      type: "tuple",
      components: [
        { name: "inftTokenId",      type: "uint256" },
        { name: "owner",            type: "address" },
        { name: "strategyExecutor", type: "address" },
        { name: "status",           type: "uint8"   },
        { name: "createdAt",        type: "uint256" },
        { name: "strategyHash",     type: "bytes32" },
      ],
    }],
  },
  {
    name: "getOwnerAgents",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "", type: "uint256[]" }],
  },
  {
    name: "triggerExecution",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "agentId",        type: "uint256" },
      { name: "executionParams",type: "bytes"   },
    ],
    outputs: [{ name: "executionId", type: "bytes32" }],
  },
  { name: "AgentRegistered", type: "event",
    inputs: [
      { name: "agentId",     type: "uint256", indexed: true },
      { name: "owner",       type: "address", indexed: true },
      { name: "inftTokenId", type: "uint256", indexed: false },
    ]},
] as const;

// ── Marketplace ABI ───────────────────────────────────────────────────────
export const MARKETPLACE_ABI = [
  {
    name: "list",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "tokenId", type: "uint256" },
      { name: "price",   type: "uint256" },
    ],
    outputs: [],
  },
  {
    name: "buy",
    type: "function",
    stateMutability: "payable",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [],
  },
  {
    name: "leaseAgent",
    type: "function",
    stateMutability: "payable",
    inputs: [
      { name: "tokenId",      type: "uint256" },
      { name: "epochs",       type: "uint256" },
      { name: "pricePerEpoch",type: "uint256" },
    ],
    outputs: [],
  },
  {
    name: "listings",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "", type: "uint256" }],
    outputs: [
      { name: "seller",   type: "address" },
      { name: "tokenId",  type: "uint256" },
      { name: "price",    type: "uint256" },
      { name: "isActive", type: "bool"    },
    ],
  },
  { name: "Listed", type: "event",
    inputs: [
      { name: "tokenId", type: "uint256", indexed: true },
      { name: "seller",  type: "address", indexed: true },
      { name: "price",   type: "uint256", indexed: false },
    ]},
  { name: "Sold", type: "event",
    inputs: [
      { name: "tokenId", type: "uint256", indexed: true },
      { name: "buyer",   type: "address", indexed: true },
      { name: "price",   type: "uint256", indexed: false },
    ]},
] as const;
