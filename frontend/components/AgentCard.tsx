"use client";

import { useReadContract, useWriteContract } from "wagmi";
import { INFT_ABI, AGENT_REGISTRY_ABI, MARKETPLACE_ABI, CONTRACT_ADDRESSES } from "../lib/contracts";
import { formatDistanceToNow } from "date-fns";

interface AgentCardProps { tokenId: number; mode: "buy" | "manage"; }

const STRATEGY_LABELS: Record<number, { name: string; color: string; bg: string }> = {
  0: { name: "Yield Farming",   color: "text-green-400",  bg: "bg-green-400/10 border-green-400/20"  },
  1: { name: "Delta Neutral",   color: "text-blue-400",   bg: "bg-blue-400/10 border-blue-400/20"    },
  2: { name: "Stablecoin Loop", color: "text-purple-400", bg: "bg-purple-400/10 border-purple-400/20"},
};

const STATUS = ["Inactive", "Active", "Paused"];
const STATUS_COLOR = ["text-white/30", "text-green-400", "text-yellow-400"];

export function AgentCard({ tokenId, mode }: AgentCardProps) {
  // Live on-chain data
  const { data: owner } = useReadContract({
    address: CONTRACT_ADDRESSES.inft,
    abi: INFT_ABI,
    functionName: "ownerOf",
    args: [BigInt(tokenId)],
  });

  const { data: meta } = useReadContract({
    address: CONTRACT_ADDRESSES.inft,
    abi: INFT_ABI,
    functionName: "getAgentMetadata",
    args: [BigInt(tokenId)],
  });

  const { data: listing } = useReadContract({
    address: CONTRACT_ADDRESSES.marketplace,
    abi: MARKETPLACE_ABI,
    functionName: "listings",
    args: [BigInt(tokenId)],
    query: { enabled: mode === "buy" },
  });

  const { writeContract, isPending } = useWriteContract();

  const strategy   = STRATEGY_LABELS[tokenId % 3];
  const isListed   = listing?.[3];
  const price      = listing ? Number(listing[2]) / 1e18 : null;
  const lastUpdate = meta?.lastUpdated
    ? formatDistanceToNow(new Date(Number(meta.lastUpdated) * 1000), { addSuffix: true })
    : null;

  return (
    <div className="glass-card p-5 flex flex-col gap-4 hover:border-white/20 transition-all duration-200 group">

      {/* Header */}
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-brand-green/10 border border-brand-green/20 flex items-center justify-center text-brand-green font-bold text-sm">
            #{tokenId}
          </div>
          <div>
            <div className="font-semibold text-sm">Agent #{tokenId}</div>
            <div className="text-xs text-white/40 font-mono">
              {owner ? `${owner.slice(0, 6)}...${owner.slice(-4)}` : "—"}
            </div>
          </div>
        </div>
        {mode === "buy" && (
          <span className={`tag border ${isListed ? "bg-green-400/10 border-green-400/20 text-green-400" : "bg-white/5 border-white/10 text-white/30"}`}>
            {isListed ? "For sale" : "Not listed"}
          </span>
        )}
        {mode === "manage" && (
          <span className="tag border bg-green-400/10 border-green-400/20 text-green-400">Active</span>
        )}
      </div>

      {/* Strategy + network badges */}
      <div className="flex gap-2 flex-wrap">
        <span className={`tag border ${strategy.bg} ${strategy.color}`}>{strategy.name}</span>
        <span className="tag border bg-pink-400/10 border-pink-400/20 text-pink-400">Uniswap V3</span>
        <span className="tag border bg-blue-400/10 border-blue-400/20 text-blue-400">0G iNFT</span>
      </div>

      {/* On-chain metadata */}
      {meta && (
        <div className="bg-dark-900 rounded-xl p-3 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs text-white/40">Metadata Hash</span>
            <span className="text-xs font-mono text-white/60">
              {meta.metadataHash.slice(0, 10)}...
            </span>
          </div>
          {meta.encryptedURI && meta.encryptedURI !== "0g://placeholder-encrypted-uri" && (
            <div className="flex items-center justify-between">
              <span className="text-xs text-white/40">0G URI</span>
              <span className="text-xs font-mono text-brand-green truncate max-w-32">
                {meta.encryptedURI}
              </span>
            </div>
          )}
          {lastUpdate && (
            <div className="flex items-center justify-between">
              <span className="text-xs text-white/40">Last updated</span>
              <span className="text-xs text-white/50">{lastUpdate}</span>
            </div>
          )}
        </div>
      )}

      {/* Metrics row */}
      <div className="grid grid-cols-3 gap-2">
        {[
          { label: "APY",    value: "—" },
          { label: "7d PnL", value: "—" },
          { label: "TVL",    value: "—" },
        ].map(({ label, value }) => (
          <div key={label} className="bg-dark-900 rounded-xl p-2.5 text-center">
            <div className="text-xs text-white/30 mb-0.5">{label}</div>
            <div className="text-sm font-semibold">{value}</div>
          </div>
        ))}
      </div>

      {/* Price (buy mode) */}
      {mode === "buy" && isListed && price !== null && (
        <div className="flex items-center justify-between bg-dark-900 rounded-xl px-4 py-3">
          <span className="text-xs text-white/40">Price</span>
          <span className="font-bold text-brand-green text-lg">{price.toFixed(4)} ETH</span>
        </div>
      )}

      {/* Actions */}
      {mode === "buy" && isListed && (
        <button
          onClick={() => writeContract({
            address: CONTRACT_ADDRESSES.marketplace,
            abi: MARKETPLACE_ABI,
            functionName: "buy",
            args: [BigInt(tokenId)],
            value: listing![2],
          })}
          disabled={isPending}
          className="btn-primary w-full"
        >
          {isPending ? "Confirming..." : "Buy Agent"}
        </button>
      )}
      {mode === "buy" && !isListed && (
        <div className="text-center text-sm text-white/20 py-1">Not available</div>
      )}
      {mode === "manage" && (
        <div className="flex gap-2">
          <button
            onClick={() => writeContract({
              address: CONTRACT_ADDRESSES.agentRegistry,
              abi: AGENT_REGISTRY_ABI,
              functionName: "setStatus",
              args: [BigInt(tokenId), 2], // Paused
            })}
            disabled={isPending}
            className="btn-secondary flex-1 text-sm"
          >
            Pause
          </button>
          <a
            href={`https://sepolia.etherscan.io/token/${CONTRACT_ADDRESSES.inft}?a=${tokenId}`}
            target="_blank"
            rel="noreferrer"
            className="btn-secondary flex-1 text-sm text-center"
          >
            Etherscan ↗
          </a>
        </div>
      )}
    </div>
  );
}
