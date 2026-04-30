// Mutable singleton — both LLMClient and ReflectionAgent read this at call time.
// Updated at runtime via POST /settings/llm.

let currentModel = process.env.LLM_MODEL ?? "deepseek/deepseek-chat-v3-0324";

export function getModel(): string           { return currentModel; }
export function setModel(model: string): void { currentModel = model; }

// ── Curated model catalogue (surfaced to the frontend) ────────────────────────

export interface ModelEntry {
  id:       string;
  label:    string;
  provider: string;
  note:     string;
}

export const AVAILABLE_MODELS: ModelEntry[] = [
  // DeepSeek
  { id: "deepseek/deepseek-chat-v3-0324",       label: "DeepSeek V3",          provider: "DeepSeek",  note: "Default — fast & cost-efficient" },
  { id: "deepseek/deepseek-r1",                  label: "DeepSeek R1",           provider: "DeepSeek",  note: "Chain-of-thought reasoning" },
  { id: "deepseek/deepseek-r1-distill-llama-70b",label: "DeepSeek R1 Distill",  provider: "DeepSeek",  note: "R1 reasoning, faster" },
  // OpenAI
  { id: "openai/gpt-4o",                         label: "GPT-4o",               provider: "OpenAI",    note: "" },
  { id: "openai/gpt-4o-mini",                    label: "GPT-4o Mini",          provider: "OpenAI",    note: "Fast & cheap" },
  { id: "openai/gpt-4-turbo",                    label: "GPT-4 Turbo",          provider: "OpenAI",    note: "" },
  { id: "openai/o1-mini",                        label: "o1 Mini",              provider: "OpenAI",    note: "Reasoning" },
  // Anthropic
  { id: "anthropic/claude-3.5-sonnet",           label: "Claude 3.5 Sonnet",    provider: "Anthropic", note: "" },
  { id: "anthropic/claude-3.5-haiku",            label: "Claude 3.5 Haiku",     provider: "Anthropic", note: "Fast & cheap" },
  { id: "anthropic/claude-3-opus",               label: "Claude 3 Opus",        provider: "Anthropic", note: "Most capable" },
  // Meta
  { id: "meta-llama/llama-3.1-405b-instruct",    label: "Llama 3.1 405B",       provider: "Meta",      note: "Open-source flagship" },
  { id: "meta-llama/llama-3.1-70b-instruct",     label: "Llama 3.1 70B",        provider: "Meta",      note: "Fast open-source" },
  { id: "meta-llama/llama-3.3-70b-instruct",     label: "Llama 3.3 70B",        provider: "Meta",      note: "" },
  // Mistral
  { id: "mistralai/mistral-large",               label: "Mistral Large",        provider: "Mistral",   note: "" },
  { id: "mistralai/mistral-small",               label: "Mistral Small",        provider: "Mistral",   note: "Fast & cheap" },
  // Google
  { id: "google/gemini-pro-1.5",                 label: "Gemini 1.5 Pro",       provider: "Google",    note: "" },
  { id: "google/gemini-flash-1.5",               label: "Gemini 1.5 Flash",     provider: "Google",    note: "Fast" },
  { id: "google/gemini-2.0-flash-001",           label: "Gemini 2.0 Flash",     provider: "Google",    note: "Latest" },
];
