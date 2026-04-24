import { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying with:", deployer.address);
  const iNFT = await ethers.deployContract("ERC7857iNFT");
  await iNFT.waitForDeployment();
  console.log("ERC7857iNFT:", await iNFT.getAddress());
  const registry = await ethers.deployContract("AgentRegistry", [await iNFT.getAddress()]);
  await registry.waitForDeployment();
  console.log("AgentRegistry:", await registry.getAddress());
  const marketplace = await ethers.deployContract("EarnlabMarketplace", [await iNFT.getAddress()]);
  await marketplace.waitForDeployment();
  console.log("EarnlabMarketplace:", await marketplace.getAddress());
  console.log("\nUpdate your .env:");
  console.log(`INFT_ADDRESS=${await iNFT.getAddress()}`);
  console.log(`AGENT_REGISTRY_ADDRESS=${await registry.getAddress()}`);
  console.log(`MARKETPLACE_ADDRESS=${await marketplace.getAddress()}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
