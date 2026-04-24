"use client";

import { useReadContract, useWriteContract } from "wagmi";
import { AGENT_REGISTRY_ABI, MARKETPLACE_ABI, CONTRACT_ADDRESSES } from "../lib/contracts";

interface AgentCardProps { tokenId: number; mode: "buy" | "manage"; }

const STRATEGY_LABELS: Record<number, { name: string; color: string; bg: string }> = {
  0: { name: "Yield Farming",     color: "text-green-400",  bg: "bg-green-400/10 border-green-400/20" },
  1: { name: "Delta Neutral",     color: "text-blue-400",   bg: "bg-blue-400/10 border-blue-400/20" },
  2: { name: "Stablecoin Loop",   color: "text-purple-400", bg: "bg-purple-400/10 border-purple-400/20" },
};

export function AgentCard({ tokenId, mode }: AgentCardProps) {
  const { data: listing } = useReadContract({
    address: CONTRACT_ADDRESSES.marketplace,
    abi: MARKETPLACE_ABI,
    functionName: "listings",
    args: [BigInt(tokenId)],
    query: { enabled: mode === "buy" },
  });

  const { writeContract, isPending } = useWriteContract();
  const strategy = STRATEGY_LABELS[tokenId % 3];
  const isListed = listing?.[3];
  const price = listing ? Number(listing[2]) / 1e18 : null;

  return (
    <div className="glass-card p-5 flex flex-col gap-4 hover:border-white/20 transition-colors group">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-brand-green/10 flex items-center justify-center text-brand-green font-bold text-sm">
            #{tokenId}
          </div>
          <div>
            <div className="font-semibold text-sm">Agent #{tokenId}</div>
            <div className="text-xs text-white/40">iNFT Token #{tokenId}</div>
          </div>
        </div>
        {mode === "buy" && (
          <span className={`tag border ${isListed ? "bg-green-400/10 border-green-400/20 text-green-400" : "bg-white/5 border-white/10 text-white/40"}`}>
            {isListed ? "Listed" : "Not listed"}
          </span>
        )}
        {mode === "manage" && (
          <span className="tag border bg-blue-400/10 border-blue-400/20 text-blue-400">Active</span>
        )}
      </div>

      {/* Strategy badge */}
      <div className="flex gap-2">
        <span className={`tag border ${strategy.bg} ${strategy.color}`}>{strategy.name}</span>
        <span className="tag border bg-white/5 border-white/10 text-white/40">Uniswap V3</span>
      </div>

      {/* Metrics */}
      <div className="grid grid-cols-3 gap-3">
        {[
          { label: "APY",    value: "—" },
          { label: "7d PnL", value: "—" },
          { label: "TVL",    value: "—" },
        ].map(({ label, value }) => (
          <div key={label} className="bg-dark-900 rounded-xl p-3">
            <div className="text-xs text-white/40 mb-1">{label}</div>
            <div className="text-sm font-semibold">{value}</div>
          </div>
        ))}
      </div>

      {/* Price (buy mode) */}
      {mode === "buy" && isListed && price !== null && (
        <div className="flex items-center justify-between bg-dark-900 rounded-xl p-3">
          <span className="text-xs text-white/40">Price</span>
          <span className="font-bold text-brand-green">{price.toFixed(4)} ETH</span>
        </div>
      )}

      {/* Action */}
      {mode === "buy" && isListed && (
        <button
          onClick={() => writeContract({ address: CONTRACT_ADDRESSES.marketplace, abi: MARKETPLACE_ABI, functionName: "buy", args: [BigInt(tokenId)], value: listing![2] })}
          disabled={isPending}
          className="btn-primary w-full text-center"
        >
          {isPending ? "Processing..." : "Buy Agent"}
        </button>
      )}
      {mode === "buy" && !isListed && (
        <div className="text-center text-sm text-white/30 py-1">Not available</div>
      )}
      {mode === "manage" && (
        <div className="flex gap-2">
          <button
            onClick={() => writeContract({ address: CONTRACT_ADDRESSES.agentRegistry, abi: AGENT_REGISTRY_ABI, functionName: "setStatus", args: [BigInt(tokenId), 1] })}
            disabled={isPending}
            className="btn-secondary flex-1 text-sm"
          >
            {isPending ? "Updating..." : "Pause"}
          </button>
          <button className="btn-secondary flex-1 text-sm">Details</button>
        </div>
      )}
    </div>
  );
}
