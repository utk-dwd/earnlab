"use client";

import { useState } from "react";
import { useAccount, useWriteContract, useWaitForTransactionReceipt } from "wagmi";
import { AGENT_REGISTRY_ABI, CONTRACT_ADDRESSES } from "../lib/contracts";
import { ethers } from "ethers";

export function RegisterAgent() {
  const { address } = useAccount();
  const [tokenId, setTokenId] = useState("0");
  const [open, setOpen] = useState(false);

  const strategyHash = ethers.keccak256(
    ethers.toUtf8Bytes(`earnlab-agent-v1-${tokenId}`)
  ) as `0x${string}`;

  const { writeContract, data: txHash, isPending, error } = useWriteContract();

  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({
    hash: txHash,
  });

  const handleRegister = () => {
    if (!address) return;
    writeContract({
      address: CONTRACT_ADDRESSES.agentRegistry,
      abi: AGENT_REGISTRY_ABI,
      functionName: "registerAgent",
      args: [
        BigInt(tokenId),   // inftTokenId
        address,           // strategyExecutor (your wallet)
        strategyHash,      // strategyHash
      ],
    });
  };

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="btn-secondary text-sm">
        + Register iNFT Agent
      </button>
    );
  }

  return (
    <div className="glass-card p-5 max-w-sm">
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-semibold">Register Agent</h3>
        <button onClick={() => setOpen(false)} className="text-white/40 hover:text-white text-lg">✕</button>
      </div>

      <div className="space-y-4">
        <div>
          <label className="text-xs text-white/50 uppercase tracking-wider block mb-2">
            iNFT Token ID
          </label>
          <input
            type="number"
            value={tokenId}
            onChange={(e) => setTokenId(e.target.value)}
            min="0"
            className="w-full bg-dark-900 border border-white/10 rounded-xl px-4 py-3 text-sm
                       focus:outline-none focus:border-brand-green/50 transition-colors"
          />
          <p className="text-xs text-white/30 mt-1">Token #0 was minted to your wallet during deploy</p>
        </div>

        <div className="bg-dark-900 rounded-xl p-3 space-y-1.5">
          <div className="flex justify-between text-xs">
            <span className="text-white/40">Executor</span>
            <span className="font-mono text-white/60">
              {address ? `${address.slice(0,6)}...${address.slice(-4)}` : "—"}
            </span>
          </div>
          <div className="flex justify-between text-xs">
            <span className="text-white/40">Strategy hash</span>
            <span className="font-mono text-white/60">{strategyHash.slice(0,12)}...</span>
          </div>
          <div className="flex justify-between text-xs">
            <span className="text-white/40">Registry</span>
            <span className="font-mono text-white/60">
              {CONTRACT_ADDRESSES.agentRegistry
                ? `${CONTRACT_ADDRESSES.agentRegistry.slice(0,6)}...${CONTRACT_ADDRESSES.agentRegistry.slice(-4)}`
                : "not set"}
            </span>
          </div>
        </div>

        {error && (
          <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-3 text-xs text-red-400">
            {error.message.slice(0, 120)}
          </div>
        )}

        {isSuccess && (
          <div className="bg-green-500/10 border border-green-500/20 rounded-xl p-3 text-xs text-green-400">
            ✓ Agent registered! Refresh the page to see it.
            {txHash && (
              <a
                href={`https://sepolia.etherscan.io/tx/${txHash}`}
                target="_blank"
                rel="noreferrer"
                className="block mt-1 underline"
              >
                View on Etherscan ↗
              </a>
            )}
          </div>
        )}

        <button
          onClick={handleRegister}
          disabled={isPending || isConfirming || !address}
          className="btn-primary w-full"
        >
          {isPending     ? "Confirm in MetaMask..." :
           isConfirming  ? "Confirming on-chain..." :
           isSuccess     ? "✓ Registered!"          :
                           "Register Agent"}
        </button>
      </div>
    </div>
  );
}
