// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * EarnYldAgentINFT — ERC-7857-style Intelligent NFT for EarnYld yield strategies.
 *
 * Each token represents an ownable AI yield agent with:
 *   - Strategy config and risk parameters
 *   - A pointer to encrypted agent state on 0G Storage (storageUri = root hash)
 *   - Permissions controlling whether the agent can execute autonomously
 *   - clone() — fork a strategy for separate ownership
 *   - authorizeUsage() — grant another wallet execution rights without transferring
 *
 * Differences from full ERC-7857:
 *   - TEE re-encryption on transfer is omitted for testnet (0G Compute phase)
 *   - Oracle verification is omitted; state integrity is enforced by 0G Storage proofs
 *
 * Deploy to: 0G Galileo testnet (chain ID 16602)
 * Token:     0G (native) — gas fee only
 */

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

contract EarnYldAgentINFT is ERC721, Ownable {

    // ─── Types ────────────────────────────────────────────────────────────────

    struct AgentPermissions {
        bool  canExecute;       // false = read-only signal; true = can send txs
        bool  requiresHITL;     // true  = all actions need human approval
        uint8 maxAllocationPct; // 0–100; caps Kelly sizing for this agent
    }

    struct AgentState {
        string          name;
        string          strategyType;    // e.g. "conservative-stable"
        string          riskProfile;     // "low" | "moderate" | "high"
        string          storageUri;      // 0G Storage root hash — full agent artifact
        string          version;         // semver
        AgentPermissions permissions;
        uint256         mintedAt;
        uint256         parentTokenId;   // 0 = original, >0 = clone lineage
    }

    // ─── Storage ──────────────────────────────────────────────────────────────

    uint256 private _nextId = 1;

    mapping(uint256 => AgentState)              private _states;
    mapping(uint256 => mapping(address => bool)) private _authorized;
    mapping(uint256 => address[])               private _authorizedList;

    // ─── Events ───────────────────────────────────────────────────────────────

    event AgentMinted(
        uint256 indexed tokenId,
        address indexed owner,
        string  name,
        string  strategyType,
        string  storageUri
    );
    event AgentCloned(
        uint256 indexed originalId,
        uint256 indexed cloneId,
        address indexed cloneOwner
    );
    event UsageAuthorized(uint256 indexed tokenId, address indexed user, bool authorized);
    event StorageUriUpdated(uint256 indexed tokenId, string newUri);

    // ─── Constructor ──────────────────────────────────────────────────────────

    constructor() ERC721("EarnYld Agent INFT", "EYINFT") Ownable(msg.sender) {}

    // ─── Mint ─────────────────────────────────────────────────────────────────

    /**
     * Mint a new agent INFT.  storageUri should be the 0G Storage root hash
     * of the encrypted agent artifact uploaded before calling this.
     */
    function mintAgent(
        address             to,
        string  calldata    name,
        string  calldata    strategyType,
        string  calldata    riskProfile,
        string  calldata    storageUri,
        string  calldata    version,
        AgentPermissions calldata permissions
    ) external returns (uint256 tokenId) {
        tokenId = _nextId++;
        _safeMint(to, tokenId);
        _states[tokenId] = AgentState({
            name:          name,
            strategyType:  strategyType,
            riskProfile:   riskProfile,
            storageUri:    storageUri,
            version:       version,
            permissions:   permissions,
            mintedAt:      block.timestamp,
            parentTokenId: 0
        });
        emit AgentMinted(tokenId, to, name, strategyType, storageUri);
    }

    // ─── Clone ────────────────────────────────────────────────────────────────

    /**
     * Fork an existing agent strategy to a new owner.  The clone starts with
     * the same storageUri (pointing to the same 0G artifact snapshot) but has
     * separate ownership and authorization state.
     */
    function clone(uint256 tokenId, address cloneOwner) external returns (uint256 cloneId) {
        require(_ownerOf(tokenId) != address(0), "Token does not exist");
        require(
            ownerOf(tokenId) == msg.sender || _authorized[tokenId][msg.sender],
            "Not authorized"
        );

        AgentState storage orig = _states[tokenId];
        cloneId = _nextId++;
        _safeMint(cloneOwner, cloneId);
        _states[cloneId] = AgentState({
            name:          string(abi.encodePacked(orig.name, " (Clone)")),
            strategyType:  orig.strategyType,
            riskProfile:   orig.riskProfile,
            storageUri:    orig.storageUri,
            version:       orig.version,
            permissions:   orig.permissions,
            mintedAt:      block.timestamp,
            parentTokenId: tokenId
        });
        emit AgentCloned(tokenId, cloneId, cloneOwner);
    }

    // ─── Authorize ────────────────────────────────────────────────────────────

    /**
     * Grant or revoke execution rights to another wallet without transferring
     * token ownership.  Authorized users can trigger agent actions via the
     * EarnYld API but the NFT remains in the owner's wallet.
     */
    function authorizeUsage(uint256 tokenId, address user, bool authorized) external {
        require(ownerOf(tokenId) == msg.sender, "Not token owner");
        if (authorized && !_authorized[tokenId][user]) {
            _authorizedList[tokenId].push(user);
        }
        _authorized[tokenId][user] = authorized;
        emit UsageAuthorized(tokenId, user, authorized);
    }

    // ─── Storage URI update ───────────────────────────────────────────────────

    /**
     * Update the 0G Storage pointer after the agent's state snapshot changes
     * (e.g. after new trades are recorded or weights are updated).
     */
    function updateStorageUri(uint256 tokenId, string calldata newUri) external {
        require(ownerOf(tokenId) == msg.sender, "Not token owner");
        _states[tokenId].storageUri = newUri;
        emit StorageUriUpdated(tokenId, newUri);
    }

    // ─── Views ────────────────────────────────────────────────────────────────

    function isAuthorized(uint256 tokenId, address user) external view returns (bool) {
        return ownerOf(tokenId) == user || _authorized[tokenId][user];
    }

    function getAgentState(uint256 tokenId) external view returns (AgentState memory) {
        require(_ownerOf(tokenId) != address(0), "Token does not exist");
        return _states[tokenId];
    }

    function getAuthorizedUsers(uint256 tokenId) external view returns (address[] memory) {
        return _authorizedList[tokenId];
    }

    function totalSupply() external view returns (uint256) {
        return _nextId - 1;
    }

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        require(_ownerOf(tokenId) != address(0), "Token does not exist");
        return string(abi.encodePacked("0g://", _states[tokenId].storageUri));
    }
}
