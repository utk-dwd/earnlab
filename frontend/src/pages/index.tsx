"use client";

import { useEffect, useState } from "react";
import Head from "next/head";
import { YieldTable } from "../components/YieldTable";
import type { RankedOpportunity, PortfolioSummary } from "../types/api";

const API = process.env.NEXT_PUBLIC_AGENT_API_URL ?? "http://localhost:3001";

export default function Dashboard() {
  const [yields,    setYields]    = useState<RankedOpportunity[]>([]);
  const [portfolio, setPortfolio] = useState<PortfolioSummary | null>(null);
  const [loading,   setLoading]   = useState(true);
  const [lastScan,  setLastScan]  = useState<string>("");
  const [error,     setError]     = useState<string>("");

  async function fetchData() {
    setLoading(true);
    setError("");
    try {
      const [yRes, pRes] = await Promise.all([
        fetch(`${API}/yields?limit=100`),
        fetch(`${API}/portfolio`),
      ]);

      if (!yRes.ok) throw new Error(`Agent API returned ${yRes.status}`);
      const yData = await yRes.json();
      setYields(yData.data ?? []);

      // Portfolio endpoint may not be available if agent hasn't restarted yet
      if (pRes.ok) {
        const pData = await pRes.json();
        setPortfolio(pData);
      }

      setLastScan(new Date().toLocaleTimeString());
    } catch (e: any) {
      setError(e.message ?? "Failed to reach agent API");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchData();
    const id = setInterval(fetchData, 30_000); // refresh every 30s
    return () => clearInterval(id);
  }, []);

  return (
    <>
      <Head>
        <title>EarnYld — Yield Hunter</title>
      </Head>
      <div className="min-h-screen bg-gray-50 dark:bg-gray-950 text-gray-900 dark:text-gray-100">

        {/* ── Header ── */}
        <header className="border-b border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900">
          <div className="max-w-7xl mx-auto px-4 py-4 flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-bold tracking-tight">
                🌾 EarnYld
              </h1>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                Uniswap v4 Yield Hunter · 18 chains · mainnet + testnet
              </p>
            </div>
            <div className="flex items-center gap-4 text-sm">
              {lastScan && (
                <span className="text-gray-400">Updated {lastScan}</span>
              )}
              <button
                onClick={fetchData}
                disabled={loading}
                className="px-3 py-1.5 rounded-lg bg-indigo-600 text-white text-sm hover:bg-indigo-700 disabled:opacity-50 transition-colors"
              >
                {loading ? "Scanning…" : "Refresh"}
              </button>
              <a
                href="/docs"
                className="px-3 py-1.5 rounded-lg border border-gray-300 dark:border-gray-600 text-sm hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
              >
                API Docs
              </a>
            </div>
          </div>
        </header>

        <main className="max-w-7xl mx-auto px-4 py-6 space-y-6">

          {/* ── Error banner ── */}
          {error && (
            <div className="rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 px-4 py-3 text-sm text-red-700 dark:text-red-400">
              ⚠ {error} — is the agent running on port 3001?
            </div>
          )}

          {/* ── Stats bar ── */}
          {portfolio && (
            <div className="grid grid-cols-2 sm:grid-cols-6 gap-3">
              <StatCard label="Pools Found"      value={yields.length.toString()} />
              <StatCard label="Open Positions"   value={portfolio.openPositions.toString()} />
              <StatCard label="Total Trades"     value={portfolio.tradeCount.toString()} />
              <StatCard
                label="Fees Earned"
                value={`$${portfolio.totalEarnedFeesUsd.toLocaleString("en", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
                positive={portfolio.totalEarnedFeesUsd > 0}
              />
              <StatCard
                label="Unrealised PnL"
                value={`$${portfolio.unrealizedPnlUsd.toLocaleString("en", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
                positive={portfolio.unrealizedPnlUsd >= 0}
              />
              <StatCard
                label="AI Mode"
                value={portfolio.llmEnabled ? "LLM ✓" : "Rules"}
                positive={portfolio.llmEnabled}
              />
            </div>
          )}

          {/* ── Yield table ── */}
          <section>
            <h2 className="text-lg font-semibold mb-3">Yield Opportunities</h2>
            <YieldTable opportunities={yields} isLoading={loading} />
          </section>

        </main>
      </div>
    </>
  );
}

function StatCard({
  label, value, positive,
}: { label: string; value: string; positive?: boolean }) {
  return (
    <div className="rounded-xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 px-4 py-3">
      <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">{label}</p>
      <p className={`text-lg font-bold tabular-nums ${
        positive === undefined ? "" : positive ? "text-green-600" : "text-red-500"
      }`}>
        {value}
      </p>
    </div>
  );
}
