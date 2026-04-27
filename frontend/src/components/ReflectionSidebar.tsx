"use client";

import { useEffect, useRef, useState } from "react";
import type { Reflection, ReflectionSSEEvent } from "../types/api";

interface Props {
  apiUrl: string;
}

interface LiveReflection {
  timestamp: number;
  text:      string;
  done:      boolean;
}

function fmtTs(ts: number) {
  const d = new Date(ts);
  const now = Date.now();
  const diffH = (now - ts) / 3_600_000;

  if (diffH < 1)   return `${Math.round(diffH * 60)}m ago`;
  if (diffH < 24)  return d.toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit" });
  return d.toLocaleString("en", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

// ─── Single stored reflection card ───────────────────────────────────────────

function ReflectionCard({ r, defaultExpanded = false }: { r: Reflection; defaultExpanded?: boolean }) {
  const lines = r.content.trim().split("\n").filter(Boolean);
  const isLong = lines.length > 2 || r.content.length > 180;
  const [expanded, setExpanded] = useState(defaultExpanded);

  const preview = lines.slice(0, 2).join(" ");
  const display = expanded ? r.content : (isLong ? preview + "…" : r.content);

  return (
    <div className="group border-l-2 border-indigo-200 dark:border-indigo-800 pl-3 py-1">
      <div className="flex items-center gap-2 mb-1">
        <time className="text-xs text-gray-400 dark:text-gray-500 tabular-nums flex-shrink-0">
          {fmtTs(r.timestamp)}
        </time>
      </div>
      <p className="text-xs text-gray-700 dark:text-gray-300 leading-relaxed whitespace-pre-wrap">
        {display}
      </p>
      {isLong && (
        <button
          onClick={() => setExpanded(e => !e)}
          className="mt-1 text-xs text-indigo-500 hover:text-indigo-700 dark:text-indigo-400"
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

// ─── Live streaming card ──────────────────────────────────────────────────────

function LiveCard({ reflection }: { reflection: LiveReflection }) {
  return (
    <div className="border-l-2 border-green-400 dark:border-green-600 pl-3 py-1">
      <div className="flex items-center gap-2 mb-1">
        <span className="flex items-center gap-1.5">
          {!reflection.done && (
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" />
            </span>
          )}
          <time className="text-xs text-gray-400 dark:text-gray-500 tabular-nums">
            {fmtTs(reflection.timestamp)}
          </time>
          {!reflection.done && (
            <span className="text-xs text-green-600 dark:text-green-400 font-medium">Reflecting…</span>
          )}
        </span>
      </div>
      <p className="text-xs text-gray-700 dark:text-gray-300 leading-relaxed whitespace-pre-wrap">
        {reflection.text || <span className="text-gray-400 animate-pulse">…</span>}
        {!reflection.done && (
          <span className="inline-block w-1 h-3 ml-0.5 bg-gray-400 dark:bg-gray-500 animate-pulse align-middle" />
        )}
      </p>
    </div>
  );
}

// ─── Main sidebar ─────────────────────────────────────────────────────────────

export function ReflectionSidebar({ apiUrl }: Props) {
  const [recent,   setRecent]   = useState<Reflection[]>([]);
  const [archived, setArchived] = useState<Reflection[]>([]);
  const [live,     setLive]     = useState<LiveReflection | null>(null);
  const [enabled,  setEnabled]  = useState<boolean | null>(null);
  const [showArch, setShowArch] = useState(false);
  const [connState, setConnState] = useState<"connecting" | "live" | "error">("connecting");

  const liveRef = useRef<LiveReflection | null>(null);

  useEffect(() => {
    const url = `${apiUrl}/reflections/stream`;
    const es  = new EventSource(url);

    es.onopen = () => setConnState("live");
    es.onerror = () => setConnState("error");

    es.onmessage = (e) => {
      let evt: ReflectionSSEEvent;
      try { evt = JSON.parse(e.data); } catch { return; }

      switch (evt.type) {
        case "history": {
          setEnabled(evt.enabled);
          setRecent(evt.recent);
          setArchived(evt.archived);
          break;
        }
        case "start": {
          const r: LiveReflection = { timestamp: evt.timestamp, text: "", done: false };
          liveRef.current = r;
          setLive({ ...r });
          break;
        }
        case "chunk": {
          if (!liveRef.current || liveRef.current.timestamp !== evt.timestamp) {
            // New reflection started mid-stream (edge case)
            liveRef.current = { timestamp: evt.timestamp, text: evt.text, done: false };
          } else {
            liveRef.current.text += evt.text;
          }
          setLive({ ...liveRef.current });
          break;
        }
        case "complete": {
          if (liveRef.current) {
            liveRef.current.done = true;
            setLive({ ...liveRef.current });
          }
          // Add to recent list
          const completed: Reflection = {
            id:        evt.id,
            timestamp: evt.timestamp,
            content:   evt.content,
            summary:   evt.summary,
            archived:  false,
          };
          setRecent(prev => [completed, ...prev]);
          // Clear live after short delay so user sees the completed card
          setTimeout(() => {
            liveRef.current = null;
            setLive(null);
          }, 2_000);
          break;
        }
        case "error": {
          // Clear the live spinner and surface the error as a persistent card
          liveRef.current = null;
          setLive(null);
          const errReflection: Reflection = {
            id:        Date.now(),
            timestamp: evt.timestamp,
            content:   `⚠ Reflection failed: ${evt.error}`,
            summary:   `Error: ${evt.error}`,
            archived:  false,
          };
          setRecent(prev => [errReflection, ...prev]);
          break;
        }
      }
    };

    return () => es.close();
  }, [apiUrl]);

  const connDot = {
    connecting: "bg-yellow-400",
    live:       "bg-green-500",
    error:      "bg-red-500",
  }[connState];

  return (
    <aside className="flex flex-col h-full">
      {/* ── Header ── */}
      <div className="flex items-center justify-between mb-3 flex-shrink-0">
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${connDot}`} title={connState} />
          <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-100">AI Reflections</h2>
        </div>
        {enabled === false && (
          <span className="text-xs text-gray-400">disabled</span>
        )}
      </div>

      {/* ── Not configured ── */}
      {enabled === false && (
        <div className="rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 px-3 py-3 text-xs text-amber-700 dark:text-amber-400">
          Set <code className="font-mono bg-amber-100 dark:bg-amber-900/40 px-1 rounded">OPENROUTER_API_KEY</code> in <code className="font-mono bg-amber-100 dark:bg-amber-900/40 px-1 rounded">.env</code> and restart the agent to enable hourly AI reflections.
        </div>
      )}

      {/* ── Scrollable feed ── */}
      <div className="flex-1 overflow-y-auto space-y-3 pr-1">

        {/* Live streaming reflection */}
        {live && <LiveCard reflection={live} />}

        {/* Recent (2-5 days) */}
        {recent.length === 0 && !live && enabled !== false && (
          <p className="text-xs text-gray-400 dark:text-gray-600 italic">
            {connState === "connecting" ? "Connecting…" : "No reflections yet — first runs at startup."}
          </p>
        )}
        {recent.map((r, i) => (
          <ReflectionCard key={r.id} r={r} defaultExpanded={i === 0} />
        ))}

        {/* Archive toggle */}
        {archived.length > 0 && (
          <div className="pt-1">
            <button
              onClick={() => setShowArch(s => !s)}
              className="flex items-center gap-1 text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 w-full"
            >
              <span className={`transition-transform ${showArch ? "rotate-90" : ""}`}>▶</span>
              <span>{showArch ? "Hide" : "Show"} archive ({archived.length})</span>
            </button>
            {showArch && (
              <div className="mt-2 space-y-3 opacity-70">
                {archived.map(r => (
                  <ReflectionCard key={r.id} r={r} />
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Footer ── */}
      <div className="flex-shrink-0 pt-2 border-t border-gray-200 dark:border-gray-700 mt-2">
        <p className="text-xs text-gray-400 dark:text-gray-600">
          Hourly · 0G memory · DeepSeek V3
        </p>
      </div>
    </aside>
  );
}
