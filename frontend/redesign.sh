#!/usr/bin/env bash
# Run from: /home/chris/projects/ethGlobalAiAgents/earnTest1/frontend
set -e
BASE="$(pwd)"
echo "Redesigning Earnlab frontend at $BASE ..."

# ── tailwind.config.js ────────────────────────────────────────────────────
cat > tailwind.config.js << 'EOF'
/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        brand: {
          green:  "#00ff88",
          blue:   "#3b82f6",
          purple: "#8b5cf6",
        },
        dark: {
          900: "#080a0f",
          800: "#0d1117",
          700: "#161b24",
          600: "#1e2736",
          500: "#2a3447",
        },
      },
      backgroundImage: {
        "hero-gradient": "linear-gradient(135deg, #080a0f 0%, #0d1f3c 50%, #080a0f 100%)",
        "card-gradient": "linear-gradient(135deg, rgba(30,39,54,0.8) 0%, rgba(13,17,23,0.9) 100%)",
        "green-glow":   "radial-gradient(ellipse at center, rgba(0,255,136,0.15) 0%, transparent 70%)",
      },
      boxShadow: {
        "glow-green":  "0 0 20px rgba(0,255,136,0.2)",
        "glow-blue":   "0 0 20px rgba(59,130,246,0.2)",
        "card":        "0 4px 24px rgba(0,0,0,0.4)",
      },
    },
  },
  plugins: [],
};
EOF

# ── postcss.config.js ─────────────────────────────────────────────────────
cat > postcss.config.js << 'EOF'
module.exports = { plugins: { tailwindcss: {}, autoprefixer: {} } };
EOF

# ── app/globals.css ───────────────────────────────────────────────────────
mkdir -p app
cat > app/globals.css << 'EOF'
@tailwind base;
@tailwind components;
@tailwind utilities;

@layer base {
  body {
    @apply bg-dark-900 text-white antialiased;
  }
  * { box-sizing: border-box; }
}

@layer components {
  .glass-card {
    @apply bg-dark-700 border border-white/10 rounded-2xl shadow-card backdrop-blur-sm;
  }
  .btn-primary {
    @apply bg-brand-green text-dark-900 font-semibold px-5 py-2.5 rounded-xl
           hover:opacity-90 transition-all duration-200 shadow-glow-green;
  }
  .btn-secondary {
    @apply border border-white/20 text-white px-5 py-2.5 rounded-xl
           hover:bg-white/5 transition-all duration-200;
  }
  .stat-card {
    @apply glass-card p-5 flex flex-col gap-1;
  }
  .tag {
    @apply text-xs font-medium px-2.5 py-1 rounded-full;
  }
}
EOF

# ── app/layout.tsx ────────────────────────────────────────────────────────
cat > app/layout.tsx << 'EOF'
"use client";

import "./globals.css";
import { WagmiProvider } from "wagmi";
import { RainbowKitProvider } from "@rainbow-me/rainbowkit";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { wagmiConfig } from "../lib/wagmiConfig";
import "@rainbow-me/rainbowkit/styles.css";
import Link from "next/link";
import { usePathname } from "next/navigation";

const queryClient = new QueryClient();

function Nav() {
  const path = usePathname();
  const links = [
    { href: "/", label: "Dashboard" },
    { href: "/marketplace", label: "Marketplace" },
  ];
  return (
    <nav className="sticky top-0 z-50 border-b border-white/10 bg-dark-900/80 backdrop-blur-md">
      <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
        <div className="flex items-center gap-8">
          <Link href="/" className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-brand-green flex items-center justify-center">
              <span className="text-dark-900 font-black text-sm">E</span>
            </div>
            <span className="font-bold text-lg tracking-tight">Earnlab</span>
          </Link>
          <div className="hidden md:flex gap-1">
            {links.map(({ href, label }) => (
              <Link
                key={href}
                href={href}
                className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                  path === href
                    ? "bg-white/10 text-white"
                    : "text-white/60 hover:text-white hover:bg-white/5"
                }`}
              >
                {label}
              </Link>
            ))}
          </div>
        </div>
        <ConnectButton chainStatus="icon" showBalance={true} />
      </div>
    </nav>
  );
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-dark-900">
        <WagmiProvider config={wagmiConfig}>
          <QueryClientProvider client={queryClient}>
            <RainbowKitProvider>
              <Nav />
              <main className="max-w-7xl mx-auto px-6 py-10">{children}</main>
            </RainbowKitProvider>
          </QueryClientProvider>
        </WagmiProvider>
      </body>
    </html>
  );
}
EOF

# ── app/page.tsx ──────────────────────────────────────────────────────────
cat > app/page.tsx << 'EOF'
"use client";

import { useAccount } from "wagmi";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { YieldDashboard } from "../components/YieldDashboard";

export default function HomePage() {
  const { isConnected } = useAccount();

  return (
    <div>
      {/* Hero */}
      <div className="relative mb-12">
        <div className="absolute inset-0 bg-green-glow pointer-events-none" />
        <div className="relative">
          <div className="inline-flex items-center gap-2 bg-brand-green/10 border border-brand-green/20 text-brand-green text-xs font-medium px-3 py-1.5 rounded-full mb-4">
            <span className="w-1.5 h-1.5 bg-brand-green rounded-full animate-pulse" />
            Live on Sepolia Testnet
          </div>
          <h1 className="text-4xl md:text-5xl font-bold mb-3 leading-tight">
            Autonomous DeFi<br />
            <span className="text-brand-green">Yield Optimization</span>
          </h1>
          <p className="text-white/50 text-lg max-w-xl">
            AI agents monitor positions, backtest strategies, and move funds across protocols — without you touching anything.
          </p>
        </div>
      </div>

      {isConnected ? (
        <YieldDashboard />
      ) : (
        <div className="glass-card p-12 text-center max-w-lg mx-auto mt-16">
          <div className="w-16 h-16 bg-brand-green/10 rounded-2xl flex items-center justify-center mx-auto mb-5">
            <svg className="w-8 h-8 text-brand-green" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
          </div>
          <h2 className="text-xl font-bold mb-2">Connect your wallet</h2>
          <p className="text-white/50 text-sm mb-6">View and manage your yield-optimizing agents on Sepolia</p>
          <ConnectButton />
        </div>
      )}
    </div>
  );
}
EOF

# ── app/marketplace/page.tsx ──────────────────────────────────────────────
cat > app/marketplace/page.tsx << 'EOF'
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
EOF

# ── app/dashboard/page.tsx ────────────────────────────────────────────────
cat > app/dashboard/page.tsx << 'EOF'
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
EOF

# ── components/YieldDashboard.tsx ─────────────────────────────────────────
cat > components/YieldDashboard.tsx << 'EOF'
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
EOF

# ── components/AgentCard.tsx ──────────────────────────────────────────────
cat > components/AgentCard.tsx << 'EOF'
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
EOF

echo ""
echo "✓ Redesign complete!"
echo ""
echo "Now install missing deps and restart dev server:"
echo "  npm install && npm run dev"
