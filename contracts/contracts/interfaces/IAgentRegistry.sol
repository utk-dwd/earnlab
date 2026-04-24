// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IAgentRegistry {
    enum AgentStatus { Inactive, Active, Paused }
    struct Agent {
        uint256 inftTokenId;
        address owner;
        address strategyExecutor;
        AgentStatus status;
        uint256 createdAt;
        bytes32 strategyHash;
    }
    event AgentRegistered(uint256 indexed agentId, address indexed owner, uint256 inftTokenId);
    event AgentStatusChanged(uint256 indexed agentId, AgentStatus status);
    event ExecutionTriggered(uint256 indexed agentId, bytes32 executionId);
    function registerAgent(uint256 inftTokenId, address strategyExecutor, bytes32 strategyHash) external returns (uint256 agentId);
    function setStatus(uint256 agentId, AgentStatus status) external;
    function getAgent(uint256 agentId) external view returns (Agent memory);
    function triggerExecution(uint256 agentId, bytes calldata executionParams) external returns (bytes32 executionId);
}
