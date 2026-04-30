"use client";

import { useEffect, useState, useCallback } from "react";
import { useAccount } from "wagmi";

const API = process.env.NEXT_PUBLIC_AGENT_API_URL ?? "http://localhost:3001";

// ─── Types ────────────────────────────────────────────────────────────────────

interface AgentPermissions {
  canExecute:       boolean;
  requiresHITL:     boolean;
  maxAllocationPct: number;
}

interface OnChainState {
  tokenId:       number;
  owner:         string;
  name:          string;
  strategyType:  string;
  riskProfile:   string;
  storageUri:    string;
  version:       string;
  permissions:   AgentPermissions;
  mintedAt:      number;
  parentTokenId: number;
}

interface PerformanceStats {
  totalTrades:   number;
  openPositions: number;
  totalPnlUsd:   number;
  totalFeesUsd:  number;
  avgAPY:        number;
  regime:        string;
}

interface AgentMetadata {
  schemaVersion:    string;
  name:             string;
  strategyType:     string;
  riskProfile:      string;
  description:      string;
  modelConfig:      string;
  scorecardWeights: Record<string, number>;
  performance:      PerformanceStats;
  permissions:      AgentPermissions;
  hookPreferences:  { maxRiskScore: number; preferAutoComp: boolean };
  snapshotAt:       number;
  note:             string;
}

interface AgentINFTRecord {
  onChain:     OnChainState;
  metadata:    AgentMetadata | null;
  explorerUrl: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const RISK_COLORS: Record<string, string> = {
  low:      "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300",
  moderate: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300",
  high:     "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
};

const STRATEGY_OPTIONS = [
  { value: "conservative-stable",   label: "Conservative Stablecoin LP" },
  { value: "eth-usdc-harvest",      label: "ETH/USDC Volatility Harvest" },
  { value: "hook-aware-aggressive", label: "Hook-Aware High-Risk" },
  { value: "testnet-research",      label: "Testnet Research" },
];

function shortAddr(addr: string) {
  return addr ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : "—";
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function AgentCard({
  record,
  onAuthorize,
  onClone,
  onTransfer,
}: {
  record:      AgentINFTRecord;
  onAuthorize: (tokenId: number) => void;
  onClone:     (tokenId: number) => void;
  onTransfer:  (tokenId: number) => void;
}) {
  const { onChain: s, metadata: m, explorerUrl } = record;
  const perf = m?.performance;

  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-4 flex flex-col gap-3">
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-base truncate">{s.name}</span>
            <span className="text-xs text-gray-400 font-mono">#{s.tokenId}</span>
            {s.parentTokenId > 0 && (
              <span className="text-xs text-purple-600 dark:text-purple-400">cloned from #{s.parentTokenId}</span>
            )}
          </div>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 line-clamp-2">
            {m?.description ?? s.strategyType}
          </p>
        </div>
        <span className={`shrink-0 text-xs font-medium px-2 py-0.5 rounded-full ${RISK_COLORS[s.riskProfile] ?? RISK_COLORS.moderate}`}>
          {s.riskProfile}
        </span>
      </div>

      {/* Permissions row */}
      <div className="flex gap-2 flex-wrap text-xs">
        <span className={`px-2 py-0.5 rounded-full font-medium ${s.permissions.canExecute ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300" : "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400"}`}>
          {s.permissions.canExecute ? "✓ Can Execute" : "✗ Manual Only"}
        </span>
        <span className={`px-2 py-0.5 rounded-full font-medium ${s.permissions.requiresHITL ? "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300" : "bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400"}`}>
          {s.permissions.requiresHITL ? "HITL Required" : "Autonomous OK"}
        </span>
        <span className="px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300 font-medium">
          Max {s.permissions.maxAllocationPct}%
        </span>
      </div>

      {/* Performance grid */}
      {perf && (
        <div className="grid grid-cols-3 gap-2 text-center text-xs rounded-lg bg-gray-50 dark:bg-gray-800/50 p-2">
          <div>
            <div className="font-semibold text-sm">{perf.avgAPY.toFixed(1)}%</div>
            <div className="text-gray-500">Avg APY</div>
          </div>
          <div>
            <div className={`font-semibold text-sm ${perf.totalPnlUsd >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-500"}`}>
              {perf.totalPnlUsd >= 0 ? "+" : ""}${perf.totalPnlUsd.toFixed(0)}
            </div>
            <div className="text-gray-500">Total PnL</div>
          </div>
          <div>
            <div className="font-semibold text-sm">{perf.openPositions}</div>
            <div className="text-gray-500">Open Pos</div>
          </div>
        </div>
      )}

      {/* Storage + explorer */}
      <div className="text-xs text-gray-400 flex items-center justify-between gap-2 flex-wrap">
        <span className="font-mono truncate max-w-[16rem]" title={s.storageUri}>
          0G: {s.storageUri ? s.storageUri.slice(0, 24) + "…" : "—"}
        </span>
        {m && (
          <span className="text-gray-400">
            v{s.version} · {m.modelConfig}
          </span>
        )}
      </div>

      {/* Actions */}
      <div className="flex gap-2 pt-1 border-t border-gray-100 dark:border-gray-800">
        <a
          href={explorerUrl}
          target="_blank"
          rel="noreferrer"
          className="text-xs px-2.5 py-1.5 rounded-md border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
        >
          Explorer ↗
        </a>
        <button
          onClick={() => onClone(s.tokenId)}
          className="text-xs px-2.5 py-1.5 rounded-md border border-purple-300 dark:border-purple-700 text-purple-700 dark:text-purple-300 hover:bg-purple-50 dark:hover:bg-purple-900/20 transition-colors"
        >
          Clone
        </button>
        <button
          onClick={() => onAuthorize(s.tokenId)}
          className="text-xs px-2.5 py-1.5 rounded-md border border-blue-300 dark:border-blue-700 text-blue-700 dark:text-blue-300 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors"
        >
          Authorize
        </button>
        <button
          onClick={() => onTransfer(s.tokenId)}
          className="text-xs px-2.5 py-1.5 rounded-md border border-orange-300 dark:border-orange-700 text-orange-700 dark:text-orange-300 hover:bg-orange-50 dark:hover:bg-orange-900/20 transition-colors ml-auto"
        >
          Transfer
        </button>
      </div>
    </div>
  );
}

// ─── Action modal (authorize / clone / transfer) ──────────────────────────────

function ActionModal({
  action,
  tokenId,
  onClose,
  onDone,
}: {
  action:  "authorize" | "clone" | "transfer";
  tokenId: number;
  onClose: () => void;
  onDone:  (msg: string) => void;
}) {
  const [addr,       setAddr]       = useState("");
  const [fromAddr,   setFromAddr]   = useState("");
  const [authorized, setAuthorized] = useState(true);
  const [busy,       setBusy]       = useState(false);
  const [error,      setError]      = useState("");

  async function submit() {
    setBusy(true);
    setError("");
    try {
      let url = `${API}/inft/${tokenId}/${action}`;
      let body: Record<string, unknown> = {};
      if (action === "authorize") body = { user: addr, authorized };
      if (action === "clone")     body = { cloneOwner: addr };
      if (action === "transfer")  body = { from: fromAddr, to: addr };

      const r = await fetch(url, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(body),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error ?? "Request failed");
      onDone(`${action} successful — tx: ${(data.txHash as string)?.slice(0, 16)}…`);
      onClose();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  const titles: Record<string, string> = {
    authorize: `Authorize / Revoke for #${tokenId}`,
    clone:     `Clone Agent #${tokenId}`,
    transfer:  `Transfer Agent #${tokenId}`,
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div className="w-full max-w-sm bg-white dark:bg-gray-900 rounded-2xl shadow-2xl p-6 flex flex-col gap-4">
        <h3 className="font-semibold text-base">{titles[action]}</h3>

        {action === "transfer" && (
          <div className="flex flex-col gap-1">
            <label className="text-xs text-gray-500">From address</label>
            <input
              value={fromAddr}
              onChange={e => setFromAddr(e.target.value)}
              placeholder="0x…"
              className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>
        )}

        <div className="flex flex-col gap-1">
          <label className="text-xs text-gray-500">
            {action === "authorize" ? "User address" : action === "clone" ? "New owner address" : "To address"}
          </label>
          <input
            value={addr}
            onChange={e => setAddr(e.target.value)}
            placeholder="0x…"
            className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
        </div>

        {action === "authorize" && (
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="checkbox"
              checked={authorized}
              onChange={e => setAuthorized(e.target.checked)}
              className="rounded"
            />
            Grant access (uncheck to revoke)
          </label>
        )}

        {error && <p className="text-xs text-red-500">{error}</p>}

        <div className="flex gap-3 justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm rounded-lg border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={busy || !addr}
            className="px-4 py-2 text-sm rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50 transition-colors"
          >
            {busy ? "Submitting…" : "Confirm"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Mint form ────────────────────────────────────────────────────────────────

function MintForm({ onMinted }: { onMinted: (msg: string) => void }) {
  const { address } = useAccount();
  const [to,           setTo]           = useState("");
  const [strategyType, setStrategyType] = useState("eth-usdc-harvest");
  const [agentName,    setAgentName]    = useState("");
  const [busy,         setBusy]         = useState(false);
  const [error,        setError]        = useState("");

  // Pre-fill connected wallet
  useEffect(() => { if (address && !to) setTo(address); }, [address, to]);

  async function mint() {
    setBusy(true);
    setError("");
    try {
      const body: Record<string, string> = { to, strategyType };
      if (agentName) body.name = agentName;
      const r = await fetch(`${API}/inft/mint-agent`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(body),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error ?? "Mint failed");
      onMinted(`Minted INFT #${data.tokenId} — tx: ${(data.txHash as string)?.slice(0, 16)}… (0G Galileo)`);
      setAgentName("");
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-xl border border-dashed border-indigo-300 dark:border-indigo-700 bg-indigo-50/30 dark:bg-indigo-900/10 p-4 flex flex-col gap-3">
      <h3 className="font-semibold text-sm text-indigo-700 dark:text-indigo-300">Mint New Strategy Agent</h3>
      <p className="text-xs text-gray-500 dark:text-gray-400">
        Captures current portfolio state as an ownable INFT on 0G Galileo testnet. Metadata stored on 0G Storage.
      </p>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <label className="text-xs text-gray-500">Strategy type</label>
          <select
            value={strategyType}
            onChange={e => setStrategyType(e.target.value)}
            className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
          >
            {STRATEGY_OPTIONS.map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-gray-500">Agent name (optional)</label>
          <input
            value={agentName}
            onChange={e => setAgentName(e.target.value)}
            placeholder="My Yield Agent"
            className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
        </div>
        <div className="flex flex-col gap-1 sm:col-span-2">
          <label className="text-xs text-gray-500">Mint to address</label>
          <input
            value={to}
            onChange={e => setTo(e.target.value)}
            placeholder="0x…"
            className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
        </div>
      </div>

      {error && <p className="text-xs text-red-500">{error}</p>}

      <button
        onClick={mint}
        disabled={busy || !to}
        className="self-start px-4 py-2 text-sm rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50 transition-colors font-semibold"
      >
        {busy ? "Minting…" : "Mint Agent INFT"}
      </button>
    </div>
  );
}

// ─── Main Panel ───────────────────────────────────────────────────────────────

export function AgentINFTPanel({ onClose }: { onClose: () => void }) {
  const { address } = useAccount();
  const [owner,    setOwner]    = useState(address ?? "");
  const [agents,   setAgents]   = useState<AgentINFTRecord[]>([]);
  const [loading,  setLoading]  = useState(false);
  const [toast,    setToast]    = useState<string | null>(null);
  const [error,    setError]    = useState("");
  const [action,   setAction]   = useState<{ type: "authorize" | "clone" | "transfer"; tokenId: number } | null>(null);
  const [demoMode, setDemoMode] = useState(false);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 6000);
  }, []);

  async function fetchAgents() {
    if (!owner) return;
    setLoading(true);
    setError("");
    try {
      const r = await fetch(`${API}/inft/agents/${encodeURIComponent(owner)}`);
      const data = await r.json();
      if (!r.ok) throw new Error(data.error ?? "Fetch failed");
      setAgents(data.agents ?? []);
      if (data.agents.length === 0 && !process.env.INFT_CONTRACT_ADDRESS) {
        setDemoMode(true);
      }
    } catch (e: any) {
      setError(e.message);
      // Show a demo card in dev when contract isn't configured
      setDemoMode(true);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (owner) fetchAgents();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Demo placeholder shown when contract isn't deployed yet
  const demoRecord: AgentINFTRecord = {
    onChain: {
      tokenId: 1,
      owner: owner || "0xDEMO",
      name: "ETH/USDC Volatility Harvest Agent",
      strategyType: "eth-usdc-harvest",
      riskProfile: "moderate",
      storageUri: "sha256-demo00000000000000000",
      version: "1.0",
      permissions: { canExecute: false, requiresHITL: true, maxAllocationPct: 25 },
      mintedAt: Math.floor(Date.now() / 1000),
      parentTokenId: 0,
    },
    metadata: {
      schemaVersion: "1.0",
      name: "ETH/USDC Volatility Harvest Agent",
      strategyType: "eth-usdc-harvest",
      riskProfile: "moderate",
      description: "ETH-denominated pairs with high fee capture. Balanced scoring.",
      modelConfig: "claude-sonnet-4-6",
      scorecardWeights: { yield: 0.22, il: 0.18, liquidity: 0.13, tokenRisk: 0.09, hookRisk: 0.12 },
      performance: { totalTrades: 12, openPositions: 3, totalPnlUsd: 248.5, totalFeesUsd: 180, avgAPY: 34.2, regime: "neutral" },
      permissions: { canExecute: false, requiresHITL: true, maxAllocationPct: 25 },
      hookPreferences: { maxRiskScore: 50, preferAutoComp: false },
      snapshotAt: Date.now(),
      note: "Demo — deploy INFT_CONTRACT_ADDRESS to activate on-chain",
    },
    explorerUrl: "#",
  };

  const displayAgents = agents.length > 0 ? agents : (demoMode ? [demoRecord] : []);

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 backdrop-blur-sm p-4 overflow-y-auto">
        <div className="relative w-full max-w-2xl mt-6 mb-6 bg-white dark:bg-gray-950 rounded-2xl shadow-2xl border border-gray-200 dark:border-gray-800 flex flex-col">

          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 dark:border-gray-800">
            <div>
              <h2 className="font-bold text-lg">My Strategy Agents</h2>
              <p className="text-xs text-gray-500 dark:text-gray-400">ERC-7857-style INFTs on 0G Galileo testnet</p>
            </div>
            <button
              onClick={onClose}
              className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors text-gray-500"
            >
              ✕
            </button>
          </div>

          {/* Owner search */}
          <div className="px-6 pt-4 pb-2 flex gap-2">
            <input
              value={owner}
              onChange={e => setOwner(e.target.value)}
              placeholder="0x… owner address"
              className="flex-1 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
            <button
              onClick={fetchAgents}
              disabled={loading || !owner}
              className="px-4 py-2 text-sm rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50 transition-colors"
            >
              {loading ? "…" : "Load"}
            </button>
          </div>

          {/* Body */}
          <div className="px-6 pb-6 flex flex-col gap-4 overflow-y-auto max-h-[70vh]">

            {/* Demo notice */}
            {demoMode && agents.length === 0 && (
              <div className="rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 px-4 py-2 text-xs text-amber-700 dark:text-amber-300">
                Demo mode — INFT_CONTRACT_ADDRESS not configured. Set it to enable on-chain minting on 0G Galileo testnet.
              </div>
            )}

            {error && (
              <div className="text-xs text-red-500 bg-red-50 dark:bg-red-900/20 rounded-lg px-4 py-2">{error}</div>
            )}

            {/* Agent cards */}
            {displayAgents.map(record => (
              <AgentCard
                key={record.onChain.tokenId}
                record={record}
                onAuthorize={id => setAction({ type: "authorize", tokenId: id })}
                onClone={id => setAction({ type: "clone",     tokenId: id })}
                onTransfer={id => setAction({ type: "transfer",   tokenId: id })}
              />
            ))}

            {!loading && !demoMode && displayAgents.length === 0 && (
              <p className="text-sm text-gray-400 text-center py-4">No strategy agents found for this address.</p>
            )}

            {/* Mint form */}
            <MintForm onMinted={msg => { showToast(msg); fetchAgents(); }} />

            {/* Info footer */}
            <div className="text-xs text-gray-400 dark:text-gray-500 leading-relaxed">
              Strategy agents are ownable NFTs that capture your AI portfolio strategy — weights, risk profile, and performance history — on-chain.
              Metadata is stored on 0G Storage and referenced by <code className="font-mono">storageUri</code>.
              Clone to fork a strategy to another wallet; Authorize to grant execution rights without transfer.
            </div>
          </div>
        </div>
      </div>

      {/* Action sub-modal */}
      {action && (
        <ActionModal
          action={action.type}
          tokenId={action.tokenId}
          onClose={() => setAction(null)}
          onDone={msg => { showToast(msg); fetchAgents(); }}
        />
      )}

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-6 right-6 z-[70] bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 text-xs px-4 py-3 rounded-xl shadow-lg max-w-sm">
          {toast}
        </div>
      )}
    </>
  );
}
