/**
 * ReflectionAgent — runs every hour, asks the LLM to reflect on current
 * yield opportunities and portfolio performance, streams tokens via an
 * EventEmitter (consumed by the SSE endpoint), and persists each
 * reflection to SQLite + 0G decentralised storage for future context.
 */

import { EventEmitter } from "events";
import OpenAI from "openai";
import type { ReporterAgent }   from "../ReporterAgent";
import type { PortfolioManager } from "../PortfolioManager";
import { ReflectionStore }      from "../storage/ReflectionStore";
import { ZeroGMemory }          from "../storage/ZeroGMemory";

const MODEL               = process.env.LLM_MODEL    ?? "deepseek/deepseek-chat-v3-0324";
const REFLECT_INTERVAL_MS = Number(process.env.REFLECT_INTERVAL_MS ?? 60 * 60 * 1000);
const MAX_TOKENS          = 350;

export interface ReflectionEvent {
  type:       "start" | "chunk" | "complete" | "error" | "keepalive";
  timestamp:  number;
  text?:      string;   // chunk
  content?:   string;   // complete
  summary?:   string;   // complete
  id?:        number;   // complete (SQLite row id)
  error?:     string;   // error
}

export class ReflectionAgent {
  private emitter  = new EventEmitter();
  private store    = new ReflectionStore();
  private memory   = new ZeroGMemory();
  private client:  OpenAI;
  private running  = false;
  private enabled  = false;

  constructor(
    private reporter:  ReporterAgent,
    private portfolio: PortfolioManager,
  ) {
    // Set enabled immediately from key presence so SSE history sends correct state
    this.enabled = !!process.env.OPENROUTER_API_KEY;
    this.client = new OpenAI({
      baseURL: "https://openrouter.ai/api/v1",
      apiKey:  process.env.OPENROUTER_API_KEY ?? "",
      defaultHeaders: {
        "HTTP-Referer": "https://github.com/utk-dwd/earnlab",
        "X-Title":      "EarnYld Reflection Agent",
      },
    });
  }

  async start(): Promise<void> {
    if (!process.env.OPENROUTER_API_KEY) {
      console.log("[Reflection] OPENROUTER_API_KEY not set — disabled");
      return;
    }
    await this.memory.init();
    this.running = true;
    console.log(`[Reflection] Starting — interval ${REFLECT_INTERVAL_MS / 60_000}min`);

    // Run immediately, then on interval
    await this.reflect();
    const iv = setInterval(async () => {
      if (!this.running) { clearInterval(iv); return; }
      await this.reflect();
    }, REFLECT_INTERVAL_MS);
  }

  stop(): void { this.running = false; }

  isEnabled(): boolean { return this.enabled; }

  getStore(): ReflectionStore { return this.store; }

  // Typed subscription helpers for the SSE layer
  onEvent(listener: (evt: ReflectionEvent) => void): () => void {
    const handler = (evt: ReflectionEvent) => listener(evt);
    this.emitter.on("event", handler);
    return () => this.emitter.off("event", handler);
  }

  private emit(evt: ReflectionEvent): void {
    this.emitter.emit("event", evt);
  }

  // ─── Core reflection ───────────────────────────────────────────────────────

  private async reflect(): Promise<void> {
    const ts = Date.now();
    console.log(`[Reflection] Generating at ${new Date(ts).toISOString()}`);
    this.emit({ type: "start", timestamp: ts });

    try {
      const messages = this.buildMessages();
      let fullContent = "";

      const stream = await this.client.chat.completions.create({
        model:      MODEL,
        messages,
        stream:     true,
        max_tokens: MAX_TOKENS,
      });

      for await (const chunk of stream) {
        const text = chunk.choices[0]?.delta?.content ?? "";
        if (text) {
          fullContent += text;
          this.emit({ type: "chunk", timestamp: ts, text });
        }
      }

      // First non-empty line as compact summary
      const summary = fullContent.split("\n").map(l => l.trim()).find(l => l) ?? fullContent.slice(0, 150);

      const id = this.store.insert(fullContent, summary);

      this.emit({ type: "complete", timestamp: ts, content: fullContent, summary, id });
      console.log(`[Reflection] Done — ${fullContent.length} chars, id=${id}`);
    } catch (err: any) {
      console.warn(`[Reflection] Failed: ${err.message}`);
      this.emit({ type: "error", timestamp: ts, error: err.message });
    }
  }

  // ─── Prompt construction ───────────────────────────────────────────────────

  private buildMessages(): OpenAI.Chat.ChatCompletionMessageParam[] {
    const opps = this.reporter.getLatest()
      .filter(o => o.displayAPY > 0)
      .sort((a, b) => (b.netAPY ?? b.displayAPY) - (a.netAPY ?? a.displayAPY))
      .slice(0, 10)
      .map(o => {
        const il  = o.expectedIL > 0 ? ` IL=${o.expectedIL.toFixed(1)}%` : "";
        const net = o.expectedIL > 0 ? ` net=${o.netAPY.toFixed(1)}%` : "";
        return `${o.pair} ${o.chainName} feeAPY=${o.displayAPY.toFixed(1)}%${net}${il} RAR7d=${o.rar7d > 0 ? o.rar7d.toFixed(2) : "n/a"} TVL=${fmtUsd(o.tvlUsd)} Δ7d=${(o.pairPriceChange7d * 100).toFixed(1)}%`;
      })
      .join("; ");

    const summary   = this.portfolio.getSummary();
    const positions = this.portfolio.getPositions()
      .filter(p => p.status === "open")
      .map(p =>
        `${p.pair}@${p.chainName} $${p.entryValueUsd.toFixed(0)} APY=${p.entryAPY.toFixed(1)}% RAR7d=${p.entryRAR7d.toFixed(2)} held=${fmtHours(p.hoursHeld)} PnL=$${p.pnlUsd.toFixed(2)}`
      )
      .join("; ");

    const closedPositions = this.portfolio.getPositions()
      .filter(p => p.status === "closed")
      .slice(0, 5)
      .map(p =>
        `${p.pair}@${p.chainName} closed PnL=$${p.pnlUsd.toFixed(2)} reason="${p.closeReason ?? ""}"`
      )
      .join("; ");

    const memory = this.store.getCompactMemory(15);

    const system = `You are EarnYld's market analyst. Reflect on Uniswap v4 yield opportunities and portfolio performance.

Style rules:
- 1-2 sentences if nothing has changed or is noteworthy
- Up to 5 sentences with reasoning if there are significant opportunities, risks, or position changes
- No bullet points, no headers, no markdown formatting
- Be specific — name pairs, chains, numbers
- Lead with the strongest signal`;

    const user = [
      `Hourly reflection — ${new Date().toUTCString()}`,
      ``,
      `TOP OPPORTUNITIES: ${opps || "none enriched yet"}`,
      ``,
      `PORTFOLIO: cash=$${summary.cashUsd.toFixed(0)} invested=$${summary.investedUsd.toFixed(0)} unrealisedPnL=$${summary.unrealizedPnlUsd.toFixed(2)} realisedPnL=$${summary.realizedPnlUsd.toFixed(2)} lpFees=$${summary.totalEarnedFeesUsd.toFixed(2)} swapFeesPaid=$${summary.totalFeesPaidUsd.toFixed(2)}`,
      positions     ? `OPEN: ${positions}`    : `OPEN: none`,
      closedPositions ? `RECENTLY CLOSED: ${closedPositions}` : "",
      memory        ? `\nPAST REFLECTIONS:\n${memory}` : "",
    ].filter(Boolean).join("\n");

    return [
      { role: "system", content: system },
      { role: "user",   content: user   },
    ];
  }
}

function fmtUsd(n: number) {
  if (!n) return "$0";
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

function fmtHours(h: number) {
  if (h < 1)  return `${Math.round(h * 60)}m`;
  if (h < 24) return `${h.toFixed(1)}h`;
  return `${(h / 24).toFixed(1)}d`;
}
