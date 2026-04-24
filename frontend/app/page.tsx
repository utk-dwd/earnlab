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
