"use client";

import { useEffect, useState } from "react";
import type { DecisionCycle, AgentDecision, CritiqueResult } from "../types/api";

interface Props {
  apiUrl: string;
}

const ACTION_STYLES: Record<AgentDecision["action"], string> = {
  enter:     "bg-green-100  text-green-700  dark:bg-green-900/40  dark:text-green-400",
  exit:      "bg-red-100    text-red-700    dark:bg-red-900/40    dark:text-red-400",
  rebalance: "bg-blue-100   text-blue-700   dark:bg-blue-900/40   dark:text-blue-400",
  hold:      "bg-gray-100   text-gray-500   dark:bg-gray-800      dark:text-gray-400",
  wait:      "bg-amber-100  text-amber-600  dark:bg-amber-900/40  dark:text-amber-400",
};

function fmtTs(ts: number) {
  const d   = new Date(ts);
  const now = Date.now();
  const diffH = (now - ts) / 3_600_000;
  if (diffH < 1)  return `${Math.round(diffH * 60)}m ago`;
  if (diffH < 24) return d.toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit" });
  return d.toLocaleString("en", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function ConfidenceBar({ value }: { value: number }) {
  const pct     = Math.round(value * 100);
  const color   = pct >= 75 ? "bg-green-500" : pct >= 50 ? "bg-amber-400" : "bg-red-400";
  return (
    <div className="flex items-center gap-1.5">
      <div className="flex-1 h-1 rounded-full bg-gray-200 dark:bg-gray-700 overflow-hidden">
        <div className={`h-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs tabular-nums text-gray-500 dark:text-gray-400 w-7 text-right">{pct}%</span>
    </div>
  );
}

function CritiquePanel({ critique, action }: { critique: CritiqueResult; action: AgentDecision["action"] }) {
  const vetoed = critique.veto && critique.confidence >= 0.75;
  return (
    <div className={`mt-2 rounded px-2 py-1.5 border-l-2 text-xs ${
      vetoed
        ? "border-red-400   bg-red-50   dark:bg-red-900/20   text-red-700   dark:text-red-400"
        : "border-green-400 bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-400"
    }`}>
      <div className="flex items-center gap-1.5 mb-0.5 font-semibold">
        <span>{vetoed ? "✗ Critic vetoed" : "✓ Critic approved"}</span>
        <span className="font-normal text-gray-400 dark:text-gray-500">
          {(critique.confidence * 100).toFixed(0)}% conf
        </span>
      </div>
      <p className="leading-relaxed">{critique.reasoning}</p>
    </div>
  );
}

function DecisionCard({ d, executed }: { d: AgentDecision; executed: boolean }) {
  const vetoed = d.critique?.veto && (d.critique.confidence ?? 0) >= 0.75;
  return (
    <div className={`rounded-lg px-2.5 py-2 border ${
      vetoed
        ? "border-red-200 dark:border-red-900/60 bg-red-50/50 dark:bg-red-900/10"
        : executed
        ? "border-transparent bg-gray-50 dark:bg-gray-800/60"
        : "border-dashed border-gray-200 dark:border-gray-700 opacity-60"
    }`}>
      <div className="flex items-center gap-2 mb-1.5">
        <span className={`text-xs font-semibold px-1.5 py-0.5 rounded uppercase tracking-wide ${ACTION_STYLES[d.action]}`}>
          {d.action}
        </span>
        {vetoed && (
          <span className="text-xs text-red-500 dark:text-red-400 font-medium">critic veto</span>
        )}
        {!vetoed && !executed && (
          <span className="text-xs text-gray-400 dark:text-gray-500">skipped</span>
        )}
        {d.pool && (
          <code className="text-xs text-gray-400 dark:text-gray-500 font-mono truncate max-w-[80px]">
            {d.pool.slice(0, 10)}…
          </code>
        )}
      </div>
      <ConfidenceBar value={d.confidence} />
      <p className="mt-1.5 text-xs text-gray-700 dark:text-gray-300 leading-relaxed">
        {d.reasoning}
      </p>
      {d.exitCondition && (
        <p className="mt-1 text-xs text-amber-600 dark:text-amber-400 italic">
          Exit if: {d.exitCondition}
        </p>
      )}
      {d.critique && (
        <CritiquePanel critique={d.critique} action={d.action} />
      )}
    </div>
  );
}

function CycleCard({ cycle }: { cycle: DecisionCycle }) {
  const [expanded, setExpanded] = useState(false);
  const primary   = cycle.decisions.find(d => d.action !== "hold" && d.action !== "wait")
    ?? cycle.decisions[0];
  const isHold    = !primary || primary.action === "hold" || primary.action === "wait";
  const hasMore   = cycle.decisions.length > 1;

  return (
    <div className="border-l-2 border-indigo-200 dark:border-indigo-800 pl-3 py-1">
      <div className="flex items-center justify-between mb-1">
        <time className="text-xs text-gray-400 dark:text-gray-500 tabular-nums">{fmtTs(cycle.timestamp)}</time>
        <span className="text-xs text-gray-400 dark:text-gray-600">{cycle.rawTokens} tok</span>
      </div>

      {/* Compact summary line */}
      {!expanded && (
        <div className="flex items-center gap-1.5">
          {primary && (
            <span className={`text-xs font-semibold px-1.5 py-0.5 rounded uppercase tracking-wide ${ACTION_STYLES[primary.action]}`}>
              {primary.action}
            </span>
          )}
          {primary?.critique?.veto && (primary.critique.confidence ?? 0) >= 0.75 && (
            <span className="text-xs text-red-500 dark:text-red-400 font-medium shrink-0">vetoed</span>
          )}
          <p className="text-xs text-gray-600 dark:text-gray-400 truncate flex-1">
            {cycle.reasoning || primary?.reasoning || "—"}
          </p>
        </div>
      )}

      {/* Expanded: per-decision cards */}
      {expanded && (
        <div className="space-y-2 mt-1">
          {cycle.decisions.map((d, i) => (
            <DecisionCard
              key={i}
              d={d}
              executed={d.confidence >= 0.75 && !isHold}
            />
          ))}
          {cycle.reasoning && (
            <p className="text-xs text-gray-500 dark:text-gray-500 italic pt-0.5">
              {cycle.reasoning}
            </p>
          )}
        </div>
      )}

      <button
        onClick={() => setExpanded(e => !e)}
        className="mt-1 text-xs text-indigo-500 hover:text-indigo-700 dark:text-indigo-400"
      >
        {expanded ? "Show less" : `Show details${hasMore ? ` (${cycle.decisions.length})` : ""}`}
      </button>
    </div>
  );
}

export function DecisionFeed({ apiUrl }: Props) {
  const [cycles,     setCycles]     = useState<DecisionCycle[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [llmEnabled, setLlmEnabled] = useState<boolean | null>(null);

  async function fetchDecisions() {
    try {
      const [dRes, pRes] = await Promise.all([
        fetch(`${apiUrl}/portfolio/decisions?limit=20`),
        fetch(`${apiUrl}/portfolio`),
      ]);
      if (dRes.ok) setCycles((await dRes.json()).data ?? []);
      if (pRes.ok) {
        const s = await pRes.json();
        setLlmEnabled(s.llmEnabled ?? false);
      }
    } catch {}
    finally { setLoading(false); }
  }

  useEffect(() => {
    fetchDecisions();
    const id = setInterval(fetchDecisions, 30_000);
    return () => clearInterval(id);
  }, [apiUrl]);

  return (
    <aside className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between mb-3 flex-shrink-0">
        <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-100">Agent Decisions</h2>
        {llmEnabled === false && (
          <span className="text-xs text-gray-400">disabled</span>
        )}
      </div>

      {llmEnabled === false && (
        <div className="rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 px-3 py-3 text-xs text-amber-700 dark:text-amber-400">
          Set <code className="font-mono bg-amber-100 dark:bg-amber-900/40 px-1 rounded">ZEROG_COMPUTE_API_KEY</code> to enable LLM decisions.
        </div>
      )}

      <div className="flex-1 overflow-y-auto space-y-3 pr-1">
        {loading && (
          <p className="text-xs text-gray-400 dark:text-gray-600 italic">Loading…</p>
        )}
        {!loading && cycles.length === 0 && (
          <p className="text-xs text-gray-400 dark:text-gray-600 italic">
            {llmEnabled ? "No decisions yet — first runs at startup." : "Rule-based mode active."}
          </p>
        )}
        {cycles.map((c, i) => (
          <CycleCard key={`${c.timestamp}-${i}`} cycle={c} />
        ))}
      </div>

      <div className="flex-shrink-0 pt-2 border-t border-gray-200 dark:border-gray-700 mt-2">
        <p className="text-xs text-gray-400 dark:text-gray-600">
          Every 5 min · Seeker → Critic → Executor · DeepSeek V3
        </p>
      </div>
    </aside>
  );
}
