/**
 * Operator /broadcast command: send a message to all configured chats.
 *
 * Usage: /broadcast <message text>
 *
 * Flow:
 *  1. Operator sends `/broadcast Hello everyone`.
 *  2. The bot replies with a confirmation message bearing two inline buttons:
 *     "✅ Confirm" and "❌ Cancel". The buttons carry callback data of the form
 *     "broadcast:confirm:<token>" and "broadcast:cancel:<token>".
 *  3. The token is a short random id tied to a pending broadcast entry in an
 *     in-memory table, bounded by MAX_PENDING_BROADCASTS.
 *  4. When the operator presses a button:
 *     - Confirm: the message is sent to all configured chats and the
 *       confirmation message is edited to show the outcome.
 *     - Cancel: the pending broadcast is removed and the confirmation message
 *       is edited to show it was cancelled.
 *  5. If the confirmation message was deleted before the button was pressed,
 *     handleCallbackQuery() catches the error, clears the spinner, and sends a
 *     fallback reply. The state transition (send / cancel) does not repeat.
 *  6. After the first button press the pending entry is consumed (removed from
 *     the table). A second press of the same token finds no entry and is a
 *     no-op — the confirmation message was already edited and the action ran.
 *
 * The in-memory table is intentionally ephemeral: a process restart discards
 * all pending broadcasts. Operators who need durability should restart with
 * enough time for confirmations to be acted on before the process exits.
 *
 * Security: only the configured operator (OPERATOR_TELEGRAM_USER_ID) may
 * invoke /broadcast or act on its confirmation buttons. Non-operator callbacks
 * are silently ignored. Token guessing is infeasible at 48 bits of randomness.
 */

import { randomBytes } from "node:crypto";

import type { Bot } from "grammy";

import { handleCallbackQuery, type CallbackContext } from "../callbacks.js";
import type { BotConfig } from "../config.js";
import { safeErrorMessage } from "../notifications/format.js";

/** Maximum concurrent pending broadcast confirmations. Oldest evicted first. */
const MAX_PENDING_BROADCASTS = 20;

/** Callback data prefix for this command's buttons. */
const BROADCAST_PREFIX = "broadcast:";

/** Tokens are 6 random bytes encoded as hex (12 hex chars, 48 bits). */
function newToken(): string {
  return randomBytes(6).toString("hex");
}

export interface PendingBroadcast {
  token: string;
  text: string;
  chatIds: string[];
  operatorChatId: number;
}

/**
 * Bounded in-memory store for pending broadcast confirmations.
 *
 * Uses insertion order to evict oldest entries when the cap is reached. Tokens
 * are single-use: once consumed (confirmed or cancelled) the entry is removed
 * and a repeated callback for the same token is a no-op.
 */
export class PendingBroadcastStore {
  private readonly entries = new Map<string, PendingBroadcast>();
  private readonly max: number;

  constructor(max = MAX_PENDING_BROADCASTS) {
    this.max = max;
  }

  add(entry: PendingBroadcast): void {
    if (this.entries.size >= this.max) {
      // Evict the oldest entry (insertion-order first key).
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey !== undefined) this.entries.delete(oldestKey);
    }
    this.entries.set(entry.token, entry);
  }

  consume(token: string): PendingBroadcast | undefined {
    const entry = this.entries.get(token);
    if (entry) this.entries.delete(token);
    return entry;
  }

  size(): number {
    return this.entries.size;
  }
}

export interface BroadcastDeps {
  config: BotConfig;
  /**
   * Chat ids to send the broadcast to. Defaults to all configured chats
   * (chatId, marketChatId, squadChatId) deduplicated. Provided here so tests
   * can supply a simple override without constructing a full config.
   */
  targetChatIds?: string[] | undefined;
  store?: PendingBroadcastStore | undefined;
  /**
   * The API method used to send messages to target chats. Defaults to
   * bot.api.sendMessage. Injected in tests to avoid real Telegram calls.
   */
  sendMessage?: ((chatId: string, text: string) => Promise<unknown>) | undefined;
}

/**
 * Derive the list of target chats from the config, deduplicated, in a
 * consistent order. marketChatId and squadChatId override the fallback chatId
 * per contract, so each distinct value is included once.
 */
export function targetChatIds(config: BotConfig): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const id of [config.chatId, config.marketChatId, config.squadChatId]) {
    if (id && !seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

function isOperatorUser(ctx: { from?: { id: number } | undefined }, config: BotConfig): boolean {
  const operatorId = config.operatorTelegramUserId;
  return operatorId !== null && ctx.from?.id.toString() === operatorId;
}

/** Build the inline keyboard for a pending broadcast confirmation. */
function confirmKeyboard(token: string) {
  return {
    inline_keyboard: [
      [
        { text: "✅ Confirm", callback_data: `${BROADCAST_PREFIX}confirm:${token}` },
        { text: "❌ Cancel", callback_data: `${BROADCAST_PREFIX}cancel:${token}` },
      ],
    ],
  };
}

/**
 * Register the /broadcast command and its callback handler on `bot`.
 *
 * Both the command and the callback handler enforce operator-only access.
 * The callback handler uses `handleCallbackQuery` so a deleted confirmation
 * message is recovered without leaving the spinner stuck.
 */
export function registerBroadcastCommand(bot: Bot, deps: BroadcastDeps): void {
  const { config } = deps;
  const store = deps.store ?? new PendingBroadcastStore();

  async function sendToTargets(
    text: string,
    chatIds: string[],
    send: (chatId: string, text: string) => Promise<unknown>,
  ): Promise<{ sent: number; failed: number }> {
    let sent = 0;
    let failed = 0;
    for (const chatId of chatIds) {
      try {
        await send(chatId, text);
        sent += 1;
      } catch (err: unknown) {
        console.warn(
          `[broadcast] send to chat ${chatId} failed: ${safeErrorMessage(err, [config.botToken])}`,
        );
        failed += 1;
      }
    }
    return { sent, failed };
  }

  bot.command("broadcast", async (ctx) => {
    if (!isOperatorUser(ctx, config)) {
      console.warn(`[broadcast] ignored unauthorized /broadcast on update ${ctx.update.update_id}`);
      return;
    }

    const text = ctx.message?.text ?? "";
    const spaceIndex = text.indexOf(" ");
    const broadcastText = spaceIndex !== -1 ? text.slice(spaceIndex + 1).trim() : "";

    if (!broadcastText) {
      await ctx.reply("Usage: /broadcast <message text>");
      return;
    }

    const chatIds = deps.targetChatIds ?? targetChatIds(config);
    if (chatIds.length === 0) {
      await ctx.reply("No target chats configured.");
      return;
    }

    const token = newToken();
    const entry: PendingBroadcast = {
      token,
      text: broadcastText,
      chatIds,
      operatorChatId: ctx.chat.id,
    };
    store.add(entry);

    const preview = Array.from(broadcastText).slice(0, 80).join("");
    const previewSuffix = Array.from(broadcastText).length > 80 ? "…" : "";
    const chatCount = chatIds.length;
    await ctx.reply(
      `Broadcast to ${chatCount} chat${chatCount === 1 ? "" : "s"}:\n\n"${preview}${previewSuffix}"\n\nConfirm or cancel?`,
      {
        reply_markup: confirmKeyboard(token),
        link_preview_options: { is_disabled: true },
      },
    );
  });

  // The callback handler is registered separately so bot.ts can use
  // registerCallbackHandler() to route all callback_query updates through
  // handleCallbackQuery in one place. Here we export the per-data handler
  // that registerCallbackHandler calls when the prefix matches.
  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data ?? "";
    if (!data.startsWith(BROADCAST_PREFIX)) return;

    if (!isOperatorUser(ctx, config)) {
      console.warn(
        `[broadcast] ignored unauthorized callback on update ${ctx.update.update_id}`,
      );
      await ctx.answerCallbackQuery({ text: "Not authorised.", show_alert: false }).catch(() => undefined);
      return;
    }

    await handleCallbackQuery(
      ctx as unknown as CallbackContext,
      async (_data) => {
        const parts = data.slice(BROADCAST_PREFIX.length).split(":");
        const action = parts[0];
        const token = parts.slice(1).join(":");

        if (action === "confirm") {
          const entry = store.consume(token);
          if (!entry) {
            // Already acted on or token evicted — acknowledge and move on.
            await ctx.answerCallbackQuery({ text: "Already actioned.", show_alert: false });
            await ctx.editMessageText("Broadcast already actioned.").catch(() => undefined);
            return;
          }

          const send = deps.sendMessage ?? ((chatId, text) => ctx.api.sendMessage(chatId, text));
          const { sent, failed } = await sendToTargets(entry.text, entry.chatIds, send);
          const summary =
            failed === 0
              ? `Broadcast sent to ${sent} chat${sent === 1 ? "" : "s"}.`
              : `Broadcast sent to ${sent} chat${sent === 1 ? "" : "s"}, ${failed} failed.`;

          await ctx.answerCallbackQuery({ text: "Sent.", show_alert: false });
          await ctx.editMessageText(summary);
        } else if (action === "cancel") {
          store.consume(token);
          await ctx.answerCallbackQuery({ text: "Cancelled.", show_alert: false });
          await ctx.editMessageText("Broadcast cancelled.");
        } else {
          // Unknown action — acknowledge without acting.
          await ctx.answerCallbackQuery({ show_alert: false });
        }
      },
      {
        deletedToast: "Confirmation message was deleted. No broadcast was sent.",
        deletedFallbackReply: "The broadcast confirmation message was deleted. No broadcast was sent. Use /broadcast again to retry.",
      },
    );
  });
}
