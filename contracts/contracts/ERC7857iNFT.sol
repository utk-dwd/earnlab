// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "./interfaces/IERC7857.sol";

contract ERC7857iNFT is ERC721, Ownable, IERC7857 {
    uint256 private _nextTokenId;
    mapping(uint256 => AgentMetadata) private _metadata;

    modifier onlyTokenOwnerOrExecutor(uint256 tokenId) {
        require(ownerOf(tokenId) == msg.sender || _metadata[tokenId].authorizedUpdater == msg.sender, "Not authorized");
        _;
    }

    constructor() ERC721("Earnlab iNFT", "EINFT") Ownable(msg.sender) {}

    function mintAgent(address to, bytes32 initialMetadataHash, address executor) external override returns (uint256 tokenId) {
        tokenId = _nextTokenId++;
        _safeMint(to, tokenId);
        _metadata[tokenId] = AgentMetadata({ metadataHash: initialMetadataHash, lastUpdated: block.timestamp, authorizedUpdater: executor });
        emit MetadataUpdated(tokenId, initialMetadataHash, executor);
    }

    function updateMetadata(uint256 tokenId, bytes32 newMetadataHash) external override onlyTokenOwnerOrExecutor(tokenId) {
        _metadata[tokenId].metadataHash = newMetadataHash;
        _metadata[tokenId].lastUpdated = block.timestamp;
        emit MetadataUpdated(tokenId, newMetadataHash, msg.sender);
    }

    function setExecutor(uint256 tokenId, address executor) external override {
        require(ownerOf(tokenId) == msg.sender, "Not owner");
        _metadata[tokenId].authorizedUpdater = executor;
        emit ExecutorUpdated(tokenId, executor);
    }

    function getAgentMetadata(uint256 tokenId) external view override returns (AgentMetadata memory) {
        return _metadata[tokenId];
    }
}
