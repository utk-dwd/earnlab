import { ethers } from "hardhat";

const INFT_ADDRESS = "0x7F70409501069D5daf9E3eD54B931b4dd61B2f71";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying with:", deployer.address);
  const marketplace = await ethers.deployContract("EarnlabMarketplace", [INFT_ADDRESS]);
  await marketplace.waitForDeployment();
  const addr = await marketplace.getAddress();
  console.log("EarnlabMarketplace:", addr);
  console.log("\nUpdate your .env:");
  console.log(`MARKETPLACE_ADDRESS=${addr}`);
  console.log(`NEXT_PUBLIC_MARKETPLACE_ADDRESS=${addr}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
