/**
 * TelegramNotifier — fire-and-forget Telegram Bot API helper.
 *
 * Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env to enable.
 * TELEGRAM_CHAT_ID accepts a single ID or a comma-separated list —
 * every message is broadcast to all recipients in parallel.
 *
 * Examples:
 *   TELEGRAM_CHAT_ID=6272037379                          # personal DM only
 *   TELEGRAM_CHAT_ID=-1003983195163                      # channel only
 *   TELEGRAM_CHAT_ID=6272037379,-1003983195163           # both
 */

const BOT_TOKEN  = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_IDS: string[] = (process.env.TELEGRAM_CHAT_ID ?? "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

class TelegramNotifier {
  private configured = !!(BOT_TOKEN && CHAT_IDS.length > 0);

  async send(text: string): Promise<void> {
    if (!this.configured) return;
    // Telegram hard limit is 4096 chars per message
    const body = text.length > 4096 ? text.slice(0, 4090) + "…" : text;
    await Promise.all(CHAT_IDS.map(async chatId => {
      try {
        const res = await fetch(
          `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
          {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body:    JSON.stringify({ chat_id: chatId, text: body }),
          },
        );
        if (!res.ok) {
          const err = await res.text();
          console.warn(`[Telegram] chat ${chatId} — API error ${res.status}: ${err.slice(0, 120)}`);
        }
      } catch (err: any) {
        console.warn(`[Telegram] chat ${chatId} — send failed: ${err.message}`);
      }
    }));
  }
}

export const telegram = new TelegramNotifier();
