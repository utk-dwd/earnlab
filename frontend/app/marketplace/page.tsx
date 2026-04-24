"use client";

import { useState } from "react";
import { AgentCard } from "../../components/AgentCard";

const STRATEGY_BADGES = [
  { label: "All", value: "all" },
  { label: "Yield Farming", value: "yield_farming" },
  { label: "Delta Neutral", value: "delta_neutral" },
  { label: "Stablecoin Loop", value: "stablecoin_looping" },
];

export default function MarketplacePage() {
  const [view, setView] = useState<"buy" | "list">("buy");
  const [filter, setFilter] = useState("all");

  return (
    <div>
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-3xl font-bold mb-2">Agent Marketplace</h1>
        <p className="text-white/50">Browse and acquire AI yield-farming agents as iNFTs</p>
      </div>

      {/* Tabs */}
      <div className="flex gap-2 mb-8 border-b border-white/10 pb-4">
        <button
          onClick={() => setView("buy")}
          className={`px-5 py-2.5 rounded-xl text-sm font-medium transition-all ${
            view === "buy" ? "bg-brand-green text-dark-900" : "text-white/60 hover:text-white hover:bg-white/5"
          }`}
        >
          Browse Agents
        </button>
        <button
          onClick={() => setView("list")}
          className={`px-5 py-2.5 rounded-xl text-sm font-medium transition-all ${
            view === "list" ? "bg-brand-green text-dark-900" : "text-white/60 hover:text-white hover:bg-white/5"
          }`}
        >
          List My Agent
        </button>
      </div>

      {view === "buy" && (
        <>
          {/* Strategy filter */}
          <div className="flex gap-2 flex-wrap mb-6">
            {STRATEGY_BADGES.map((b) => (
              <button
                key={b.value}
                onClick={() => setFilter(b.value)}
                className={`tag transition-all ${
                  filter === b.value
                    ? "bg-brand-green/20 text-brand-green border border-brand-green/30"
                    : "bg-white/5 text-white/60 border border-white/10 hover:border-white/20"
                }`}
              >
                {b.label}
              </button>
            ))}
          </div>

          {/* Agent grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {[0, 1, 2].map((id) => (
              <AgentCard key={id} tokenId={id} mode="buy" />
            ))}
          </div>
        </>
      )}

      {view === "list" && (
        <div className="glass-card p-8 max-w-lg">
          <h2 className="text-lg font-semibold mb-2">List an Agent</h2>
          <p className="text-white/50 text-sm mb-6">
            Select an iNFT from your wallet, set a price, and list it on the marketplace.
          </p>
          <div className="space-y-4">
            <div>
              <label className="text-xs text-white/50 uppercase tracking-wider block mb-2">iNFT Token ID</label>
              <input
                type="number"
                placeholder="0"
                className="w-full bg-dark-900 border border-white/10 rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-brand-green/50 transition-colors"
              />
            </div>
            <div>
              <label className="text-xs text-white/50 uppercase tracking-wider block mb-2">Price (ETH)</label>
              <input
                type="number"
                step="0.001"
                placeholder="0.1"
                className="w-full bg-dark-900 border border-white/10 rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-brand-green/50 transition-colors"
              />
            </div>
            <button className="btn-primary w-full">List Agent</button>
          </div>
        </div>
      )}
    </div>
  );
}
