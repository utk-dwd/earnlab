"use client";

import { useAccount, useReadContract } from "wagmi";
import { AGENT_REGISTRY_ABI, CONTRACT_ADDRESSES } from "../../lib/contracts";
import { AgentCard } from "../../components/AgentCard";
import Link from "next/link";

export default function DashboardPage() {
  const { address } = useAccount();
  const { data: agentIds } = useReadContract({
    address: CONTRACT_ADDRESSES.agentRegistry,
    abi: AGENT_REGISTRY_ABI,
    functionName: "getOwnerAgents",
    args: address ? [address] : undefined,
    query: { enabled: !!address },
  });

  return (
    <div>
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold mb-1">My Agents</h1>
          <p className="text-white/50">Manage your deployed yield-farming agents</p>
        </div>
        <Link href="/marketplace" className="btn-primary">+ Get an Agent</Link>
      </div>

      {!address && (
        <div className="glass-card p-8 text-center text-white/50">Connect your wallet to view agents.</div>
      )}

      {address && agentIds?.length === 0 && (
        <div className="glass-card p-12 text-center">
          <p className="text-white/50 mb-4">No agents registered yet.</p>
          <Link href="/marketplace" className="btn-primary">Browse Marketplace</Link>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {agentIds?.map((id) => (
          <AgentCard key={id.toString()} tokenId={Number(id)} mode="manage" />
        ))}
      </div>
    </div>
  );
}
