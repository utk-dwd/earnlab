"use client";

import { useState } from "react"; // used in PendingCard for busy/result state
import type { PendingAction, CritiqueResult } from "../types/api";

interface Props {
  actions:  PendingAction[];
  apiUrl:   string;
  onUpdate: () => void;
}

const ACTION_STYLES: Record<string, string> = {
  enter:     "bg-green-100  text-green-700  dark:bg-green-900/40  dark:text-green-400",
  exit:      "bg-red-100    text-red-700    dark:bg-red-900/40    dark:text-red-400",
  rebalance: "bg-blue-100   text-blue-700   dark:bg-blue-900/40   dark:text-blue-400",
  hold:      "bg-gray-100   text-gray-500   dark:bg-gray-800      dark:text-gray-400",
  wait:      "bg-amber-100  text-amber-600  dark:bg-amber-900/40  dark:text-amber-400",
};

function fmtAge(ts: number) {
  const diffMs = Date.now() - ts;
  const diffM  = Math.floor(diffMs / 60_000);
  if (diffM < 1)  return "just now";
  if (diffM < 60) return `${diffM}m ago`;
  return `${Math.floor(diffM / 60)}h ago`;
}

function fmtExpiry(expiresAt: number) {
  const remaining = expiresAt - Date.now();
  if (remaining <= 0) return "expired";
  const m = Math.ceil(remaining / 60_000);
  return `${m}m left`;
}

function ConfidenceBar({ value }: { value: number }) {
  const pct   = Math.round(value * 100);
  const color = pct >= 75 ? "bg-green-500" : pct >= 50 ? "bg-amber-400" : "bg-red-400";
  return (
    <div className="flex items-center gap-1.5">
      <div className="flex-1 h-1 rounded-full bg-gray-200 dark:bg-gray-700 overflow-hidden">
        <div className={`h-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs tabular-nums text-gray-500 dark:text-gray-400 w-7 text-right">{pct}%</span>
    </div>
  );
}

function CritiqueNote({ critique }: { critique: CritiqueResult }) {
  const vetoed = critique.veto && critique.confidence >= 0.75;
  return (
    <div className={`mt-2 rounded px-2 py-1.5 border-l-2 text-xs ${
      vetoed
        ? "border-red-400   bg-red-50   dark:bg-red-900/20   text-red-700   dark:text-red-400"
        : "border-green-400 bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-400"
    }`}>
      <span className="font-semibold">{vetoed ? "✗ Critic vetoed" : "✓ Critic approved"}</span>
      <span className="ml-1.5 text-gray-400 dark:text-gray-500">({(critique.confidence * 100).toFixed(0)}% conf)</span>
      <p className="mt-0.5 leading-relaxed">{critique.reasoning}</p>
    </div>
  );
}

function APYSnapshot({ snap, action }: { snap: PendingAction["opportunitySnapshot"]; action: string }) {
  if (!snap) return null;
  return (
    <div className="mt-2 grid grid-cols-2 gap-x-3 text-xs text-gray-500 dark:text-gray-400">
      <span>APY at queue: <span className="font-mono text-gray-700 dark:text-gray-200">{snap.displayAPY.toFixed(1)}%</span></span>
      {snap.rar7d > 0 && (
        <span>RAR7d: <span className="font-mono text-gray-700 dark:text-gray-200">{snap.rar7d.toFixed(2)}</span></span>
      )}
      {snap.netAPY !== snap.displayAPY && (
        <span>Net APY: <span className="font-mono text-gray-700 dark:text-gray-200">{snap.netAPY.toFixed(1)}%</span></span>
      )}
    </div>
  );
}

function PendingCard({ action, apiUrl, onUpdate }: {
  action:   PendingAction;
  apiUrl:   string;
  onUpdate: () => void;
}) {
  const [busy,   setBusy]   = useState<"approve" | "reject" | null>(null);
  const [result, setResult] = useState<{ ok: boolean; message: string; staleReason?: string; executionFailed?: boolean } | null>(null);

  const isPending = action.status === "pending";
  const isStale   = action.status === "stale";
  const isDone    = action.status === "executed" || action.status === "approved";
  const isRejected = action.status === "rejected";

  async function handleApprove() {
    setBusy("approve");
    setResult(null);
    try {
      const res = await fetch(`${apiUrl}/pending-actions/${action.id}/approve`, { method: "POST" });
      const data = await res.json();
      setResult(data);
      if (data.ok) onUpdate();
    } catch (e: any) {
      setResult({ ok: false, message: e.message });
    } finally {
      setBusy(null);
    }
  }

  async function handleReject() {
    setBusy("reject");
    setResult(null);
    try {
      const res = await fetch(`${apiUrl}/pending-actions/${action.id}/reject`, { method: "POST" });
      const data = await res.json();
      setResult(data);
      if (data.ok) onUpdate();
    } catch (e: any) {
      setResult({ ok: false, message: e.message });
    } finally {
      setBusy(null);
    }
  }

  const staleReason = action.staleReason ?? result?.staleReason;
  const dimmed      = isStale || isDone || isRejected;

  return (
    <div className={`rounded-xl border p-4 transition-opacity ${
      dimmed
        ? "opacity-50 border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/40"
        : "border-indigo-200 dark:border-indigo-800 bg-white dark:bg-gray-900"
    }`}>
      {/* Header row */}
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`text-xs font-semibold px-1.5 py-0.5 rounded uppercase tracking-wide ${ACTION_STYLES[action.action] ?? ""}`}>
            {action.action}
          </span>
          {action.pair && (
            <span className="text-sm font-semibold text-gray-800 dark:text-gray-100">{action.pair}</span>
          )}
          {action.chainName && (
            <span className="text-xs text-gray-500 dark:text-gray-400">{action.chainName}</span>
          )}
          {action.allocationPct != null && (
            <span className="text-xs text-gray-400">({action.allocationPct.toFixed(0)}%)</span>
          )}
          {action.action === "rebalance" && action.closePair && (
            <span className="text-xs text-gray-400 dark:text-gray-500">← exit {action.closePair}</span>
          )}
        </div>
        <div className="flex flex-col items-end text-xs text-gray-400 dark:text-gray-500 shrink-0">
          <span>{fmtAge(action.queuedAt)}</span>
          {isPending && <span className="text-amber-500">{fmtExpiry(action.expiresAt)}</span>}
          {isDone      && <span className="text-green-600 dark:text-green-400 font-medium">executed</span>}
          {isRejected  && <span className="text-gray-400">rejected</span>}
          {isStale     && <span className="text-red-500 font-medium">stale</span>}
        </div>
      </div>

      {/* Confidence */}
      <div className="mb-2">
        <ConfidenceBar value={action.confidence} />
      </div>

      {/* Reasoning */}
      <p className="text-sm text-gray-700 dark:text-gray-300 leading-relaxed mb-1">
        {action.reasoning}
      </p>

      {/* Exit condition */}
      {action.exitCondition && (
        <p className="text-xs text-amber-600 dark:text-amber-400 italic mb-1">
          Exit if: {action.exitCondition}
        </p>
      )}

      {/* APY snapshot */}
      <APYSnapshot snap={action.opportunitySnapshot} action={action.action} />

      {/* Critic status */}
      {action.awaitingCritique && (
        <div className="mt-2 flex items-start gap-2 rounded px-2.5 py-2 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700 text-xs text-amber-700 dark:text-amber-300">
          <span className="mt-0.5 shrink-0 animate-pulse">⏳</span>
          <div>
            <span className="font-semibold">Critic review in progress</span>
            <p className="mt-0.5 text-amber-600 dark:text-amber-400">
              The critic agent is still evaluating this decision. Consider waiting for their
              verdict before approving — it may reveal risks or veto this action.
            </p>
          </div>
        </div>
      )}
      {action.critique && <CritiqueNote critique={action.critique} />}

      {/* Stale reason */}
      {staleReason && (
        <div className="mt-2 rounded px-2 py-1.5 bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 text-xs text-gray-600 dark:text-gray-400">
          <span className="font-semibold text-gray-700 dark:text-gray-300">No longer available: </span>
          {staleReason}
        </div>
      )}

      {/* Execution failure banner */}
      {result && !result.ok && !result.staleReason && (
        <div className="mt-2 rounded px-2.5 py-2 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-700 text-xs text-red-700 dark:text-red-300">
          <p className="font-semibold mb-1">Could not execute</p>
          {result.message.split("\n").map((line, i) => (
            <p key={i} className="leading-relaxed font-mono">{line}</p>
          ))}
        </div>
      )}

      {/* Action buttons */}
      {isPending && !result?.staleReason && (() => {
        const criticVetoed = !!(action.critique?.veto && (action.critique.confidence ?? 0) >= 0.75);
        return (
          <div className="flex gap-2 mt-3">
            {criticVetoed ? (
              <button
                onClick={handleApprove}
                disabled={busy !== null}
                className="flex-1 py-1.5 rounded-lg text-sm font-semibold bg-rose-600 hover:bg-rose-700 text-white disabled:opacity-50 transition-colors"
                title="Override the critic's veto and execute anyway"
              >
                {busy === "approve" ? "Executing…" : "Override Critic & Execute"}
              </button>
            ) : (
              <button
                onClick={handleApprove}
                disabled={busy !== null}
                className="flex-1 py-1.5 rounded-lg text-sm font-semibold bg-green-600 hover:bg-green-700 text-white disabled:opacity-50 transition-colors"
              >
                {busy === "approve" ? "Executing…" : "Approve & Execute"}
              </button>
            )}
            <button
              onClick={handleReject}
              disabled={busy !== null}
              className="flex-1 py-1.5 rounded-lg text-sm font-semibold bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700 disabled:opacity-50 transition-colors border border-gray-200 dark:border-gray-700"
            >
              {busy === "reject" ? "…" : "Reject"}
            </button>
          </div>
        );
      })()}
    </div>
  );
}

export function PendingActionsPanel({ actions, apiUrl, onUpdate }: Props) {
  // Only show actionable pending decisions — exclude hold/wait and any resolved/stale items
  const pending = actions.filter(
    a => a.status === "pending" && a.action !== "hold" && a.action !== "wait",
  );

  return (
    <div className="rounded-xl border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/10 p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-amber-800 dark:text-amber-300">
            Awaiting Your Approval
          </span>
          {pending.length > 0 && (
            <span className="text-xs font-bold bg-amber-500 text-white rounded-full px-2 py-0.5">
              {pending.length}
            </span>
          )}
        </div>
        <p className="text-xs text-amber-600 dark:text-amber-400">
          Human-in-the-Loop mode · Agent paused for confirmation
        </p>
      </div>

      {pending.length === 0 ? (
        <p className="text-sm text-amber-700 dark:text-amber-400 italic">
          No pending actions — agent will queue decisions here as opportunities are identified.
        </p>
      ) : (
        <div className="space-y-3">
          {pending.map(a => (
            <PendingCard key={a.id} action={a} apiUrl={apiUrl} onUpdate={onUpdate} />
          ))}
        </div>
      )}
    </div>
  );
}
