import { log } from "./log";

export interface InlineButton {
  text: string;
  callback_data: string;
}

export type Keyboard = InlineButton[][];

/** Minimal Telegram-klient. Alle meldinger sendes som HTML. */
export class Telegram {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async call<T>(method: string, body: Record<string, unknown>): Promise<T> {
    const res = await this.fetchImpl(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as { ok: boolean; result?: T; description?: string };
    if (!json.ok) {
      // Aldri logg URL-en (inneholder tokenet).
      log("telegram_error", { method, status: res.status, description: json.description });
      throw new Error(`Telegram ${method} feilet: ${json.description ?? res.status}`);
    }
    return json.result as T;
  }

  async sendMessage(chatId: string | number, text: string, keyboard?: Keyboard, replyTo?: number): Promise<number> {
    const chunks = splitMessage(text);
    let lastId = 0;
    for (let i = 0; i < chunks.length; i++) {
      const isLast = i === chunks.length - 1;
      const msg = await this.call<{ message_id: number }>("sendMessage", {
        chat_id: chatId,
        text: chunks[i],
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        ...(isLast && keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
        ...(i === 0 && replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}),
      });
      lastId = msg.message_id;
    }
    return lastId;
  }

  async editMessage(chatId: string | number, messageId: number, text: string, keyboard?: Keyboard): Promise<void> {
    try {
      await this.call("editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text: splitMessage(text)[0],
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        reply_markup: { inline_keyboard: keyboard ?? [] },
      });
    } catch {
      // Uendret tekst eller for gammel melding – ikke kritisk.
    }
  }

  async removeKeyboard(chatId: string | number, messageId: number): Promise<void> {
    try {
      await this.call("editMessageReplyMarkup", {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: { inline_keyboard: [] },
      });
    } catch {
      // ignorer
    }
  }

  async answerCallback(callbackId: string, text?: string): Promise<void> {
    try {
      await this.call("answerCallbackQuery", { callback_query_id: callbackId, ...(text ? { text } : {}) });
    } catch {
      // ignorer
    }
  }

  async sendChatAction(chatId: string | number, action: "typing" | "upload_document"): Promise<void> {
    try {
      await this.call("sendChatAction", { chat_id: chatId, action });
    } catch {
      // ignorer
    }
  }

  async downloadFile(fileId: string): Promise<{ bytes: Uint8Array; path: string }> {
    const file = await this.call<{ file_path?: string; file_size?: number }>("getFile", { file_id: fileId });
    if (!file.file_path) throw new Error("Telegram returnerte ingen filsti");
    const res = await this.fetchImpl(`https://api.telegram.org/file/bot${this.token}/${file.file_path}`);
    if (!res.ok) throw new Error(`Nedlasting feilet (${res.status})`);
    return { bytes: new Uint8Array(await res.arrayBuffer()), path: file.file_path };
  }
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Deler lange meldinger på linjeskift (Telegram-grense: 4096 tegn). */
export function splitMessage(text: string, limit = 4000): string[] {
  if (text.length <= limit) return [text];
  const out: string[] = [];
  let current = "";
  for (const line of text.split("\n")) {
    if ((current + "\n" + line).length > limit && current) {
      out.push(current);
      current = line;
    } else {
      current = current ? `${current}\n${line}` : line;
    }
    while (current.length > limit) {
      out.push(current.slice(0, limit));
      current = current.slice(limit);
    }
  }
  if (current) out.push(current);
  return out;
}
