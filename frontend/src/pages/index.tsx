"use client";

import { useEffect, useState } from "react";
import Head from "next/head";
import { YieldTable }         from "../components/YieldTable";
import { PositionsTable }     from "../components/PositionsTable";
import { ReflectionSidebar }  from "../components/ReflectionSidebar";
import { DecisionFeed }       from "../components/DecisionFeed";
import type { RankedOpportunity, PortfolioSummary, MockPosition, MacroRegime } from "../types/api";

const API = process.env.NEXT_PUBLIC_AGENT_API_URL ?? "http://localhost:3001";

type Tab       = "yields" | "positions";
type SidePanel = "decisions" | "reflections";

export default function Dashboard() {
  const [tab,       setTab]       = useState<Tab>("yields");
  const [sidePanel, setSidePanel] = useState<SidePanel>("decisions");
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
                <LastDecisionBadge portfolio={portfolio} />
              </div>
            )}

            {/* Regime banner */}
            {portfolio && <RegimeBanner regime={portfolio.regime} />}

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

          {/* ── Right sidebar ── */}
          <div className="hidden lg:flex flex-col w-72 xl:w-80 flex-shrink-0">
            <div className="sticky top-6 flex flex-col rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-4 h-[calc(100vh-7rem)] overflow-hidden">
              {/* Sidebar tab strip */}
              <div className="flex gap-1 mb-3 flex-shrink-0 border-b border-gray-200 dark:border-gray-700 pb-2">
                <button
                  onClick={() => setSidePanel("decisions")}
                  className={`flex-1 text-xs py-1 rounded-t font-medium transition-colors ${
                    sidePanel === "decisions"
                      ? "text-indigo-600 dark:text-indigo-400 border-b-2 border-indigo-600 dark:border-indigo-400"
                      : "text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
                  }`}
                >
                  Decisions
                </button>
                <button
                  onClick={() => setSidePanel("reflections")}
                  className={`flex-1 text-xs py-1 rounded-t font-medium transition-colors ${
                    sidePanel === "reflections"
                      ? "text-indigo-600 dark:text-indigo-400 border-b-2 border-indigo-600 dark:border-indigo-400"
                      : "text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
                  }`}
                >
                  Reflections
                </button>
              </div>
              {sidePanel === "decisions"  && <DecisionFeed      apiUrl={API} />}
              {sidePanel === "reflections" && <ReflectionSidebar apiUrl={API} />}
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

function RegimeBanner({ regime }: { regime: MacroRegime }) {
  if (regime === "neutral") return null;
  const isOff = regime === "risk-off";
  return (
    <div className={`flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium border ${
      isOff
        ? "bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800 text-red-700 dark:text-red-400"
        : "bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800 text-green-700 dark:text-green-400"
    }`}>
      <span>{isOff ? "🔴" : "🟢"}</span>
      <span className="font-bold uppercase">{regime}</span>
      <span className="text-xs font-normal opacity-80">
        {isOff
          ? "Median ETH Δ7d < −5% — stable pools prioritised, sizing halved"
          : "Median ETH Δ7d > +5% — higher IL tolerance, 1.5× Kelly sizing"}
      </span>
    </div>
  );
}

const ACTION_COLORS: Record<string, string> = {
  enter:     "text-green-600 dark:text-green-400",
  exit:      "text-red-500   dark:text-red-400",
  rebalance: "text-blue-600  dark:text-blue-400",
  hold:      "text-gray-500  dark:text-gray-400",
  wait:      "text-amber-500 dark:text-amber-400",
};

function LastDecisionBadge({ portfolio }: { portfolio: PortfolioSummary }) {
  const d   = portfolio.lastDecision;
  const at  = portfolio.lastDecisionAt;
  const pct = d ? Math.round(d.confidence * 100) : null;

  return (
    <div className="rounded-xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 px-4 py-3 col-span-2 sm:col-span-1">
      <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">
        {portfolio.llmEnabled ? "Last Decision" : "Mode"}
      </p>
      {!portfolio.llmEnabled ? (
        <p className="text-lg font-bold text-gray-500">Rules</p>
      ) : !d ? (
        <p className="text-sm text-gray-400 italic">pending…</p>
      ) : (
        <div>
          <div className="flex items-center gap-2">
            <span className={`text-sm font-bold uppercase ${ACTION_COLORS[d.action] ?? ""}`}>
              {d.action}
            </span>
            {pct !== null && (
              <span className={`text-xs font-medium ${pct >= 75 ? "text-green-600 dark:text-green-400" : "text-amber-500"}`}>
                {pct}%
              </span>
            )}
          </div>
          {at && (
            <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">
              {new Date(at).toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit" })}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
