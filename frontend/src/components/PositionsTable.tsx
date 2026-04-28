"use client";

import { Fragment } from "react";
import type { MockPosition, PortfolioSummary } from "../types/api";

interface Props {
  positions:  MockPosition[];
  summary:    PortfolioSummary | null;
  isLoading:  boolean;
}

// ─── Grade ────────────────────────────────────────────────────────────────────

type Grade = "A" | "B" | "C" | "D" | "F";

function computeGrade(pos: MockPosition): Grade {
  const { entryRAR7d, earnedFeesUsd, entryValueUsd, hoursHeld, status, pnlUsd } = pos;

  // For closed positions that lost money: F
  if (status === "closed" && pnlUsd < -entryValueUsd * 0.01) return "F";

  // Annualised actual yield (only meaningful after 1+ hours)
  const actualAPY = hoursHeld >= 1
    ? (earnedFeesUsd / entryValueUsd) / hoursHeld * 8_760 * 100
    : 0;

  // Blend entry quality (RAR7d) with actual performance
  if (entryRAR7d >= 2.0 && (actualAPY > 5 || hoursHeld < 1)) return "A";
  if (entryRAR7d >= 1.0) return "B";
  if (entryRAR7d >= 0.5) return "C";
  if (entryRAR7d > 0)    return "D";
  return "F";
}

const GRADE_STYLE: Record<Grade, string> = {
  A: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400",
  B: "bg-green-100   text-green-700   dark:bg-green-900/40   dark:text-green-400",
  C: "bg-yellow-100  text-yellow-700  dark:bg-yellow-900/40  dark:text-yellow-400",
  D: "bg-orange-100  text-orange-700  dark:bg-orange-900/40  dark:text-orange-400",
  F: "bg-red-100     text-red-700     dark:bg-red-900/40     dark:text-red-400",
};

// ─── Formatters ───────────────────────────────────────────────────────────────

function fmtDate(ts: number) {
  return new Date(ts).toLocaleString("en", {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

function fmtUsd(n: number, decimals = 2) {
  if (!Number.isFinite(n)) return "—";
  return `$${n.toLocaleString("en", { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
}

function fmtPct(n: number) {
  if (!n || !Number.isFinite(n)) return "—";
  return `${n.toFixed(2)}%`;
}

function fmtHours(h: number) {
  if (h < 1)  return `${Math.round(h * 60)}m`;
  if (h < 24) return `${h.toFixed(1)}h`;
  return `${(h / 24).toFixed(1)}d`;
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function StatusBadge({ status, alertCount }: { status: "open" | "closed"; alertCount?: number }) {
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full font-semibold ${
      status === "open"
        ? alertCount
          ? "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400"
          : "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-400"
        : "bg-gray-200 text-gray-600 dark:bg-gray-700 dark:text-gray-400"
    }`}>
      {status === "open" && alertCount ? `⚠ ${alertCount}` : status.toUpperCase()}
    </span>
  );
}

function TimeInRangeBar({ pct, halfRangePct }: { pct: number; halfRangePct?: number }) {
  const color = pct >= 80 ? "bg-green-500" : pct >= 50 ? "bg-amber-400" : "bg-red-500";
  return (
    <div className="flex items-center gap-1 mt-1">
      <div className="w-12 h-1.5 rounded-full bg-gray-200 dark:bg-gray-700 overflow-hidden">
        <div className={`h-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs tabular-nums text-gray-400">{pct.toFixed(0)}%</span>
      {halfRangePct != null && halfRangePct > 0 && (
        <span className="text-xs text-gray-300 dark:text-gray-600">±{halfRangePct.toFixed(1)}%</span>
      )}
    </div>
  );
}

function ExitAlertRow({ alerts, closeReason, colSpan }: {
  alerts?: string[]; closeReason?: string; colSpan: number;
}) {
  if (closeReason) {
    return (
      <tr className="bg-gray-50 dark:bg-gray-800/40">
        <td colSpan={colSpan} className="px-4 pb-2 pt-0">
          <span className="text-xs text-gray-500 dark:text-gray-400 italic">
            Closed: {closeReason}
          </span>
        </td>
      </tr>
    );
  }
  if (!alerts?.length) return null;
  return (
    <tr className="bg-amber-50 dark:bg-amber-900/10">
      <td colSpan={colSpan} className="px-4 pb-2 pt-0">
        <div className="flex flex-wrap gap-2">
          {alerts.map((a, i) => (
            <span key={i} className="text-xs text-amber-700 dark:text-amber-400 bg-amber-100 dark:bg-amber-900/30 rounded px-1.5 py-0.5">
              ⚠ {a}
            </span>
          ))}
        </div>
      </td>
    </tr>
  );
}

function GradeBadge({ grade }: { grade: Grade }) {
  return (
    <span className={`inline-flex items-center justify-center w-7 h-7 rounded-full text-sm font-bold ${GRADE_STYLE[grade]}`}>
      {grade}
    </span>
  );
}

function PnlCell({ value, pending }: { value: number; pending?: boolean }) {
  if (!Number.isFinite(value) || (value === 0 && pending)) {
    return <span className="text-gray-400 text-xs">—</span>;
  }
  const color = value > 0
    ? "text-green-600 dark:text-green-400"
    : value < 0
    ? "text-red-500 dark:text-red-400"
    : "text-gray-500";
  const sign = value > 0 ? "+" : "";
  return (
    <span className={`font-mono tabular-nums font-semibold ${color}`}>
      {sign}{fmtUsd(value)}
    </span>
  );
}

function SummaryBar({ summary, positions }: { summary: PortfolioSummary; positions: MockPosition[] }) {
  const totalPnl   = summary.unrealizedPnlUsd + summary.realizedPnlUsd;
  const openCount  = positions.filter(p => p.status === "open").length;
  const closedCount = positions.filter(p => p.status === "closed").length;

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
      <SummaryCard
        label="Investable Funds"
        value={fmtUsd(summary.cashUsd)}
        sub={`of ${fmtUsd(summary.totalCapitalUsd)} total capital`}
      />
      <SummaryCard
        label="Total Running PnL"
        value={`${totalPnl >= 0 ? "+" : ""}${fmtUsd(totalPnl)}`}
        sub={`Realised ${fmtUsd(summary.realizedPnlUsd)} · Unrealised ${fmtUsd(summary.unrealizedPnlUsd)}`}
        valueColor={totalPnl >= 0 ? "text-green-600 dark:text-green-400" : "text-red-500 dark:text-red-400"}
      />
      <SummaryCard
        label="LP Fees Earned"
        value={fmtUsd(summary.totalEarnedFeesUsd)}
        sub={`Swap fees paid: ${fmtUsd(summary.totalFeesPaidUsd)}`}
        valueColor="text-indigo-600 dark:text-indigo-400"
      />
      <SummaryCard
        label="Positions"
        value={`${openCount} open · ${closedCount} closed`}
        sub={`${summary.tradeCount} total trade events`}
      />
    </div>
  );
}

function SummaryCard({ label, value, sub, valueColor }: {
  label: string; value: string; sub?: string; valueColor?: string;
}) {
  return (
    <div className="rounded-xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 px-4 py-3">
      <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">{label}</p>
      <p className={`text-lg font-bold tabular-nums ${valueColor ?? "text-gray-900 dark:text-gray-100"}`}>{value}</p>
      {sub && <p className="text-xs text-gray-400 mt-0.5">{sub}</p>}
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function PositionsTable({ positions, summary, isLoading }: Props) {
  // Sort reverse-chronological: closed by closedTimestamp, open by entryTimestamp
  const sorted = [...positions].sort((a, b) => {
    const ta = a.closedTimestamp ?? a.entryTimestamp;
    const tb = b.closedTimestamp ?? b.entryTimestamp;
    return tb - ta;
  });

  return (
    <div className="space-y-4">
      {/* ── Summary bar ── */}
      {summary && <SummaryBar summary={summary} positions={positions} />}

      {/* ── Table ── */}
      <div className="rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-100 dark:bg-gray-800 text-left text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                <th className="px-3 py-3">Status</th>
                <th className="px-3 py-3">Date / Time</th>
                <th className="px-3 py-3">Pair</th>
                <th className="px-3 py-3">Chain</th>
                <th className="px-3 py-3">Fee Tier</th>
                <th className="px-3 py-3 text-right">Invested</th>
                <th className="px-3 py-3 text-right">Entry APY</th>
                <th className="px-3 py-3 text-right">Fees Paid</th>
                <th className="px-3 py-3 text-right">Exit Value</th>
                <th className="px-3 py-3 text-right">Realised PnL</th>
                <th className="px-3 py-3 text-right">Unrealised PnL</th>
                <th className="px-3 py-3 text-right">Held</th>
                <th className="px-3 py-3 text-center">Grade</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
              {isLoading && sorted.length === 0 && (
                <tr>
                  <td colSpan={13} className="px-4 py-12 text-center text-gray-400">
                    Loading positions…
                  </td>
                </tr>
              )}
              {!isLoading && sorted.length === 0 && (
                <tr>
                  <td colSpan={13} className="px-4 py-12 text-center text-gray-400">
                    No positions yet — the portfolio manager will open positions after the first scan completes.
                  </td>
                </tr>
              )}
              {sorted.map((pos) => {
                const grade = computeGrade(pos);
                const entryFee = pos.entryValueUsd * 0.001;
                const exitFee  = pos.status === "closed" && pos.closedValueUsd != null
                  ? (pos.closedValueUsd / (1 - 0.001)) * 0.001
                  : 0;
                const totalFeesPaid = entryFee + exitFee;

                const realisedPnl = pos.status === "closed" && pos.closedValueUsd != null
                  ? pos.closedValueUsd - pos.entryValueUsd
                  : null;

                const unrealisedPnl = pos.status === "open" ? pos.pnlUsd : null;
                const alertCount    = pos.exitAlerts?.length ?? 0;
                const COL_SPAN      = 13;

                return (
                  <Fragment key={pos.id}>
                  <tr
                    className={`hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors ${
                      pos.status === "closed" ? "opacity-70" : ""
                    } ${alertCount > 0 ? "border-l-2 border-amber-400" : ""}`}>

                    {/* Status + time-in-range for open positions */}
                    <td className="px-3 py-3">
                      <StatusBadge status={pos.status} alertCount={alertCount} />
                      {pos.status === "open" && pos.timeInRangePct != null && (
                        <TimeInRangeBar pct={pos.timeInRangePct} halfRangePct={pos.halfRangePct} />
                      )}
                    </td>

                    {/* Date — entry date, and exit date if closed */}
                    <td className="px-3 py-3 text-xs text-gray-600 dark:text-gray-400 whitespace-nowrap">
                      <div>{fmtDate(pos.entryTimestamp)}</div>
                      {pos.closedTimestamp && (
                        <div className="text-gray-400 text-xs mt-0.5">
                          → {fmtDate(pos.closedTimestamp)}
                        </div>
                      )}
                    </td>

                    {/* Pair */}
                    <td className="px-3 py-3 font-mono font-semibold dark:text-gray-100">
                      {pos.pair}
                    </td>

                    {/* Chain */}
                    <td className="px-3 py-3 text-xs text-gray-600 dark:text-gray-300">
                      {pos.chainName}
                    </td>

                    {/* Fee tier */}
                    <td className="px-3 py-3 text-xs text-gray-500 dark:text-gray-400">
                      {pos.feeTierLabel}
                    </td>

                    {/* Invested */}
                    <td className="px-3 py-3 text-right tabular-nums font-mono text-gray-700 dark:text-gray-300">
                      {fmtUsd(pos.entryValueUsd)}
                      {pos.allocationPct > 0 && (
                        <div className="text-xs text-gray-400 mt-0.5">{pos.allocationPct.toFixed(1)}%</div>
                      )}
                    </td>

                    {/* Entry APY */}
                    <td className="px-3 py-3 text-right">
                      <span className={`font-semibold tabular-nums ${apyColor(pos.entryAPY)}`}>
                        {fmtPct(pos.entryAPY)}
                      </span>
                    </td>

                    {/* Fees paid (entry + exit) */}
                    <td className="px-3 py-3 text-right tabular-nums font-mono text-gray-500 dark:text-gray-400 text-xs">
                      {fmtUsd(totalFeesPaid)}
                    </td>

                    {/* Exit value */}
                    <td className="px-3 py-3 text-right tabular-nums font-mono text-gray-600 dark:text-gray-300">
                      {pos.closedValueUsd != null ? fmtUsd(pos.closedValueUsd) : (
                        <span className="text-xs text-gray-400">{fmtUsd(pos.currentValueUsd)}</span>
                      )}
                    </td>

                    {/* Realised PnL */}
                    <td className="px-3 py-3 text-right">
                      {realisedPnl != null
                        ? <PnlCell value={realisedPnl} />
                        : <span className="text-gray-300 dark:text-gray-600 text-xs">—</span>
                      }
                    </td>

                    {/* Unrealised PnL */}
                    <td className="px-3 py-3 text-right">
                      {unrealisedPnl != null
                        ? <PnlCell value={unrealisedPnl} />
                        : <span className="text-gray-300 dark:text-gray-600 text-xs">—</span>
                      }
                    </td>

                    {/* Time held */}
                    <td className="px-3 py-3 text-right text-xs text-gray-500 dark:text-gray-400 tabular-nums whitespace-nowrap">
                      {fmtHours(pos.hoursHeld)}
                    </td>

                    {/* Grade */}
                    <td className="px-3 py-3 text-center">
                      <GradeBadge grade={grade} />
                    </td>
                  </tr>
                  {/* Alert / close-reason strip */}
                  {(alertCount > 0 || pos.closeReason) && (
                    <ExitAlertRow
                      alerts={pos.exitAlerts}
                      closeReason={pos.closeReason}
                      colSpan={COL_SPAN}
                    />
                  )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* ── Footer legend ── */}
        <div className="px-4 py-2 bg-gray-50 dark:bg-gray-800 border-t border-gray-200 dark:border-gray-700 text-xs text-gray-400 flex flex-wrap gap-4">
          <span><strong>Grade</strong> — RAR-7d at entry:
            <span className="text-emerald-600 font-semibold"> A</span> ≥2.0
            <span className="text-green-500  font-semibold"> B</span> ≥1.0
            <span className="text-yellow-500 font-semibold"> C</span> ≥0.5
            <span className="text-orange-500 font-semibold"> D</span> &gt;0
            <span className="text-red-500    font-semibold"> F</span> none
          </span>
          <span><strong>TiR bar</strong> = estimated time-in-range vs ±2σ tick range (±% label = vol7d × 2)</span>
          <span><strong>⚠ alerts</strong> — RAR drop &gt;50%, better opp &gt;1.5×, price move &gt;15%, TiR &lt;80%, stale &lt;5% netAPY after 30d</span>
        </div>
      </div>
    </div>
  );
}

function apyColor(apy: number) {
  if (apy >= 50) return "text-red-500";
  if (apy >= 20) return "text-orange-500";
  if (apy >= 5)  return "text-green-600 dark:text-green-400";
  return "text-gray-700 dark:text-gray-200";
}
