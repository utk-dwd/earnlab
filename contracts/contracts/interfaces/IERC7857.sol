// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC7857 {
    struct AgentMetadata {
        bytes32 metadataHash;
        uint256 lastUpdated;
        address authorizedUpdater;
    }
    event MetadataUpdated(uint256 indexed tokenId, bytes32 newHash, address updater);
    event ExecutorUpdated(uint256 indexed tokenId, address executor);
    function mintAgent(address to, bytes32 initialMetadataHash, address executor) external returns (uint256 tokenId);
    function updateMetadata(uint256 tokenId, bytes32 newMetadataHash) external;
    function setExecutor(uint256 tokenId, address executor) external;
    function getAgentMetadata(uint256 tokenId) external view returns (AgentMetadata memory);
}
