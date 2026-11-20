/**
 * Callback query handling with graceful deleted-message recovery.
 *
 * When an operator presses a confirmation button after the original message
 * has been deleted, Telegram returns a 400 error rather than the callback. The
 * spinner on the client stays stuck and no action fires. This module wraps
 * callback handlers so that case is recovered:
 *
 *  1. The wrapped handler runs first. If it succeeds, the callback is answered
 *     normally and nothing else happens.
 *  2. If the handler (or anything after it) calls ctx.editMessageText() and the
 *     message is gone, Telegram returns a 400 "message to edit not found" or
 *     "message can't be edited" error. That error is caught here.
 *  3. The callback is answered via answerCallbackQuery with a bounded toast so
 *     the client spinner clears. If the caller supplied fallback text, a new
 *     ctx.reply() is sent so the outcome is still visible in the chat.
 *  4. All other errors propagate unchanged so the bot's error handler sees them.
 *
 * The handler itself is responsible for state transitions. It runs at most once
 * per callback invocation, so a deleted message does not trigger a double-action.
 *
 * Usage:
 *
 *   bot.on("callback_query:data", async (ctx) => {
 *     await handleCallbackQuery(ctx, async (data) => {
 *       // ... handle the action ...
 *       await ctx.editMessageText("Done");  // may throw if message was deleted
 *     });
 *   });
 */

import type { Context } from "grammy";

import { safeErrorMessage } from "./notifications/format.js";

/**
 * Maximum characters for the toast text shown via answerCallbackQuery.
 * Telegram caps the `text` field at 200 characters.
 */
const CALLBACK_TOAST_MAX = 200;

/**
 * Telegram error descriptions that indicate the original message was deleted
 * before the callback could be answered. Matched case-insensitively against
 * the error description.
 */
const DELETED_MESSAGE_PATTERNS = [
  /message to edit not found/i,
  /message can't be edited/i,
  /message to delete not found/i,
];

/**
 * Returns true when the error is a Telegram 400 "deleted message" response.
 *
 * grammy surfaces Bot API failures as `GrammyError` with numeric `error_code`
 * and string `description`. Duck-typed objects carrying the same Telegram
 * description (e.g. mocks) are also matched when no numeric `error_code` is
 * present and the phrasing fits.
 */
export function isDeletedMessageError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const record = err as { error_code?: unknown; description?: unknown; message?: unknown };
  const text = [record.description, record.message]
    .filter((part): part is string => typeof part === "string" && part !== "")
    .join(" ");
  if (!DELETED_MESSAGE_PATTERNS.some((re) => re.test(text))) return false;
  if (typeof record.error_code === "number") return record.error_code === 400;
  return true;
}

/** Clip text to the Telegram answerCallbackQuery toast limit. */
function clipToast(text: string): string {
  const characters = Array.from(text);
  return characters.length <= CALLBACK_TOAST_MAX
    ? text
    : `${characters.slice(0, CALLBACK_TOAST_MAX - 1).join("")}…`;
}

export interface CallbackHandlerOptions {
  /**
   * Short text shown as a toast notification when the original message was
   * deleted and the handler failed with a deleted-message error.
   * Clipped to Telegram's 200-character limit. Defaults to a generic message.
   */
  deletedToast?: string | undefined;
  /**
   * Optional text sent as a new message (ctx.reply) when the original message
   * was deleted. If omitted, only the answerCallbackQuery toast is sent.
   * Bounded: clipped to 4000 characters before sending.
   */
  deletedFallbackReply?: string | undefined;
}

/**
 * A callback query context surface used by the wrapper. Narrowed to what the
 * wrapper actually needs so tests can supply a minimal stub.
 */
export interface CallbackContext {
  callbackQuery: { data?: string | undefined; id?: string | undefined };
  answerCallbackQuery(opts?: { text?: string; show_alert?: boolean }): Promise<unknown>;
  reply(text: string, opts?: { link_preview_options?: { is_disabled?: boolean } }): Promise<unknown>;
}

/**
 * Wraps a callback handler to recover gracefully when the original message
 * was deleted before the callback fired.
 *
 * The `handler` receives the raw callback data string (or an empty string when
 * `ctx.callbackQuery.data` is absent). It runs exactly once per invocation.
 * If a "deleted message" error surfaces anywhere during handler execution or
 * message editing, the callback spinner is cleared and an optional fallback
 * reply is sent.
 *
 * @param ctx     A grammy Context (or compatible stub) for a callback_query update.
 * @param handler The action to perform; receives the callback data string.
 * @param opts    Optional toast text and fallback reply for the deleted-message path.
 */
export async function handleCallbackQuery(
  ctx: CallbackContext,
  handler: (data: string) => Promise<void>,
  opts: CallbackHandlerOptions = {},
): Promise<void> {
  const data = ctx.callbackQuery.data ?? "";
  try {
    await handler(data);
  } catch (err: unknown) {
    if (!isDeletedMessageError(err)) {
      throw err;
    }
    // The original message is gone. Clear the spinner and, if the caller gave
    // us fallback text, post it as a new message so the outcome is visible.
    const toast = clipToast(
      opts.deletedToast ?? "The confirmation message was deleted. No action taken.",
    );
    try {
      await ctx.answerCallbackQuery({ text: toast, show_alert: false });
    } catch (ackErr: unknown) {
      // Answering a callback can fail if the callback_query_id already expired
      // (Telegram rejects acks older than ~60 s). Log and move on so the
      // fallback reply still fires.
      console.warn(
        `[callbacks] answerCallbackQuery failed after deleted-message recovery: ` +
          safeErrorMessage(ackErr),
      );
    }
    if (opts.deletedFallbackReply) {
      const reply = Array.from(opts.deletedFallbackReply).slice(0, 4000).join("");
      try {
        await ctx.reply(reply, { link_preview_options: { is_disabled: true } });
      } catch (replyErr: unknown) {
        console.warn(
          `[callbacks] fallback reply failed after deleted-message recovery: ` +
            safeErrorMessage(replyErr),
        );
      }
    }
    // Do not rethrow: the error was handled. The bot.catch handler never sees it.
  }
}

/**
 * Wraps a grammy Context for use with handleCallbackQuery. Provided so callers
 * do not need to cast the full grammy Context to CallbackContext themselves.
 */
export function callbackContext(ctx: Context): CallbackContext {
  return ctx as unknown as CallbackContext;
}
