// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC721/IERC721.sol";

/// @title IERC7857 — Intelligent NFT standard for AI agents (0G Network)
/// @notice Extends ERC-721 with encrypted metadata, oracle-verified transfers,
///         cloning, and usage authorization.
interface IERC7857 is IERC721 {
    // ── Events ─────────────────────────────────────────────────────────────
    event MetadataUpdated(uint256 indexed tokenId, bytes32 newHash);
    event UsageAuthorized(uint256 indexed tokenId, address indexed executor);
    event OracleUpdated(address oldOracle, address newOracle);
    event AgentCloned(uint256 indexed originalId, uint256 indexed newId, address to);

    // ── Structs ────────────────────────────────────────────────────────────
    struct AgentMetadata {
        bytes32 metadataHash;       // keccak256 of encrypted metadata blob
        string  encryptedURI;       // 0G Storage URI to encrypted metadata
        uint256 lastUpdated;
    }

    // ── Core ERC-7857 functions ────────────────────────────────────────────

    /// @notice Secure transfer — oracle re-encrypts metadata for new owner
    /// @param from     Current owner
    /// @param to       New owner
    /// @param tokenId  Token to transfer
    /// @param sealedKey  Metadata key sealed for `to`'s public key (oracle output)
    /// @param proof    TEE attestation or ZKP proof from oracle
    function secureTransfer(
        address from,
        address to,
        uint256 tokenId,
        bytes calldata sealedKey,
        bytes calldata proof
    ) external;

    /// @notice Clone an agent — creates a new token with same encrypted metadata
    /// @param to       Owner of the clone
    /// @param tokenId  Token to clone
    /// @param sealedKey  Metadata key sealed for `to`
    /// @param proof    Oracle proof
    /// @return newTokenId
    function clone(
        address to,
        uint256 tokenId,
        bytes calldata sealedKey,
        bytes calldata proof
    ) external returns (uint256 newTokenId);

    /// @notice Grant an executor access to use (not own) the agent
    /// @param tokenId    Token ID
    /// @param executor   Address allowed to execute agent logic
    /// @param permissions  ABI-encoded permission bytes
    function authorizeUsage(
        uint256 tokenId,
        address executor,
        bytes calldata permissions
    ) external;

    /// @notice Revoke executor access
    function revokeUsage(uint256 tokenId, address executor) external;

    /// @notice Mint a new agent iNFT (initial encrypted metadata stored on 0G)
    function mintAgent(
        address to,
        bytes32 metadataHash,
        string calldata encryptedURI,
        address initialExecutor
    ) external returns (uint256 tokenId);

    /// @notice Update metadata hash + URI after agent learning (executor only)
    function updateMetadata(
        uint256 tokenId,
        bytes32 newHash,
        string calldata newEncryptedURI
    ) external;

    // ── View functions ─────────────────────────────────────────────────────
    function getAgentMetadata(uint256 tokenId) external view returns (AgentMetadata memory);
    function getAuthorization(uint256 tokenId, address executor) external view returns (bytes memory);
    function isAuthorizedExecutor(uint256 tokenId, address executor) external view returns (bool);
}
