"use client";

import { useEffect, useRef, useState } from "react";
import Head from "next/head";
import { YieldTable }           from "../components/YieldTable";
import { PositionsTable }       from "../components/PositionsTable";
import { ReflectionSidebar }    from "../components/ReflectionSidebar";
import { DecisionFeed }         from "../components/DecisionFeed";
import { PendingActionsPanel }  from "../components/PendingActionsPanel";
import { WalletButton }         from "../components/WalletButton";
import { TransferModal }        from "../components/TransferModal";
import { AppWalletBalances }    from "../components/AppWalletBalances";
import { LLMSelector }         from "../components/LLMSelector";
import type {
  RankedOpportunity, PortfolioSummary, MockPosition,
  MacroRegime, RiskBudgetState, PendingAction,
} from "../types/api";

const API = process.env.NEXT_PUBLIC_AGENT_API_URL ?? "http://localhost:3001";

type Tab       = "yields" | "positions";
type SidePanel = "decisions" | "reflections";

function playPendingActionAlert() {
  try {
    const AudioCtx = window.AudioContext ?? (window as any).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();

    const tone = (freq: number, start: number, dur: number) => {
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = "sine";
      osc.frequency.setValueAtTime(freq, start);
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.25, start + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.001, start + dur);
      osc.start(start);
      osc.stop(start + dur);
    };

    const t = ctx.currentTime;
    tone(660,  t,        0.12);   // E5  — first note
    tone(880,  t + 0.13, 0.12);   // A5  — second note (ascending)
    tone(1320, t + 0.26, 0.22);   // E6  — resolve up
  } catch {
    // AudioContext blocked (e.g. no user gesture yet) — silently ignore
  }
}

export default function Dashboard() {
  const [tab,            setTab]           = useState<Tab>("yields");
  const [sidePanel,      setSidePanel]     = useState<SidePanel>("decisions");
  const [yields,         setYields]        = useState<RankedOpportunity[]>([]);
  const [positions,      setPositions]     = useState<MockPosition[]>([]);
  const [portfolio,      setPortfolio]     = useState<PortfolioSummary | null>(null);
  const [loading,        setLoading]       = useState(true);
  const [lastScan,       setLastScan]      = useState<string>("");
  const [error,          setError]         = useState<string>("");
  const [autonomousMode, setAutonomousMode] = useState<boolean>(true);
  const [pendingActions, setPendingActions] = useState<PendingAction[]>([]);
  const [showTransfer,   setShowTransfer]   = useState(false);
  const [showLLM,        setShowLLM]        = useState(false);
  const prevPendingCount = useRef(0);

  async function fetchData() {
    setLoading(true);
    setError("");
    try {
      const [yRes, pRes, posRes, settingsRes, pendingRes] = await Promise.all([
        fetch(`${API}/yields?limit=100`),
        fetch(`${API}/portfolio`),
        fetch(`${API}/portfolio/positions`),
        fetch(`${API}/settings`),
        fetch(`${API}/pending-actions`),
      ]);
      if (!yRes.ok) throw new Error(`Agent API returned ${yRes.status}`);
      setYields((await yRes.json()).data ?? []);
      if (pRes.ok)       setPortfolio(await pRes.json());
      if (posRes.ok)     setPositions((await posRes.json()).data ?? []);
      if (settingsRes.ok) {
        const s = await settingsRes.json();
        setAutonomousMode(s.autonomousMode ?? true);
      }
      if (pendingRes.ok) setPendingActions((await pendingRes.json()).data ?? []);
      setLastScan(new Date().toLocaleTimeString());
    } catch (e: any) {
      setError(e.message ?? "Failed to reach agent API");
    } finally {
      setLoading(false);
    }
  }

  async function fetchPendingActions() {
    try {
      const res = await fetch(`${API}/pending-actions`);
      if (res.ok) setPendingActions((await res.json()).data ?? []);
    } catch {}
  }

  async function toggleMode() {
    const next = !autonomousMode;
    setAutonomousMode(next);           // optimistic — UI responds immediately
    try {
      const res = await fetch(`${API}/settings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ autonomousMode: next }),
      });
      // Only revert if the server explicitly rejects the value (400).
      // 404 means the backend hasn't restarted yet — keep local state.
      if (res.status === 400) setAutonomousMode(!next);
    } catch {
      // Network error — keep local state, will sync on next backend restart.
    }
  }

  useEffect(() => {
    fetchData();
    const id = setInterval(fetchData, 30_000);
    return () => clearInterval(id);
  }, []);

  // Play a chime whenever new pending actions arrive
  useEffect(() => {
    const count = pendingActions.filter(a => a.status === "pending" && a.action !== "hold" && a.action !== "wait").length;
    if (count > prevPendingCount.current) {
      playPendingActionAlert();
    }
    prevPendingCount.current = count;
  }, [pendingActions]);

  return (
    <>
      <Head>
        <title>EarnYld - Risk Adjusted Yield Hunter</title>
        <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
        <link rel="shortcut icon" href="/favicon.svg" />
        <meta name="description" content="EarnYld — AI-driven risk-adjusted yield hunting across Uniswap v4 on 18 chains" />
      </Head>
      <div className="min-h-screen bg-gray-50 dark:bg-gray-950 text-gray-900 dark:text-gray-100 flex flex-col">

        {/* Modals — rendered at root so they overlay everything */}
        {showTransfer && <TransferModal onClose={() => setShowTransfer(false)} />}
        {showLLM      && <LLMSelector  onClose={() => setShowLLM(false)} />}

        {/* ── Header ── */}
        <header className="border-b border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 flex-shrink-0">
          <div className="w-full px-4 py-4 flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-bold tracking-tight">🌾 EarnYld</h1>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                Uniswap v4 · 18 chains · AI-driven portfolio
              </p>
            </div>
            <div className="flex items-center gap-4 text-sm flex-wrap justify-end">
              {lastScan && <span className="text-gray-400 hidden sm:inline">Updated {lastScan}</span>}

              {/* Autonomous / HITL toggle */}
              <div className="flex items-center gap-2 bg-gray-100 dark:bg-gray-800 rounded-lg p-1">
                <button
                  onClick={() => { if (!autonomousMode) toggleMode(); }}
                  className={`px-3 py-1 rounded-md text-xs font-semibold transition-colors ${
                    autonomousMode
                      ? "bg-white dark:bg-gray-700 text-indigo-700 dark:text-indigo-300 shadow-sm"
                      : "text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
                  }`}
                >
                  Autonomous
                </button>
                <button
                  onClick={() => { if (autonomousMode) toggleMode(); }}
                  className={`px-3 py-1 rounded-md text-xs font-semibold transition-colors ${
                    !autonomousMode
                      ? "bg-white dark:bg-gray-700 text-amber-700 dark:text-amber-300 shadow-sm"
                      : "text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
                  }`}
                >
                  Human-in-Loop
                  {pendingActions.filter(a => a.status === "pending" && a.action !== "hold" && a.action !== "wait").length > 0 && (
                    <span className="ml-1.5 bg-amber-500 text-white text-xs rounded-full px-1.5 py-0.5 font-bold">
                      {pendingActions.filter(a => a.status === "pending" && a.action !== "hold" && a.action !== "wait").length}
                    </span>
                  )}
                </button>
              </div>

              <button onClick={fetchData} disabled={loading}
                className="px-3 py-1.5 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50 transition-colors">
                {loading ? "Scanning…" : "Refresh"}
              </button>
              <a href="/docs"
                className="px-3 py-1.5 rounded-lg border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors">
                API Docs
              </a>

              <button
                onClick={() => setShowLLM(true)}
                className="px-3 py-1.5 rounded-lg border border-purple-400 dark:border-purple-500 text-purple-700 dark:text-purple-300 text-sm font-semibold hover:bg-purple-50 dark:hover:bg-purple-900/30 transition-colors"
              >
                🤖 Choose LLM
              </button>
              <button
                onClick={() => setShowTransfer(true)}
                className="px-3 py-1.5 rounded-lg border border-indigo-400 dark:border-indigo-500 text-indigo-700 dark:text-indigo-300 text-sm font-semibold hover:bg-indigo-50 dark:hover:bg-indigo-900/30 transition-colors"
              >
                💸 Transfer
              </button>

              <WalletButton />
            </div>
          </div>
        </header>

        {/* ── Body: main + sidebar ── */}
        <div className="flex-1 flex w-full px-4 py-6 gap-6 min-h-0">

          {/* ── Main column ── */}
          <div className="flex-1 min-w-0 flex flex-col gap-5">

            {error && (
              <div className="rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 px-4 py-3 text-sm text-red-700 dark:text-red-400">
                ⚠ {error} — is the agent running on port 3001?
              </div>
            )}

            {/* App wallet balances */}
            <AppWalletBalances />

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

            {/* Risk budget */}
            {portfolio?.riskBudget && <RiskBudgetPanel budget={portfolio.riskBudget} />}

            {/* Regime banner */}
            {portfolio && <RegimeBanner regime={portfolio.regime} />}

            {/* Pending actions panel (HITL mode only) */}
            {!autonomousMode && (
              <PendingActionsPanel
                actions={pendingActions}
                apiUrl={API}
                onUpdate={fetchPendingActions}
              />
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

          {/* ── Right sidebar ── */}
          <div className="hidden lg:flex flex-col w-72 xl:w-80 flex-shrink-0">
            <div className="sticky top-6 flex flex-col rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-4 h-[calc(100vh-7rem)] overflow-hidden">
              <div className="flex gap-1 mb-3 flex-shrink-0 border-b border-gray-200 dark:border-gray-700 pb-2">
                <button onClick={() => setSidePanel("decisions")}
                  className={`flex-1 text-xs py-1 rounded-t font-medium transition-colors ${
                    sidePanel === "decisions"
                      ? "text-indigo-600 dark:text-indigo-400 border-b-2 border-indigo-600 dark:border-indigo-400"
                      : "text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
                  }`}>
                  Decisions
                </button>
                <button onClick={() => setSidePanel("reflections")}
                  className={`flex-1 text-xs py-1 rounded-t font-medium transition-colors ${
                    sidePanel === "reflections"
                      ? "text-indigo-600 dark:text-indigo-400 border-b-2 border-indigo-600 dark:border-indigo-400"
                      : "text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
                  }`}>
                  Reflections
                </button>
              </div>
              {sidePanel === "decisions"   && <DecisionFeed      apiUrl={API} />}
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
          ? "Median ETH Δ7d < −5% — stable pools prioritised, sizing halved"
          : "Median ETH Δ7d > +5% — higher IL tolerance, 1.5× Kelly sizing"}
      </span>
    </div>
  );
}

function RiskBudgetPanel({ budget }: { budget: RiskBudgetState }) {
  const hasViolations = budget.violations.length > 0 || !budget.cashOk;
  return (
    <div className={`rounded-xl border px-4 py-3 ${
      hasViolations
        ? "border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-900/10"
        : "border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900"
    }`}>
      <div className="flex items-center gap-2 mb-2">
        <span className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">
          Risk Budget
        </span>
        {hasViolations && (
          <span className="text-xs font-medium text-red-600 dark:text-red-400">
            ⚠ {budget.violations.length} violation{budget.violations.length !== 1 ? "s" : ""}
          </span>
        )}
        {!hasViolations && budget.canOpenNew && (
          <span className="text-xs text-emerald-600 dark:text-emerald-400">All clear — new entry allowed</span>
        )}
      </div>
      <div className="grid grid-cols-3 sm:grid-cols-6 gap-3">
        {budget.dimensions.map(dim => (
          <BudgetGauge key={dim.id}
            label={dim.label} usedPct={dim.usedPct} limitPct={dim.limitPct}
            ok={dim.ok} topItem={dim.topItem} />
        ))}
        <BudgetGaugeInverted
          label="Cash Buffer" valuePct={budget.cashBufferPct} minPct={10} ok={budget.cashOk} />
      </div>
    </div>
  );
}

function BudgetGauge({ label, usedPct, limitPct, ok, topItem }: {
  label: string; usedPct: number; limitPct: number; ok: boolean; topItem?: string;
}) {
  const fillPct  = Math.min(usedPct / limitPct * 100, 100);
  const barColor = !ok ? "bg-red-500" : fillPct > 80 ? "bg-yellow-400" : "bg-emerald-500";
  const textColor = !ok ? "text-red-600 dark:text-red-400" : "text-gray-700 dark:text-gray-200";
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <span className="text-xs text-gray-500 dark:text-gray-400 truncate">{label}</span>
        <span className={`text-xs font-mono font-semibold tabular-nums ${textColor}`}>
          {usedPct.toFixed(0)}%{!ok && <span className="ml-0.5">✗</span>}
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-gray-200 dark:bg-gray-700 overflow-hidden">
        <div className={`h-full rounded-full transition-all ${barColor}`} style={{ width: `${fillPct}%` }} />
      </div>
      <div className="flex items-center justify-between">
        <span className="text-xs text-gray-400 truncate" title={topItem}>{topItem ?? "—"}</span>
        <span className="text-xs text-gray-400">/{limitPct}%</span>
      </div>
    </div>
  );
}

function BudgetGaugeInverted({ label, valuePct, minPct, ok }: {
  label: string; valuePct: number; minPct: number; ok: boolean;
}) {
  const fillPct  = Math.min(valuePct, 100);
  const barColor = !ok ? "bg-red-500" : valuePct < minPct * 2 ? "bg-yellow-400" : "bg-emerald-500";
  const textColor = !ok ? "text-red-600 dark:text-red-400" : "text-gray-700 dark:text-gray-200";
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <span className="text-xs text-gray-500 dark:text-gray-400 truncate">{label}</span>
        <span className={`text-xs font-mono font-semibold tabular-nums ${textColor}`}>
          {valuePct.toFixed(0)}%{!ok && <span className="ml-0.5">✗</span>}
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-gray-200 dark:bg-gray-700 overflow-hidden">
        <div className={`h-full rounded-full transition-all ${barColor}`} style={{ width: `${fillPct}%` }} />
      </div>
      <div className="flex items-center justify-between">
        <span className="text-xs text-gray-400">avail.</span>
        <span className="text-xs text-gray-400">min {minPct}%</span>
      </div>
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
  const d      = portfolio.lastDecision;
  const at     = portfolio.lastDecisionAt;
  const pct    = d ? Math.round(d.confidence * 100) : null;
  const vetoed = !!(d?.critique?.veto && (d.critique.confidence ?? 0) >= 0.75);
  return (
    <div className={`rounded-xl border px-4 py-3 col-span-2 sm:col-span-1 ${
      vetoed
        ? "bg-red-50 dark:bg-red-900/10 border-red-200 dark:border-red-800"
        : "bg-white dark:bg-gray-900 border-gray-200 dark:border-gray-700"
    }`}>
      <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">
        {portfolio.llmEnabled ? "Last Decision" : "Mode"}
      </p>
      {!portfolio.llmEnabled ? (
        <p className="text-lg font-bold text-gray-500">Rules</p>
      ) : !d ? (
        <p className="text-sm text-gray-400 italic">pending…</p>
      ) : (
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`text-sm font-bold uppercase ${ACTION_COLORS[d.action] ?? ""}`}>{d.action}</span>
            {pct !== null && (
              <span className={`text-xs font-medium ${pct >= 75 ? "text-green-600 dark:text-green-400" : "text-amber-500"}`}>
                {pct}%
              </span>
            )}
            {vetoed && (
              <span className="text-xs font-semibold text-red-600 dark:text-red-400">
                ✗ critic vetoed
              </span>
            )}
          </div>
          {vetoed && d.critique?.reasoning && (
            <p className="text-xs text-red-500 dark:text-red-400 mt-0.5 leading-snug">
              {d.critique.reasoning}
            </p>
          )}
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
