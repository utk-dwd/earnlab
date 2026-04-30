"use client";

import { useEffect, useState } from "react";

const API = process.env.NEXT_PUBLIC_AGENT_API_URL ?? "http://localhost:3001";

interface ModelEntry {
  id:       string;
  label:    string;
  provider: string;
  note:     string;
}

// Hardcoded so the dropdown always works even if the agent API is offline.
const MODELS: ModelEntry[] = [
  { id: "deepseek/deepseek-chat-v3-0324",        label: "DeepSeek V3",         provider: "DeepSeek",  note: "Default — fast & cost-efficient" },
  { id: "deepseek/deepseek-r1",                  label: "DeepSeek R1",         provider: "DeepSeek",  note: "Chain-of-thought reasoning" },
  { id: "deepseek/deepseek-r1-distill-llama-70b",label: "DeepSeek R1 Distill", provider: "DeepSeek",  note: "R1 reasoning, faster" },
  { id: "openai/gpt-4o",                         label: "GPT-4o",              provider: "OpenAI",    note: "" },
  { id: "openai/gpt-4o-mini",                    label: "GPT-4o Mini",         provider: "OpenAI",    note: "Fast & cheap" },
  { id: "openai/gpt-4-turbo",                    label: "GPT-4 Turbo",         provider: "OpenAI",    note: "" },
  { id: "openai/o1-mini",                        label: "o1 Mini",             provider: "OpenAI",    note: "Reasoning" },
  { id: "anthropic/claude-3.5-sonnet",           label: "Claude 3.5 Sonnet",   provider: "Anthropic", note: "" },
  { id: "anthropic/claude-3.5-haiku",            label: "Claude 3.5 Haiku",    provider: "Anthropic", note: "Fast & cheap" },
  { id: "anthropic/claude-3-opus",               label: "Claude 3 Opus",       provider: "Anthropic", note: "Most capable" },
  { id: "meta-llama/llama-3.1-405b-instruct",    label: "Llama 3.1 405B",      provider: "Meta",      note: "Open-source flagship" },
  { id: "meta-llama/llama-3.1-70b-instruct",     label: "Llama 3.1 70B",       provider: "Meta",      note: "Fast open-source" },
  { id: "meta-llama/llama-3.3-70b-instruct",     label: "Llama 3.3 70B",       provider: "Meta",      note: "" },
  { id: "mistralai/mistral-large",               label: "Mistral Large",       provider: "Mistral",   note: "" },
  { id: "mistralai/mistral-small",               label: "Mistral Small",       provider: "Mistral",   note: "Fast & cheap" },
  { id: "google/gemini-pro-1.5",                 label: "Gemini 1.5 Pro",      provider: "Google",    note: "" },
  { id: "google/gemini-flash-1.5",               label: "Gemini 1.5 Flash",    provider: "Google",    note: "Fast" },
  { id: "google/gemini-2.0-flash-001",           label: "Gemini 2.0 Flash",    provider: "Google",    note: "Latest" },
];

// ── Provider badge colours ─────────────────────────────────────────────────────

const PROVIDER_COLOURS: Record<string, string> = {
  DeepSeek:  "bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300",
  OpenAI:    "bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300",
  Anthropic: "bg-orange-100 dark:bg-orange-900/40 text-orange-700 dark:text-orange-300",
  Meta:      "bg-purple-100 dark:bg-purple-900/40 text-purple-700 dark:text-purple-300",
  Mistral:   "bg-rose-100 dark:bg-rose-900/40 text-rose-700 dark:text-rose-300",
  Google:    "bg-cyan-100 dark:bg-cyan-900/40 text-cyan-700 dark:text-cyan-300",
};

function providerColour(provider: string): string {
  return PROVIDER_COLOURS[provider] ?? "bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300";
}

// ── Panel component ───────────────────────────────────────────────────────────

export function LLMSelector({ onClose }: { onClose: () => void }) {
  const defaultModel = MODELS[0].id;
  const [current,   setCurrent]   = useState<string>(defaultModel);
  const [selected,  setSelected]  = useState<string>(defaultModel);
  const [custom,    setCustom]    = useState<string>("");
  const [useCustom, setUseCustom] = useState(false);
  const [saving,    setSaving]    = useState(false);
  const [status,    setStatus]    = useState<{ ok: boolean; msg: string } | null>(null);

  // Fetch the active model from the agent API (best-effort — dropdown still works if offline)
  useEffect(() => {
    fetch(`${API}/settings/llm`)
      .then(r => r.json())
      .then(data => {
        if (!data.model) return;
        setCurrent(data.model);
        const inCatalogue = MODELS.some(m => m.id === data.model);
        if (inCatalogue) {
          setSelected(data.model);
        } else {
          setCustom(data.model);
          setUseCustom(true);
        }
      })
      .catch(() => { /* agent offline — silently use defaults */ });
  }, []);

  // Group models by provider
  const providers = Array.from(new Set(MODELS.map(m => m.provider)));

  async function handleApply() {
    const model = useCustom ? custom.trim() : selected;
    if (!model) return;
    setSaving(true);
    setStatus(null);
    try {
      const res  = await fetch(`${API}/settings/llm`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ model }),
      });
      const data = await res.json();
      if (!res.ok) {
        setStatus({ ok: false, msg: data.error ?? "Failed to update model" });
      } else {
        setCurrent(data.model);
        setStatus({ ok: true, msg: `Active model: ${data.model}` });
      }
    } catch {
      setStatus({ ok: false, msg: "Network error — is the agent running?" });
    } finally {
      setSaving(false);
    }
  }

  const effectiveModel = useCustom ? custom.trim() : selected;
  const changed        = effectiveModel !== current && effectiveModel !== "";
  const selectedMeta   = MODELS.find(m => m.id === selected);

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Panel */}
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none">
        <div className="pointer-events-auto w-full max-w-lg bg-white dark:bg-gray-900 rounded-2xl shadow-2xl border border-gray-200 dark:border-gray-700 overflow-hidden">

          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 dark:border-gray-800">
            <div>
              <h2 className="text-base font-bold text-gray-900 dark:text-gray-100">🤖 Choose LLM</h2>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                Powered by <span className="font-semibold text-indigo-600 dark:text-indigo-400">OpenRouter</span>
              </p>
            </div>
            <button
              onClick={onClose}
              aria-label="Close"
              className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 text-xl leading-none transition-colors"
            >
              ✕
            </button>
          </div>

          <div className="px-6 py-5 space-y-5">

            {/* Current model badge */}
            {current && (
              <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
                <span>Currently active:</span>
                <span className="font-mono font-semibold text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-800 px-2 py-0.5 rounded">
                  {current}
                </span>
              </div>
            )}

            {/* Catalogue selector */}
            {!useCustom && (
              <div className="space-y-2">
                <label className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider block">
                  Model
                </label>
                <select
                  value={selected}
                  onChange={e => setSelected(e.target.value)}
                  className="w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                >
                  {providers.map(provider => (
                    <optgroup key={provider} label={provider}>
                      {MODELS
                        .filter(m => m.provider === provider)
                        .map(m => (
                          <option key={m.id} value={m.id}>
                            {m.label}{m.note ? ` — ${m.note}` : ""}
                          </option>
                        ))}
                    </optgroup>
                  ))}
                </select>

                {/* Selected model metadata */}
                {selectedMeta && (
                  <div className="flex items-center gap-2 pt-1">
                    <span className={`text-[10px] font-bold px-2 py-0.5 rounded uppercase tracking-wider ${providerColour(selectedMeta.provider)}`}>
                      {selectedMeta.provider}
                    </span>
                    <span className="font-mono text-xs text-gray-400 dark:text-gray-500 truncate">
                      {selectedMeta.id}
                    </span>
                  </div>
                )}
              </div>
            )}

            {/* Custom model input */}
            {useCustom && (
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider block">
                  Custom OpenRouter Model ID
                </label>
                <input
                  type="text"
                  value={custom}
                  onChange={e => setCustom(e.target.value)}
                  placeholder="e.g. x-ai/grok-2-1212"
                  spellCheck={false}
                  className="w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 px-3 py-2.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
                <p className="text-[11px] text-gray-400 dark:text-gray-500">
                  Any model listed at openrouter.ai/models works here.
                </p>
              </div>
            )}

            {/* Toggle custom/catalogue */}
            <button
              onClick={() => { setUseCustom(v => !v); setStatus(null); }}
              className="text-xs text-indigo-600 dark:text-indigo-400 underline"
            >
              {useCustom ? "← Back to catalogue" : "Enter a custom model ID →"}
            </button>

            {/* Status */}
            {status && (
              <div className={`rounded-lg px-3 py-2.5 text-xs font-medium ${
                status.ok
                  ? "bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 text-green-700 dark:text-green-400"
                  : "bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-400"
              }`}>
                {status.ok ? "✓ " : "✗ "}{status.msg}
              </div>
            )}

            {/* Action buttons */}
            <div className="flex gap-3 pt-1">
              <button
                onClick={handleApply}
                disabled={!changed || saving || !effectiveModel}
                className="flex-1 py-2.5 rounded-xl font-semibold text-sm transition-colors bg-indigo-600 hover:bg-indigo-700 text-white disabled:bg-gray-200 dark:disabled:bg-gray-700 disabled:text-gray-400 dark:disabled:text-gray-500 disabled:cursor-not-allowed"
              >
                {saving ? "Applying…" : changed ? `Apply — ${effectiveModel.split("/")[1] ?? effectiveModel}` : "No changes"}
              </button>
              <button
                onClick={onClose}
                className="px-4 py-2.5 rounded-xl font-semibold text-sm border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
