"use client";

import { useAccount, useReadContract } from "wagmi";
import { AGENT_REGISTRY_ABI, CONTRACT_ADDRESSES } from "../lib/contracts";
import Link from "next/link";

const STATS = [
  { label: "Active Agents",   valueKey: "agents",  suffix: "",   color: "text-brand-green" },
  { label: "Total Yield 30d", valueKey: "yield",   suffix: " ETH", color: "text-blue-400" },
  { label: "Est. APY",        valueKey: "apy",     suffix: "%",  color: "text-purple-400" },
  { label: "Protocols",       valueKey: "protocols", suffix: "",  color: "text-orange-400" },
];

export function YieldDashboard() {
  const { address } = useAccount();
  const { data: agentIds, isLoading } = useReadContract({
    address: CONTRACT_ADDRESSES.agentRegistry,
    abi: AGENT_REGISTRY_ABI,
    functionName: "getOwnerAgents",
    args: address ? [address] : undefined,
    query: { enabled: !!address },
  });

  const count = agentIds?.length ?? 0;

  const statValues: Record<string, string> = {
    agents: isLoading ? "..." : count.toString(),
    yield: "—",
    apy: "—",
    protocols: "3",
  };

  return (
    <div>
      {/* Stat cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        {STATS.map(({ label, valueKey, suffix, color }) => (
          <div key={label} className="stat-card">
            <span className="text-xs text-white/40 uppercase tracking-wider">{label}</span>
            <span className={`text-2xl font-bold ${color}`}>
              {statValues[valueKey]}{statValues[valueKey] !== "—" && statValues[valueKey] !== "..." ? suffix : ""}
            </span>
          </div>
        ))}
      </div>

      {/* Integration badges */}
      <div className="flex gap-3 mb-8 flex-wrap">
        {[
          { name: "Uniswap V3",  color: "text-pink-400",   bg: "bg-pink-400/10 border-pink-400/20" },
          { name: "0G Network",  color: "text-blue-400",   bg: "bg-blue-400/10 border-blue-400/20" },
          { name: "KeeperHub",   color: "text-green-400",  bg: "bg-green-400/10 border-green-400/20" },
        ].map(({ name, color, bg }) => (
          <span key={name} className={`tag border ${bg} ${color}`}>{name}</span>
        ))}
      </div>

      {/* Empty / agent list */}
      {count === 0 ? (
        <div className="glass-card p-12 text-center border-dashed">
          <div className="w-14 h-14 bg-white/5 rounded-2xl flex items-center justify-center mx-auto mb-4">
            <svg className="w-7 h-7 text-white/30" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
            </svg>
          </div>
          <h3 className="font-semibold mb-1">No agents deployed yet</h3>
          <p className="text-white/40 text-sm mb-5">Purchase an agent from the marketplace to start earning</p>
          <Link href="/marketplace" className="btn-primary">Browse Marketplace →</Link>
        </div>
      ) : (
        <p className="text-white/50 text-sm">
          {count} agent{count > 1 ? "s" : ""} active.{" "}
          <Link href="/dashboard" className="text-brand-green hover:underline">Manage all →</Link>
        </p>
      )}
    </div>
  );
}
