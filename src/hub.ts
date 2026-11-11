/**
 * The deployment's one Telegram bot. A single Durable Object (`getByName("bot")`) holds what a bot
 * has one of: its token (read from the TELEGRAM_BOT_TOKEN secret, never stored or returned), its
 * webhook, and every chat and message it keeps. It records which Workshop account each chat
 * belongs to, and serves each account its own chats alone.
 *
 * A chat belongs to the account that linked it: a private chat when its person opens the link
 * code a Telegram connect page shows and presses Start; a group when a linked person adds the bot
 * with the "Add to a group" button or sends `/link` there. A linked chat is still inert: agents
 * reach it only through a connection the user makes in Cloudflare OS. Messages in chats no account
 * linked are neither stored nor delivered; a private chat, or a group message that mentions the
 * bot, is told (at most daily) that the bot is private.
 */

import { DurableObject, type RpcTarget } from "cloudflare:workers";
import { constantTimeEqual, generateNonce } from "@gadgets/gatekeeper-kit/connect-nonce";
import { HookDeliveryQueue, disposeStubs } from "@gadgets/gatekeeper-kit/hook-delivery-queue";
import type { HookInitiator } from "@gadgets/workshop-shared/gatekeeper";
import { createLogger } from "@gadgets/observability/logger";
import { addGroupButton, LINK_CODE_PATTERN, newLinkCode, parseCommand, REPLIES, type BotCommand } from "./commands";
import { chatSubresource } from "./resource";
import {
  deleteMessage,
  downloadFile,
  editButtons,
  editMessage,
  getMe,
  getWebhookUrl,
  messageFile,
  sendMedia,
  sendMessage,
  setReaction,
  setWebhook,
  TelegramError,
  toChatInfo,
  toMessage,
  toUser,
  updateMessage,
  updatePress,
  updateReaction,
  WEBHOOK_VERSION,
  type SendOptions,
  type UploadFile,
  type WireMessage,
  type WireUpdate,
} from "./telegram-api";
import type {
  TelegramBotInfo,
  TelegramButton,
  TelegramButtonPress,
  TelegramReactionChange,
  TelegramChatInfo,
  TelegramFileContent,
  TelegramMessage,
  TelegramMessageHook,
} from "./types";

const logger = createLogger<{ vendorId: string; code: string }>({
  component: "gatekeeper.telegram.hub", vendorId: "telegram",
});

export type HubEnv = Cloudflare.Env & {
  BASE_URL?: string;
  TELEGRAM_BOT_TOKEN?: string;
};

export type TelegramHookTarget = RpcTarget & TelegramMessageHook;

/** A hook registration: every chat of one account, or one of them. */
export type HookRegistration = {
  accountId: string;
  chatId?: string;
  /** Set once a press could not be delivered because the hook has no `receiveButtonPress()`. */
  ignoresPresses?: true;
  /** The same for `receiveReaction()`: such a hook is no longer handed reactions. */
  ignoresReactions?: true;
};

/**
 * What the bot answers a webhook delivery with, sent back as the HTTP response's method call: a
 * message, or the acknowledgement Telegram wants for a button press (until it gets one, the
 * button shows a spinner).
 */
export type WebhookReply =
  | { chatId: string; text: string; button?: { text: string; url: string } }
  | { answerPress: string };

/** A link code, and the deep link that sends it to the bot. */
export type LinkCode = { url: string; code: string; botUsername: string; expiresAt: number };

/** What a hook is handed: a message, a button press (`press`) or a reaction change (`reaction`). */
type Delivery =
  | { message: TelegramMessage; chatTitle: string; press?: never; reaction?: never }
  | { press: TelegramButtonPress; chatTitle: string; reaction?: never }
  | { reaction: TelegramReactionChange; chatTitle: string; press?: never };

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const LINK_CODE_LIFETIME_MS = 15 * MINUTE_MS;
/** How often an unlinked chat is told the bot is private, at most. */
const NOTICE_INTERVAL_MS = DAY_MS;
const MESSAGES_KEPT_PER_CHAT = 1000;


const registrationKey = (key: string) => `reg:${key}`;
const initiatorKey = (key: string) => `caps:${key}`;

/** Whether a message @mentions the bot. */
function mentions(wire: WireMessage, botUsername: string): boolean {
  const text = wire.text ?? wire.caption;
  return text !== undefined && text.toLowerCase().includes(`@${botUsername.toLowerCase()}`);
}

/** Whether an RPC failed because the receiver has no such method, as opposed to the method failing. */
export function isMissingMethod(error: unknown, method = "receiveButtonPress"): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /does not implement|is not a function|no such method|not a function/i.test(message) &&
    message.includes(method);
}

/** Disposes a stub read back from storage, if there was one. */
function disposeStored(stub: unknown): void {
  if (stub !== undefined) disposeStubs({ stub });
}

/** A short fingerprint of the token, so a rotated secret is noticed without storing the token. */
async function tokenFingerprint(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest).slice(0, 8)].map(b => b.toString(16).padStart(2, "0")).join("");
}

type ChatRow = {
  id: string;
  type: TelegramChatInfo["type"];
  title: string;
  username: string | null;
  owner: string | null;
  last_message_at: number;
};

function chatInfoOf(row: ChatRow): TelegramChatInfo {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    ...(row.username ? { username: row.username } : {}),
    lastMessageAt: new Date(row.last_message_at).toISOString(),
  };
}

/** What the bot's setup is checked against: its identity and where its webhook points. */
type Setup = {
  fingerprint: string;
  bot: TelegramBotInfo;
  webhookUrl: string;
  checkedAt: number;
  /** The `WEBHOOK_VERSION` the webhook was registered under; absent before there was one. */
  webhookVersion?: number;
};

export class TelegramBotHub extends DurableObject<HubEnv> {
  #queue = new HookDeliveryQueue<Delivery>(this.ctx.storage.kv, () => {
    logger.warn("dropped a Telegram message after repeated delivery failures", {
      event: "telegram.hooks.delivery.dropped",
    });
  });

  constructor(ctx: DurableObjectState, env: HubEnv) {
    super(ctx, env);
    const sql = ctx.storage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS links (
      telegram_user_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, linked_at INTEGER NOT NULL)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS chats (
      id TEXT PRIMARY KEY, type TEXT NOT NULL, title TEXT NOT NULL, username TEXT, owner TEXT,
      last_message_at INTEGER NOT NULL)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS messages (
      chat_id TEXT NOT NULL, id INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY (chat_id, id))`);
    sql.exec(`CREATE TABLE IF NOT EXISTS codes (
      code TEXT PRIMARY KEY, account_id TEXT NOT NULL, expires_at INTEGER NOT NULL)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS notices (chat_id TEXT PRIMARY KEY, at INTEGER NOT NULL)`);
    // Telegram's id for the file a message carries, kept beside the message and never shown: it is
    // what a later download asks for.
    if (!sql.exec<{ name: string }>("PRAGMA table_info(messages)").toArray().some(column => column.name === "file_id")) {
      sql.exec("ALTER TABLE messages ADD COLUMN file_id TEXT");
    }
    // Left by a version that had groups approved in Cloudflare OS.
    sql.exec("DROP TABLE IF EXISTS group_requests");
  }

  // -- The bot ----------------------------------------------------------------

  #token(): string {
    const token = this.env.TELEGRAM_BOT_TOKEN;
    if (!token) {
      throw new TelegramError("BAD_REQUEST",
        "Telegram isn't set up on this deployment yet: its bot token (TELEGRAM_BOT_TOKEN) is missing.");
    }
    return token;
  }

  #webhookUrl(): string {
    const base = (this.env.BASE_URL ?? "http://localhost:8787/gatekeeper/telegram").replace(/\/+$/, "");
    // Under webhook/ so an Access Bypass for `webhook/*` covers it.
    return `${base}/webhook/bot`;
  }

  #secret(): string {
    let secret = this.ctx.storage.kv.get<string>("secret");
    if (!secret) {
      secret = generateNonce();
      this.ctx.storage.kv.put("secret", secret);
    }
    return secret;
  }

  /**
   * The bot's identity, after making sure its webhook points here. Rechecks with Telegram when the
   * token or webhook URL changed, and once a day, so a webhook something else took over is taken
   * back.
   */
  async ensureSetup(force = false): Promise<TelegramBotInfo> {
    const token = this.#token();
    const fingerprint = await tokenFingerprint(token);
    const webhookUrl = this.#webhookUrl();
    const setup = this.ctx.storage.kv.get<Setup>("setup");
    const current = setup?.webhookVersion === WEBHOOK_VERSION;
    const fresh = setup && current && setup.fingerprint === fingerprint && setup.webhookUrl === webhookUrl &&
      Date.now() - setup.checkedAt < DAY_MS;
    if (fresh && !force) return setup.bot;

    const bot = await getMe(token);
    // Also registered again when the update kinds asked for changed, which the URL does not show.
    if (!current || await getWebhookUrl(token) !== webhookUrl || setup?.fingerprint !== fingerprint) {
      await setWebhook(token, webhookUrl, this.#secret());
    }
    this.ctx.storage.kv.put<Setup>("setup", {
      fingerprint, bot, webhookUrl, checkedAt: Date.now(), webhookVersion: WEBHOOK_VERSION,
    });
    await this.#wakeBy(Date.now() + DAY_MS);
    return bot;
  }

  async getBot(): Promise<TelegramBotInfo> {
    return this.ensureSetup();
  }

  // -- Linking ----------------------------------------------------------------

  /** A single-use code that links the Telegram account opening it to one Workshop account. */
  async createLinkCode(accountId: string): Promise<LinkCode> {
    const bot = await this.ensureSetup();
    const code = newLinkCode();
    const expiresAt = Date.now() + LINK_CODE_LIFETIME_MS;
    this.ctx.storage.sql.exec("DELETE FROM codes WHERE expires_at < ?", Date.now());
    this.ctx.storage.sql.exec("INSERT INTO codes (code, account_id, expires_at) VALUES (?, ?, ?)",
      code, accountId, expiresAt);
    return { url: `https://t.me/${bot.username}?start=${code}`, code, botUsername: bot.username, expiresAt };
  }

  /** The account a Telegram user is linked to, if any. */
  #accountOf(telegramUserId: string): string | undefined {
    return this.ctx.storage.sql.exec<{ account_id: string }>(
      "SELECT account_id FROM links WHERE telegram_user_id = ?", telegramUserId).toArray()[0]?.account_id;
  }

  #owner(chatId: string): string | undefined {
    return this.ctx.storage.sql.exec<{ owner: string | null }>(
      "SELECT owner FROM chats WHERE id = ?", chatId).toArray()[0]?.owner ?? undefined;
  }

  #upsertChat(wire: WireMessage, owner: string | null, now: number): TelegramChatInfo {
    const chat = toChatInfo(wire.chat);
    this.ctx.storage.sql.exec(
      `INSERT INTO chats (id, type, title, username, owner, last_message_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET type = excluded.type, title = excluded.title,
         username = excluded.username, owner = excluded.owner, last_message_at = excluded.last_message_at`,
      chat.id, chat.type, chat.title, chat.username ?? null, owner, now);
    return chat;
  }

  #dropChat(chatId: string): void {
    this.ctx.storage.sql.exec("DELETE FROM messages WHERE chat_id = ?", chatId);
    this.ctx.storage.sql.exec("DELETE FROM chats WHERE id = ?", chatId);
  }

  /** Carries out one of the bot's commands, and says what to answer. */
  #command(command: BotCommand, wire: WireMessage, bot: TelegramBotInfo, now: number)
      : { text: string; button?: { text: string; url: string } } {
    const chatId = String(wire.chat.id);
    const senderId = wire.from && !wire.from.is_bot ? String(wire.from.id) : undefined;
    const isPrivate = wire.chat.type === "private";
    const senderAccount = senderId !== undefined ? this.#accountOf(senderId) : undefined;
    const withButton = (text: string) => ({ text, button: addGroupButton(bot.username) });

    if (isPrivate && command.kind === "start") {
      if (senderId === undefined) return { text: REPLIES.private };
      if (command.code === undefined || !LINK_CODE_PATTERN.test(command.code)) {
        return senderAccount !== undefined ? withButton(REPLIES.linked) : { text: REPLIES.private };
      }
      const row = this.ctx.storage.sql.exec<{ account_id: string; expires_at: number }>(
        "SELECT account_id, expires_at FROM codes WHERE code = ?", command.code).toArray()[0];
      // Single use, whatever happens next.
      this.ctx.storage.sql.exec("DELETE FROM codes WHERE code = ?", command.code);
      if (!row || row.expires_at < now) return { text: REPLIES.badCode };
      // Opening a code minted in Cloudflare OS proves both sides, so a Telegram account already
      // linked elsewhere (an older connection) moves to the new one, with its private chat.
      this.ctx.storage.sql.exec(
        "INSERT OR REPLACE INTO links (telegram_user_id, account_id, linked_at) VALUES (?, ?, ?)",
        senderId, row.account_id, now);
      this.#upsertChat(wire, row.account_id, now);
      return withButton(REPLIES.linked);
    }

    if (command.kind === "addgroup") {
      if (!isPrivate) return { text: REPLIES.groupOnly };
      return senderAccount !== undefined ? withButton(REPLIES.addGroup) : { text: REPLIES.linkFirst };
    }

    // `/link`, or the `/start` Telegram sends when the "Add to a group" button adds the bot.
    if (command.kind === "link" || command.kind === "start") {
      if (isPrivate) return senderAccount !== undefined ? withButton(REPLIES.groupOnly) : { text: REPLIES.linkFirst };
      if (senderAccount === undefined) return { text: REPLIES.linkFirst };
      const owner = this.#owner(chatId);
      if (owner === senderAccount) return { text: REPLIES.alreadyLinked };
      if (owner !== undefined) return { text: REPLIES.groupTaken };
      this.#upsertChat(wire, senderAccount, now);
      return { text: REPLIES.groupLinked };
    }

    // unlink
    const owner = this.#owner(chatId);
    if (owner === undefined) return { text: REPLIES.notLinked };
    if (senderAccount !== owner) return { text: REPLIES.notYours };
    this.#dropChat(chatId);
    if (isPrivate && senderId !== undefined) {
      this.ctx.storage.sql.exec("DELETE FROM links WHERE telegram_user_id = ?", senderId);
    }
    return { text: REPLIES.unlinked };
  }

  // -- Receiving --------------------------------------------------------------

  /**
   * Takes one webhook delivery. Refuses (false) one without the bot's secret, storing nothing.
   * Otherwise answers commands, keeps a message in a linked chat and queues it for its owner's
   * hooks, and tells an unlinked chat (at most daily) that the bot is private.
   */
  async receiveUpdate(secret: string, update: WireUpdate)
      : Promise<{ accepted: boolean; reply?: WebhookReply }> {
    const stored = this.ctx.storage.kv.get<string>("secret");
    if (!stored || !constantTimeEqual(stored, secret)) return { accepted: false };
    const setup = this.ctx.storage.kv.get<Setup>("setup");
    const now = Date.now();
    const press = updatePress(update);
    if (setup && press) {
      await this.#receivePress(press, now);
      return { accepted: true, reply: { answerPress: press.id } };
    }
    const reaction = updateReaction(update);
    if (setup && reaction) {
      await this.#receiveReaction(reaction, now);
      return { accepted: true };
    }
    const wire = updateMessage(update);
    if (!setup || !wire) return { accepted: true };

    const chatId = String(wire.chat.id);
    const command = parseCommand(wire.text, setup.bot.username);
    if (command) return { accepted: true, reply: { chatId, ...this.#command(command, wire, setup.bot, now) } };

    // A private chat's owner is its person's account; a group's, whoever linked it.
    const owner = wire.chat.type === "private"
      ? (wire.from ? this.#accountOf(String(wire.from.id)) : undefined)
      : this.#owner(chatId);
    if (owner === undefined) {
      // In a group, only a message addressed to the bot is answered: being added to a group, or a
      // group's chatter, gets no reply.
      const addressed = wire.chat.type === "private" || mentions(wire, setup.bot.username);
      return { accepted: true, ...(addressed ? { reply: this.#notice(chatId, now) } : {}) };
    }

    const chat = this.#upsertChat(wire, owner, now);
    const message = toMessage(wire, setup.bot.id);
    this.#storeMessage(message, messageFile(wire)?.fileId);
    await this.#enqueue(owner, chatId, `${chatId}.${message.id}`, { message, chatTitle: chat.title }, now);
    return { accepted: true };
  }

  /** Queues a delivery for every hook of `owner` that watches `chatId`. */
  async #enqueue(owner: string, chatId: string, id: string, delivery: Delivery, now: number): Promise<void> {
    // Listed up front: queueing lists storage too, which would invalidate a live iterator.
    const registrations = [...this.ctx.storage.kv.list<HookRegistration>({ prefix: "reg:" })];
    for (const [key, registration] of registrations) {
      if (registration.accountId !== owner) continue;
      if (registration.chatId !== undefined && registration.chatId !== chatId) continue;
      if (delivery.reaction && registration.ignoresReactions) continue;
      this.#queue.enqueue(key.slice("reg:".length), id, delivery, now);
    }
    await this.#wakeBy(now);
  }

  /**
   * A press of a button under one of the bot's messages, in a linked chat: handed to the hooks of
   * the chat's owner with who pressed it. In a group that can be anyone there, which is for the
   * gadget to judge. A press in a chat nobody linked goes nowhere.
   */
  async #receivePress(press: NonNullable<ReturnType<typeof updatePress>>, now: number): Promise<void> {
    const chatId = String(press.chat.id);
    const row = this.ctx.storage.sql.exec<ChatRow>("SELECT * FROM chats WHERE id = ?", chatId).toArray()[0];
    if (!row?.owner) return;
    await this.#enqueue(row.owner, chatId, `${chatId}.press.${press.id}`, {
      press: {
        chatId, messageId: press.messageId, data: press.data, from: toUser(press.from),
        pressedAt: new Date(now).toISOString(),
      },
      chatTitle: row.title,
    }, now);
  }

  /**
   * Someone's reaction to a message in a linked chat changing: handed to the hooks of the chat's
   * owner. Telegram reports it for any message there, so the hook is told whether the message is
   * one the bot sent, as far as it is still kept. In a chat nobody linked it goes nowhere.
   */
  async #receiveReaction(reaction: NonNullable<ReturnType<typeof updateReaction>>, now: number): Promise<void> {
    const chatId = String(reaction.chat.id);
    const row = this.ctx.storage.sql.exec<ChatRow>("SELECT * FROM chats WHERE id = ?", chatId).toArray()[0];
    // No content: enough to tell from the logs whether Telegram sent a change at all.
    logger.info("received a Telegram reaction change", {
      event: "telegram.reaction.received",
      code: `${reaction.emoji.length > 0 ? "set" : "removed"}${row?.owner ? "" : ".unlinked"}`,
    });
    if (!row?.owner) return;
    // Telegram redelivers an update it got no answer to; the same change queues once. What the
    // reaction became is part of the id: Telegram's time has whole seconds, and setting a reaction
    // and removing it within one second are two changes.
    const id = `${chatId}.react.${reaction.messageId}.${reaction.from?.id ?? "anon"}.${reaction.date}` +
      `.${[...reaction.emoji.join("")].map(char => char.codePointAt(0)!.toString(16)).join("-") || "none"}`;
    await this.#enqueue(row.owner, chatId, id, {
      reaction: {
        chatId, messageId: reaction.messageId,
        onBotMessage: this.#stored(chatId, reaction.messageId)?.message.fromBot === true,
        emoji: reaction.emoji, previous: reaction.previous,
        ...(reaction.from ? { from: toUser(reaction.from) } : {}),
        reactedAt: new Date(reaction.date * 1000).toISOString(),
      },
      chatTitle: row.title,
    }, now);
  }

  #notice(chatId: string, now: number): WebhookReply | undefined {
    const last = this.ctx.storage.sql.exec<{ at: number }>(
      "SELECT at FROM notices WHERE chat_id = ?", chatId).toArray()[0]?.at;
    if (last !== undefined && now - last < NOTICE_INTERVAL_MS) return undefined;
    this.ctx.storage.sql.exec("INSERT OR REPLACE INTO notices (chat_id, at) VALUES (?, ?)", chatId, now);
    return { chatId, text: REPLIES.private };
  }

  #storeMessage(message: TelegramMessage, fileId?: string): void {
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO messages (chat_id, id, body, file_id) VALUES (?, ?, ?, ?)",
      message.chatId, Number(message.id), JSON.stringify(message), fileId ?? null);
    this.ctx.storage.sql.exec(
      `DELETE FROM messages WHERE chat_id = ? AND id <= (
         SELECT id FROM messages WHERE chat_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?)`,
      message.chatId, message.chatId, MESSAGES_KEPT_PER_CHAT);
  }

  // -- An account's chats -----------------------------------------------------

  async listChats(accountId: string, query = ""): Promise<TelegramChatInfo[]> {
    const needle = query.trim().toLowerCase();
    return this.ctx.storage.sql.exec<ChatRow>(
      "SELECT * FROM chats WHERE owner = ? ORDER BY last_message_at DESC LIMIT 500", accountId,
    ).toArray().map(chatInfoOf).filter(chat => !needle ||
      chat.title.toLowerCase().includes(needle) || chat.username?.toLowerCase().includes(needle));
  }

  /** One of the account's chats, or null if it isn't the account's. */
  async getChat(accountId: string, chatId: string): Promise<TelegramChatInfo | null> {
    const row = this.ctx.storage.sql.exec<ChatRow>(
      "SELECT * FROM chats WHERE id = ? AND owner = ?", chatId, accountId).toArray()[0];
    return row ? chatInfoOf(row) : null;
  }

  /**
   * The account's own private chat with the bot, once its person linked their Telegram: what a
   * connect page waits for, and the connection's name.
   */
  async linkedPerson(accountId: string): Promise<TelegramChatInfo | null> {
    const row = this.ctx.storage.sql.exec<ChatRow>(
      `SELECT chats.* FROM links JOIN chats ON chats.id = links.telegram_user_id
       WHERE links.account_id = ? AND chats.owner = ?`, accountId, accountId).toArray()[0];
    return row ? chatInfoOf(row) : null;
  }

  /** The account a chat belongs to, for observer checks. */
  async chatOwner(chatId: string): Promise<string | null> {
    return this.#owner(chatId) ?? null;
  }

  /** Whether the chat is the account's own private chat with the bot: messages only to themselves. */
  async isOwnPrivateChat(accountId: string, chatId: string): Promise<boolean> {
    const row = this.ctx.storage.sql.exec<ChatRow>(
      "SELECT * FROM chats WHERE id = ? AND owner = ?", chatId, accountId).toArray()[0];
    return row?.type === "private" && this.#accountOf(chatId) === accountId;
  }

  async listMessages(accountId: string, chatId: string, beforeId: number | null, limit: number)
      : Promise<{ messages: TelegramMessage[]; more: boolean }> {
    if (this.#owner(chatId) !== accountId) return { messages: [], more: false };
    const rows = this.ctx.storage.sql.exec<{ body: string }>(
      "SELECT body FROM messages WHERE chat_id = ? AND id < ? ORDER BY id DESC LIMIT ?",
      chatId, beforeId ?? Number.MAX_SAFE_INTEGER, limit + 1,
    ).toArray();
    return {
      messages: rows.slice(0, limit).map(row => JSON.parse(row.body) as TelegramMessage),
      more: rows.length > limit,
    };
  }

  #requireOwned(accountId: string, chatId: string): void {
    if (this.#owner(chatId) !== accountId) {
      throw new TelegramError("FORBIDDEN", "That chat is no longer linked to this account.");
    }
  }

  #stored(chatId: string, messageId: string): { message: TelegramMessage; fileId?: string } | undefined {
    const row = this.ctx.storage.sql.exec<{ body: string; file_id: string | null }>(
      "SELECT body, file_id FROM messages WHERE chat_id = ? AND id = ?", chatId, Number(messageId)).toArray()[0];
    return row
      ? { message: JSON.parse(row.body) as TelegramMessage, ...(row.file_id ? { fileId: row.file_id } : {}) }
      : undefined;
  }

  /** One of the bot's own kept messages, which is all it may change. */
  #ownMessage(accountId: string, chatId: string, messageId: string) {
    this.#requireOwned(accountId, chatId);
    const stored = this.#stored(chatId, messageId);
    if (!stored) throw new TelegramError("BAD_REQUEST", `Message ${messageId} is no longer kept for this chat.`);
    if (!stored.message.fromBot) {
      throw new TelegramError("FORBIDDEN", "Only the bot's own messages can be changed or deleted.");
    }
    return stored;
  }

  /** Keeps what Telegram returned for a send or an edit. */
  async #keep(wire: WireMessage): Promise<TelegramMessage> {
    const bot = await this.ensureSetup();
    const message = toMessage(wire, bot.id);
    this.#storeMessage(message, messageFile(wire)?.fileId);
    return message;
  }

  /** One kept message of one of the account's chats, or null. */
  async getMessage(accountId: string, chatId: string, messageId: string): Promise<TelegramMessage | null> {
    if (this.#owner(chatId) !== accountId) return null;
    return this.#stored(chatId, messageId)?.message ?? null;
  }

  /** Sends a message as the bot to one of the account's chats, and keeps it with the chat. */
  async send(accountId: string, chatId: string, text: string, options: SendOptions): Promise<TelegramMessage> {
    this.#requireOwned(accountId, chatId);
    await this.ensureSetup();
    return this.#keep(await sendMessage(this.#token(), chatId, text, options));
  }

  /** Sends a picture or a file as the bot to one of the account's chats. */
  async sendMedia(
      accountId: string, chatId: string, kind: "photo" | "document", file: UploadFile,
      options: SendOptions & { caption?: string }): Promise<TelegramMessage> {
    this.#requireOwned(accountId, chatId);
    await this.ensureSetup();
    return this.#keep(await sendMedia(this.#token(), kind, chatId, file, options));
  }

  /** Replaces the text (or caption) and buttons of one of the bot's own messages. */
  async editMessage(
      accountId: string, chatId: string, messageId: string, text: string,
      options: { format?: "plain" | "markdown"; buttons?: TelegramButton[][] }): Promise<TelegramMessage> {
    const { message } = this.#ownMessage(accountId, chatId, messageId);
    return this.#keep(await editMessage(this.#token(), chatId, messageId, text, {
      ...options, caption: message.attachment !== undefined,
    }));
  }

  /** Replaces the buttons of one of the bot's own messages. */
  async setButtons(
      accountId: string, chatId: string, messageId: string, buttons: TelegramButton[][]): Promise<TelegramMessage> {
    this.#ownMessage(accountId, chatId, messageId);
    return this.#keep(await editButtons(this.#token(), chatId, messageId, buttons));
  }

  /** Deletes one of the bot's own messages, in Telegram and here. */
  async deleteMessage(accountId: string, chatId: string, messageId: string): Promise<void> {
    this.#ownMessage(accountId, chatId, messageId);
    await deleteMessage(this.#token(), chatId, messageId);
    this.ctx.storage.sql.exec("DELETE FROM messages WHERE chat_id = ? AND id = ?", chatId, Number(messageId));
  }

  /** Sets or clears the bot's reaction to any message in one of the account's chats. */
  async react(accountId: string, chatId: string, messageId: string, emoji: string | null): Promise<void> {
    this.#requireOwned(accountId, chatId);
    await setReaction(this.#token(), chatId, messageId, emoji);
  }

  /** Downloads the picture or file a kept message carries. */
  async readFile(accountId: string, chatId: string, messageId: string): Promise<TelegramFileContent> {
    this.#requireOwned(accountId, chatId);
    const stored = this.#stored(chatId, messageId);
    if (!stored) throw new TelegramError("BAD_REQUEST", `Message ${messageId} is no longer kept for this chat.`);
    if (!stored.fileId) throw new TelegramError("BAD_REQUEST", "That message carries no picture or file that can be read.");
    const content = await downloadFile(this.#token(), stored.fileId);
    const { file } = stored.message;
    return {
      content,
      ...(file?.filename ? { filename: file.filename } : {}),
      ...(file?.mediaType ? { mediaType: file.mediaType } : {}),
    };
  }

  // -- Hooks ------------------------------------------------------------------

  async registerHook(key: string, registration: HookRegistration,
                     initiator: Fetcher<HookInitiator<TelegramHookTarget>>): Promise<void> {
    if (this.ctx.storage.kv.get(`forgotten:${registration.accountId}`) !== undefined) {
      throw new Error("This Telegram account was removed.");
    }
    disposeStored(this.ctx.storage.kv.get(initiatorKey(key)));
    this.ctx.storage.kv.put(registrationKey(key), registration);
    this.ctx.storage.kv.put(initiatorKey(key), initiator);
  }

  /**
   * Whether an enabled hook of the account would be handed a button press in this chat. A hook is
   * only known to ignore presses once one could not be delivered to it, so `true` means "as far
   * as is known".
   */
  async listensForPresses(accountId: string, chatId: string): Promise<boolean> {
    for (const [, registration] of this.ctx.storage.kv.list<HookRegistration>({ prefix: "reg:" })) {
      if (registration.accountId !== accountId || registration.ignoresPresses) continue;
      if (registration.chatId === undefined || registration.chatId === chatId) return true;
    }
    return false;
  }

  async unregisterHook(key: string): Promise<void> {
    disposeStored(this.ctx.storage.kv.get(initiatorKey(key)));
    this.ctx.storage.kv.delete(registrationKey(key));
    this.ctx.storage.kv.delete(initiatorKey(key));
    this.#queue.cancel(key);
  }

  /** Forgets everything of an account being removed: its links, codes, chats and hooks. */
  async forgetAccount(accountId: string): Promise<void> {
    this.ctx.storage.kv.put(`forgotten:${accountId}`, Date.now());
    const sql = this.ctx.storage.sql;
    sql.exec("DELETE FROM links WHERE account_id = ?", accountId);
    sql.exec("DELETE FROM codes WHERE account_id = ?", accountId);
    sql.exec("DELETE FROM messages WHERE chat_id IN (SELECT id FROM chats WHERE owner = ?)", accountId);
    sql.exec("DELETE FROM chats WHERE owner = ?", accountId);
    const keys = [...this.ctx.storage.kv.list<HookRegistration>({ prefix: "reg:" })]
      .filter(([, registration]) => registration.accountId === accountId)
      .map(([key]) => key.slice("reg:".length));
    for (const key of keys) await this.unregisterHook(key);
  }

  /**
   * One alarm for three jobs: delivering queued messages whose (re)try time has come, rechecking
   * the webhook daily, and dropping expired link codes.
   */
  async alarm(): Promise<void> {
    const now = Date.now();
    await this.#queue.run(now, (hookKey, delivery) => this.#deliver(hookKey, delivery));
    this.ctx.storage.sql.exec("DELETE FROM codes WHERE expires_at < ?", now);
    const setup = this.ctx.storage.kv.get<Setup>("setup");
    if (setup && now - setup.checkedAt >= DAY_MS) {
      await this.ensureSetup(true).catch(error => {
        logger.warn("could not recheck the Telegram webhook", {
          event: "telegram.webhook.check.failed", code: error instanceof TelegramError ? error.code : undefined, error,
        });
      });
    }
    const times = [this.#queue.nextDue(), setup ? setup.checkedAt + DAY_MS : undefined]
      .filter((time): time is number => time !== undefined);
    if (times.length > 0) await this.ctx.storage.setAlarm(Math.max(Math.min(...times), now + MINUTE_MS / 6));
  }

  async #deliver(hookKey: string, delivery: Delivery): Promise<void> {
    // An unregistered hook's rows are finished, and it gets no new ones.
    const initiator = this.ctx.storage.kv.get<Fetcher<HookInitiator<TelegramHookTarget>>>(initiatorKey(hookKey));
    if (!initiator) return;
    try {
      // A refused firing is retried like a failed one, being indistinguishable from a transient
      // failure; disabling or deleting the hook unregisters it, which ends the retries.
      using hook = await initiator.startHook();
      if (delivery.press) {
        await hook.approvalQueue.authorizeObservation({
          title: "Received a Telegram button press",
          description: `Delivered a press of a button under one of the bot's messages in ${delivery.chatTitle}.`,
          fields: [
            { label: "Chat", kind: "inline", value: delivery.chatTitle },
            { label: "Pressed by", kind: "inline", value: delivery.press.from.name },
            { label: "Button data", kind: "inline", value: delivery.press.data },
          ],
          subresources: [chatSubresource(delivery.press.chatId)],
        });
        try {
          // Optional in the hook's type, which a stub cannot express: it is simply called.
          const callback = hook.callback as unknown as {
            receiveButtonPress(press: TelegramButtonPress): Promise<void>;
          };
          await callback.receiveButtonPress(delivery.press);
        } catch (error) {
          // A hook written before buttons existed has no such method: that is a hook ignoring
          // presses, not a failed delivery to retry. Remembered, so a later send with buttons is
          // told nothing would hear them.
          if (!isMissingMethod(error)) throw error;
          const registration = this.ctx.storage.kv.get<HookRegistration>(registrationKey(hookKey));
          if (registration) {
            this.ctx.storage.kv.put<HookRegistration>(registrationKey(hookKey), { ...registration, ignoresPresses: true });
          }
        }
        return;
      }
      if (delivery.reaction) {
        const { reaction } = delivery;
        await hook.approvalQueue.authorizeObservation({
          title: "Received a Telegram reaction",
          description: `Delivered a change of someone's reaction to a message in ${delivery.chatTitle}.`,
          fields: [
            { label: "Chat", kind: "inline", value: delivery.chatTitle },
            { label: "By", kind: "inline", value: reaction.from?.name ?? "An anonymous administrator" },
            { label: "Reaction", kind: "inline", value: reaction.emoji.join(" ") || "Removed" },
          ],
          subresources: [chatSubresource(reaction.chatId)],
        });
        try {
          const callback = hook.callback as unknown as {
            receiveReaction(change: TelegramReactionChange): Promise<void>;
          };
          await callback.receiveReaction(reaction);
        } catch (error) {
          // Most hooks have no such method. That is a hook ignoring reactions, not a failed
          // delivery to retry, and it is remembered so that it is not asked again.
          if (!isMissingMethod(error, "receiveReaction")) throw error;
          const registration = this.ctx.storage.kv.get<HookRegistration>(registrationKey(hookKey));
          if (registration) {
            this.ctx.storage.kv.put<HookRegistration>(registrationKey(hookKey), { ...registration, ignoresReactions: true });
          }
        }
        return;
      }
      await hook.approvalQueue.authorizeObservation({
        title: "Received a Telegram message",
        description: `Delivered a message the bot received in ${delivery.chatTitle}.`,
        fields: [{ label: "Chat", kind: "inline", value: delivery.chatTitle }],
        subresources: [chatSubresource(delivery.message.chatId)],
      });
      await hook.callback.receiveMessage(delivery.message);
    } finally {
      disposeStored(initiator);
    }
  }

  async #wakeBy(time: number): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || time < current) await this.ctx.storage.setAlarm(time);
  }
}
