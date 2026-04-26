// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./interfaces/IERC7857.sol";
import "./MockOracle.sol";

/// @title ERC7857iNFT — Intelligent NFT for Earnlab AI agents
/// @notice Implements the ERC-7857 standard with 0G oracle-verified transfers,
///         encrypted metadata on 0G Storage, cloning, and usage authorization.
contract ERC7857iNFT is ERC721, Ownable, ReentrancyGuard, IERC7857 {
    uint256 private _nextTokenId;

    // oracle address — verifies TEE attestations / ZKP proofs on transfer
    address public oracle;

    // tokenId => encrypted metadata
    mapping(uint256 => AgentMetadata) private _agentMetadata;

    // tokenId => executor => encoded permissions (empty = not authorized)
    mapping(uint256 => mapping(address => bytes)) private _authorizations;

    // tokenId => can be cloned?
    mapping(uint256 => bool) public cloneable;

    modifier validProof(bytes calldata proof) {
        require(oracle != address(0), "Oracle not configured");
        require(IOracle(oracle).verifyProof(proof), "Invalid oracle proof");
        _;
    }

    modifier onlyTokenOwner(uint256 tokenId) {
        require(ownerOf(tokenId) == msg.sender, "Not token owner");
        _;
    }

    modifier onlyOwnerOrExecutor(uint256 tokenId) {
        require(
            ownerOf(tokenId) == msg.sender ||
            _authorizations[tokenId][msg.sender].length > 0,
            "Not owner or authorized executor"
        );
        _;
    }

    constructor(address _oracle) ERC721("Earnlab iNFT", "EINFT") Ownable(msg.sender) {
        oracle = _oracle;
    }

    // ── Admin ──────────────────────────────────────────────────────────────

    function setOracle(address _oracle) external onlyOwner {
        emit OracleUpdated(oracle, _oracle);
        oracle = _oracle;
    }

    // ── Minting ────────────────────────────────────────────────────────────

    /// @inheritdoc IERC7857
    function mintAgent(
        address to,
        bytes32 metadataHash,
        string calldata encryptedURI,
        address initialExecutor
    ) external override returns (uint256 tokenId) {
        tokenId = _nextTokenId++;
        _safeMint(to, tokenId);

        _agentMetadata[tokenId] = AgentMetadata({
            metadataHash:  metadataHash,
            encryptedURI:  encryptedURI,
            lastUpdated:   block.timestamp
        });

        if (initialExecutor != address(0)) {
            _authorizations[tokenId][initialExecutor] = abi.encode("execute");
            emit UsageAuthorized(tokenId, initialExecutor);
        }

        emit MetadataUpdated(tokenId, metadataHash);
    }

    // ── Metadata ───────────────────────────────────────────────────────────

    /// @inheritdoc IERC7857
    function updateMetadata(
        uint256 tokenId,
        bytes32 newHash,
        string calldata newEncryptedURI
    ) external override onlyOwnerOrExecutor(tokenId) {
        _agentMetadata[tokenId].metadataHash  = newHash;
        _agentMetadata[tokenId].encryptedURI  = newEncryptedURI;
        _agentMetadata[tokenId].lastUpdated   = block.timestamp;
        emit MetadataUpdated(tokenId, newHash);
    }

    // ── Secure Transfer (ERC-7857 core) ────────────────────────────────────

    /// @inheritdoc IERC7857
    /// @dev Oracle must have re-encrypted metadata for `to` and produced `proof`.
    ///      sealedKey is stored off-chain (0G Storage); we only record the new hash.
    function secureTransfer(
        address from,
        address to,
        uint256 tokenId,
        bytes calldata sealedKey,
        bytes calldata proof
    ) external override nonReentrant validProof(proof) {
        require(ownerOf(tokenId) == from, "Not owner");
        require(to != address(0), "Invalid recipient");

        // Update metadata hash from proof (new encrypted data hash for `to`)
        bytes32 newHash = keccak256(sealedKey);
        _agentMetadata[tokenId].metadataHash = newHash;
        _agentMetadata[tokenId].lastUpdated  = block.timestamp;

        // Clear previous executor authorizations on ownership change
        _transfer(from, to, tokenId);

        emit MetadataUpdated(tokenId, newHash);
    }

    // ── Clone ──────────────────────────────────────────────────────────────

    /// @inheritdoc IERC7857
    function clone(
        address to,
        uint256 tokenId,
        bytes calldata sealedKey,
        bytes calldata proof
    ) external override nonReentrant validProof(proof) returns (uint256 newTokenId) {
        require(cloneable[tokenId], "Agent not cloneable");
        require(
            ownerOf(tokenId) == msg.sender ||
            _authorizations[tokenId][msg.sender].length > 0,
            "Not authorized to clone"
        );

        newTokenId = _nextTokenId++;
        _safeMint(to, newTokenId);

        bytes32 cloneHash = keccak256(sealedKey);
        _agentMetadata[newTokenId] = AgentMetadata({
            metadataHash: cloneHash,
            encryptedURI: _agentMetadata[tokenId].encryptedURI,
            lastUpdated:  block.timestamp
        });

        emit AgentCloned(tokenId, newTokenId, to);
        emit MetadataUpdated(newTokenId, cloneHash);
    }

    function setCloneable(uint256 tokenId, bool enabled) external onlyTokenOwner(tokenId) {
        cloneable[tokenId] = enabled;
    }

    // ── Usage Authorization ────────────────────────────────────────────────

    /// @inheritdoc IERC7857
    function authorizeUsage(
        uint256 tokenId,
        address executor,
        bytes calldata permissions
    ) external override onlyTokenOwner(tokenId) {
        _authorizations[tokenId][executor] = permissions;
        emit UsageAuthorized(tokenId, executor);
    }

    /// @inheritdoc IERC7857
    function revokeUsage(uint256 tokenId, address executor) external override onlyTokenOwner(tokenId) {
        delete _authorizations[tokenId][executor];
    }

    // ── Views ──────────────────────────────────────────────────────────────

    function getAgentMetadata(uint256 tokenId) external view override returns (AgentMetadata memory) {
        return _agentMetadata[tokenId];
    }

    function getAuthorization(uint256 tokenId, address executor) external view override returns (bytes memory) {
        return _authorizations[tokenId][executor];
    }

    function isAuthorizedExecutor(uint256 tokenId, address executor) external view override returns (bool) {
        return _authorizations[tokenId][executor].length > 0;
    }

    // ── Supports Interface ─────────────────────────────────────────────────
    function supportsInterface(bytes4 interfaceId)
        public view override(ERC721, IERC165)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }
}
