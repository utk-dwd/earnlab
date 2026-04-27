"use client";

import { useEffect, useState } from "react";
import Head from "next/head";
import { YieldTable }         from "../components/YieldTable";
import { PositionsTable }     from "../components/PositionsTable";
import { ReflectionSidebar }  from "../components/ReflectionSidebar";
import type { RankedOpportunity, PortfolioSummary, MockPosition } from "../types/api";

const API = process.env.NEXT_PUBLIC_AGENT_API_URL ?? "http://localhost:3001";

type Tab = "yields" | "positions";

export default function Dashboard() {
  const [tab,       setTab]       = useState<Tab>("yields");
  const [yields,    setYields]    = useState<RankedOpportunity[]>([]);
  const [positions, setPositions] = useState<MockPosition[]>([]);
  const [portfolio, setPortfolio] = useState<PortfolioSummary | null>(null);
  const [loading,   setLoading]   = useState(true);
  const [lastScan,  setLastScan]  = useState<string>("");
  const [error,     setError]     = useState<string>("");

  async function fetchData() {
    setLoading(true);
    setError("");
    try {
      const [yRes, pRes, posRes] = await Promise.all([
        fetch(`${API}/yields?limit=100`),
        fetch(`${API}/portfolio`),
        fetch(`${API}/portfolio/positions`),
      ]);

      if (!yRes.ok) throw new Error(`Agent API returned ${yRes.status}`);
      setYields((await yRes.json()).data ?? []);

      if (pRes.ok)   setPortfolio(await pRes.json());
      if (posRes.ok) setPositions((await posRes.json()).data ?? []);

      setLastScan(new Date().toLocaleTimeString());
    } catch (e: any) {
      setError(e.message ?? "Failed to reach agent API");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchData();
    const id = setInterval(fetchData, 30_000);
    return () => clearInterval(id);
  }, []);

  return (
    <>
      <Head>
        <title>EarnYld — Yield Hunter</title>
      </Head>
      <div className="min-h-screen bg-gray-50 dark:bg-gray-950 text-gray-900 dark:text-gray-100 flex flex-col">

        {/* ── Header ── */}
        <header className="border-b border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 flex-shrink-0">
          <div className="max-w-screen-2xl mx-auto px-4 py-4 flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-bold tracking-tight">🌾 EarnYld</h1>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                Uniswap v4 · 18 chains · AI-driven portfolio
              </p>
            </div>
            <div className="flex items-center gap-4 text-sm">
              {lastScan && <span className="text-gray-400">Updated {lastScan}</span>}
              <button
                onClick={fetchData} disabled={loading}
                className="px-3 py-1.5 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50 transition-colors"
              >
                {loading ? "Scanning…" : "Refresh"}
              </button>
              <a href="/docs"
                className="px-3 py-1.5 rounded-lg border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors">
                API Docs
              </a>
            </div>
          </div>
        </header>

        {/* ── Body: main + sidebar ── */}
        <div className="flex-1 flex max-w-screen-2xl mx-auto w-full px-4 py-6 gap-6 min-h-0">

          {/* ── Main column ── */}
          <div className="flex-1 min-w-0 flex flex-col gap-5">

            {/* Error */}
            {error && (
              <div className="rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 px-4 py-3 text-sm text-red-700 dark:text-red-400">
                ⚠ {error} — is the agent running on port 3001?
              </div>
            )}

            {/* Stats bar */}
            {portfolio && (
              <div className="grid grid-cols-2 sm:grid-cols-6 gap-3">
                <StatCard label="Pools Found"    value={yields.length.toString()} />
                <StatCard label="Open Positions" value={portfolio.openPositions.toString()} />
                <StatCard label="Total Trades"   value={portfolio.tradeCount.toString()} />
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

            {/* Tabs */}
            <div className="border-b border-gray-200 dark:border-gray-700">
              <nav className="-mb-px flex gap-6">
                <TabButton active={tab === "yields"} onClick={() => setTab("yields")}>
                  Yield Opportunities
                  {yields.length > 0 && (
                    <span className="ml-2 text-xs bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-400 rounded-full px-2 py-0.5">
                      {yields.length}
                    </span>
                  )}
                </TabButton>
                <TabButton active={tab === "positions"} onClick={() => setTab("positions")}>
                  Positions
                  {positions.length > 0 && (
                    <span className={`ml-2 text-xs rounded-full px-2 py-0.5 ${
                      positions.some(p => p.status === "open")
                        ? "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-400"
                        : "bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-400"
                    }`}>
                      {positions.filter(p => p.status === "open").length} open
                    </span>
                  )}
                </TabButton>
              </nav>
            </div>

            {/* Tab content */}
            <div className="flex-1">
              {tab === "yields" && (
                <YieldTable opportunities={yields} isLoading={loading} />
              )}
              {tab === "positions" && (
                <PositionsTable positions={positions} summary={portfolio} isLoading={loading} />
              )}
            </div>
          </div>

          {/* ── Reflection sidebar ── */}
          <div className="hidden lg:flex flex-col w-72 xl:w-80 flex-shrink-0">
            <div className="sticky top-6 flex flex-col rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-4 h-[calc(100vh-7rem)] overflow-hidden">
              <ReflectionSidebar apiUrl={API} />
            </div>
          </div>

        </div>
      </div>
    </>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function TabButton({ active, onClick, children }: {
  active: boolean; onClick: () => void; children: React.ReactNode;
}) {
  return (
    <button onClick={onClick}
      className={`flex items-center pb-3 text-sm font-medium border-b-2 transition-colors ${
        active
          ? "border-indigo-600 text-indigo-600 dark:text-indigo-400 dark:border-indigo-400"
          : "border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:border-gray-300"
      }`}>
      {children}
    </button>
  );
}

function StatCard({ label, value, positive }: { label: string; value: string; positive?: boolean }) {
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
