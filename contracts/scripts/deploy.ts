import { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying with:", deployer.address);
  console.log("Balance:", ethers.formatEther(await deployer.provider.getBalance(deployer.address)), "ETH");

  // 1. Deploy MockOracle (replace with TEE oracle in production)
  const oracle = await ethers.deployContract("MockOracle");
  await oracle.waitForDeployment();
  console.log("MockOracle:         ", await oracle.getAddress());

  // 2. Deploy ERC7857iNFT with oracle
  const iNFT = await ethers.deployContract("ERC7857iNFT", [await oracle.getAddress()]);
  await iNFT.waitForDeployment();
  console.log("ERC7857iNFT:        ", await iNFT.getAddress());

  // 3. Deploy AgentRegistry
  const registry = await ethers.deployContract("AgentRegistry", [await iNFT.getAddress()]);
  await registry.waitForDeployment();
  console.log("AgentRegistry:      ", await registry.getAddress());

  // 4. Deploy Marketplace
  const marketplace = await ethers.deployContract("EarnlabMarketplace", [await iNFT.getAddress()]);
  await marketplace.waitForDeployment();
  console.log("EarnlabMarketplace: ", await marketplace.getAddress());

  // 5. Mint a sample agent iNFT for testing
  const sampleHash = ethers.keccak256(ethers.toUtf8Bytes("earnlab-agent-v1-initial-state"));
  const sampleURI  = "0g://placeholder-encrypted-uri";
  const mintTx = await iNFT.mintAgent(
    deployer.address,
    sampleHash,
    sampleURI,
    registry.getAddress()  // registry as initial executor
  );
  await mintTx.wait();
  console.log("Sample agent iNFT minted (tokenId=0)");

  console.log("\n── Copy these into your .env ──────────────────────────────");
  console.log(`INFT_ADDRESS=${await iNFT.getAddress()}`);
  console.log(`AGENT_REGISTRY_ADDRESS=${await registry.getAddress()}`);
  console.log(`MARKETPLACE_ADDRESS=${await marketplace.getAddress()}`);
  console.log(`ORACLE_ADDRESS=${await oracle.getAddress()}`);
  console.log("───────────────────────────────────────────────────────────");
}

main().catch((e) => { console.error(e); process.exit(1); });
