import { expect } from "chai";
import { ethers } from "hardhat";

describe("AgentRegistry", () => {
  async function deploy() {
    const [owner, user] = await ethers.getSigners();
    const iNFT = await ethers.deployContract("ERC7857iNFT");
    const registry = await ethers.deployContract("AgentRegistry", [await iNFT.getAddress()]);
    return { iNFT, registry, owner, user };
  }
  it("mints iNFT and registers agent", async () => {
    const { iNFT, registry, owner } = await deploy();
    const strategyHash = ethers.keccak256(ethers.toUtf8Bytes("delta-neutral-v1"));
    await iNFT.mintAgent(owner.address, strategyHash, owner.address);
    await registry.registerAgent(0, owner.address, strategyHash);
    const agent = await registry.getAgent(0);
    expect(agent.owner).to.equal(owner.address);
  });
  it("only owner can set agent status", async () => {
    const { iNFT, registry, owner, user } = await deploy();
    const hash = ethers.keccak256(ethers.toUtf8Bytes("test"));
    await iNFT.mintAgent(owner.address, hash, owner.address);
    await registry.registerAgent(0, owner.address, hash);
    await expect(registry.connect(user).setStatus(0, 1)).to.be.revertedWith("Not owner");
  });
});
