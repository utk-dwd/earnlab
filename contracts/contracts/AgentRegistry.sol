// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "./interfaces/IAgentRegistry.sol";
import "./interfaces/IERC7857.sol";

contract AgentRegistry is IAgentRegistry, Ownable {
    uint256 private _nextAgentId;
    IERC7857 public immutable inftContract;
    mapping(uint256 => Agent) private _agents;
    mapping(address => uint256[]) private _ownerAgents;

    constructor(address inftAddress) Ownable(msg.sender) { inftContract = IERC7857(inftAddress); }

    function registerAgent(uint256 inftTokenId, address strategyExecutor, bytes32 strategyHash) external override returns (uint256 agentId) {
        IERC7857.AgentMetadata memory meta = inftContract.getAgentMetadata(inftTokenId);
        require(meta.authorizedUpdater != address(0), "Invalid iNFT");
        agentId = _nextAgentId++;
        _agents[agentId] = Agent({ inftTokenId: inftTokenId, owner: msg.sender, strategyExecutor: strategyExecutor, status: AgentStatus.Inactive, createdAt: block.timestamp, strategyHash: strategyHash });
        _ownerAgents[msg.sender].push(agentId);
        emit AgentRegistered(agentId, msg.sender, inftTokenId);
    }

    function setStatus(uint256 agentId, AgentStatus status) external override {
        require(_agents[agentId].owner == msg.sender, "Not owner");
        _agents[agentId].status = status;
        emit AgentStatusChanged(agentId, status);
    }

    function getAgent(uint256 agentId) external view override returns (Agent memory) { return _agents[agentId]; }

    function triggerExecution(uint256 agentId, bytes calldata executionParams) external override returns (bytes32 executionId) {
        Agent storage agent = _agents[agentId];
        require(agent.status == AgentStatus.Active, "Agent not active");
        require(msg.sender == agent.owner || msg.sender == agent.strategyExecutor, "Not authorized");
        executionId = keccak256(abi.encodePacked(agentId, block.timestamp, executionParams));
        emit ExecutionTriggered(agentId, executionId);
    }

    function getOwnerAgents(address owner) external view returns (uint256[] memory) { return _ownerAgents[owner]; }
}
