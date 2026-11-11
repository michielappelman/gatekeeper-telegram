/**
 * A minimal client for the Telegram Bot API (https://core.telegram.org/bots/api): the calls this
 * gatekeeper makes, and the conversions from Telegram's wire shapes to the agent-facing types.
 *
 * Every request goes to `https://api.telegram.org/bot<token>/<method>`, so the token is part of
 * the URL: nothing here puts a URL, or a request, into an error or a log line.
 */

import type {
  TelegramBotInfo,
  TelegramButton,
  TelegramChatInfo,
  TelegramMessage,
  TelegramSender,
} from "./types";

const API_ORIGIN = "https://api.telegram.org";

/** Telegram's limit on one message's text, in UTF-16 code units. */
export const MAX_MESSAGE_LENGTH = 4096;
/** Telegram's limit on the caption of a picture or file. */
export const MAX_CAPTION_LENGTH = 1024;
/** Telegram's limit on a picture sent as a photo. */
export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
/**
 * The largest file sent or read. Telegram lets a bot download 20 MB and upload 50 MB, but a file
 * passes through several Workers on its way, each holding a copy in a 128 MB isolate.
 */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
/** Limits on the buttons under one message: Telegram allows more, a phone screen does not. */
export const MAX_BUTTON_ROWS = 10;
export const MAX_BUTTONS_PER_ROW = 8;
export const MAX_BUTTONS = 40;
/** Telegram's limit on a button's `callback_data`, in bytes. */
export const MAX_BUTTON_DATA_BYTES = 64;
const MAX_BUTTON_TEXT_LENGTH = 64;

/** What went wrong talking to Telegram, as a caller needs to tell it apart. */
export type TelegramErrorCode =
  /** The token was revoked or never valid (HTTP 401). */
  | "AUTH_EXPIRED"
  /** The token isn't shaped like a bot token, so it was never sent. */
  | "INVALID_TOKEN"
  /** Telegram refused the request as malformed (HTTP 400), e.g. a chat it doesn't know. */
  | "BAD_REQUEST"
  /** The bot may not do this (HTTP 403), e.g. a person blocked it or it left the group. */
  | "FORBIDDEN"
  /** Too many requests (HTTP 429). */
  | "RATE_LIMITED"
  /** Telegram failed or could not be reached. */
  | "UNAVAILABLE";

export class TelegramError extends Error {
  constructor(readonly code: TelegramErrorCode, message: string) {
    super(message);
    this.name = "TelegramError";
  }
}

/** A bot token as @BotFather issues it: the bot's numeric id, a colon, and a secret. */
const TOKEN_PATTERN = /^\d{5,20}:[A-Za-z0-9_-]{30,64}$/;

export function isBotTokenShaped(token: string): boolean {
  return TOKEN_PATTERN.test(token);
}

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** The parts of Telegram's response envelope this client reads. */
type Envelope<T> = {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
};

function failure(status: number, envelope: Envelope<unknown> | undefined): TelegramError {
  // Telegram's description names the problem ("Bad Request: chat not found") and never echoes
  // the token, so it is safe to pass on.
  const detail = envelope?.description ?? `HTTP ${status}`;
  if (status === 401) {
    return new TelegramError("AUTH_EXPIRED", "Telegram no longer accepts this bot's token.");
  }
  if (status === 403) return new TelegramError("FORBIDDEN", `Telegram refused: ${detail}`);
  if (status === 429) {
    const wait = envelope?.parameters?.retry_after;
    return new TelegramError("RATE_LIMITED",
      `Telegram is rate limiting this bot${wait ? `; retry in ${wait} s` : ""}.`);
  }
  if (status >= 400 && status < 500) return new TelegramError("BAD_REQUEST", `Telegram refused: ${detail}`);
  return new TelegramError("UNAVAILABLE", `Telegram failed: ${detail}`);
}

/** Calls one Bot API method with a JSON body and returns its `result`. */
export async function callApi<T>(
    token: string, method: string, body: object, fetchFn: FetchLike = fetch): Promise<T> {
  if (!isBotTokenShaped(token)) {
    throw new TelegramError("INVALID_TOKEN", "That doesn't look like a Telegram bot token.");
  }
  let response: Response;
  try {
    response = await fetchFn(`${API_ORIGIN}/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      redirect: "manual",
    });
  } catch {
    // The underlying error can quote the URL, which holds the token.
    throw new TelegramError("UNAVAILABLE", "Telegram could not be reached.");
  }
  return result<T>(response);
}

async function result<T>(response: Response): Promise<T> {
  let envelope: Envelope<T> | undefined;
  try {
    envelope = await response.json() as Envelope<T>;
  } catch {
    envelope = undefined;
  }
  if (!response.ok || !envelope?.ok || envelope.result === undefined) {
    throw failure(response.ok ? 502 : response.status, envelope);
  }
  return envelope.result;
}

/** Calls one Bot API method with a multipart body, which is how a file is uploaded. */
async function callApiForm<T>(
    token: string, method: string, form: FormData, fetchFn: FetchLike = fetch): Promise<T> {
  if (!isBotTokenShaped(token)) {
    throw new TelegramError("INVALID_TOKEN", "That doesn't look like a Telegram bot token.");
  }
  let response: Response;
  try {
    // No Content-Type: fetch adds it with the multipart boundary.
    response = await fetchFn(`${API_ORIGIN}/bot${token}/${method}`, {
      method: "POST", body: form, redirect: "manual",
    });
  } catch {
    throw new TelegramError("UNAVAILABLE", "Telegram could not be reached.");
  }
  return result<T>(response);
}

// ---------------------------------------------------------------------------
// Wire shapes (the fields this gatekeeper reads)

export type WireUser = {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
};

export type WireChat = {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
};

export type WireMessage = {
  message_id: number;
  date: number;
  chat: WireChat;
  from?: WireUser;
  sender_chat?: WireChat;
  text?: string;
  caption?: string;
  reply_to_message?: { message_id: number };
  reply_markup?: { inline_keyboard?: WireButton[][] };
  [attachment: string]: unknown;
};

type WireButton = { text: string; url?: string; callback_data?: string };

/** A press of a button under one of the bot's messages. */
export type WireCallbackQuery = {
  id: string;
  from: WireUser;
  message?: { message_id: number; chat: WireChat };
  data?: string;
};

/** One reaction: a standard emoji, or a kind (custom, paid) this gatekeeper does not report. */
type WireReaction = { type: string; emoji?: string };

/** One person changing their reaction to a message. */
export type WireMessageReaction = {
  chat: WireChat;
  message_id: number;
  /** Absent for an anonymous administrator, who reacts as the chat. */
  user?: WireUser;
  date: number;
  old_reaction: WireReaction[];
  new_reaction: WireReaction[];
};

export type WireUpdate = {
  update_id: number;
  message?: WireMessage;
  channel_post?: WireMessage;
  callback_query?: WireCallbackQuery;
  message_reaction?: WireMessageReaction;
};

/**
 * The update kinds the webhook asks Telegram for. Changing the list means registering the webhook
 * again, so bump `WEBHOOK_VERSION` with it.
 *
 * `message_reaction` is one Telegram never sends unless it is listed. Anonymous totals
 * (`message_reaction_count`, channels) are not asked for: they name nobody.
 */
export const ALLOWED_UPDATES = ["message", "channel_post", "callback_query", "message_reaction"];
export const WEBHOOK_VERSION = 3;

// ---------------------------------------------------------------------------
// Calls

export async function getMe(token: string, fetchFn?: FetchLike): Promise<TelegramBotInfo> {
  const me = await callApi<WireUser>(token, "getMe", {}, fetchFn);
  if (!me.is_bot || !me.username) {
    throw new TelegramError("BAD_REQUEST", "That token doesn't belong to a bot.");
  }
  return { id: String(me.id), username: me.username, name: fullName(me) };
}

/**
 * Points the bot's updates at `url`. Telegram sends `secret` back in every delivery's
 * `X-Telegram-Bot-Api-Secret-Token` header, which is how a delivery proves where it came from.
 */
export async function setWebhook(
    token: string, url: string, secret: string, fetchFn?: FetchLike): Promise<void> {
  await callApi<boolean>(token, "setWebhook", {
    url,
    secret_token: secret,
    allowed_updates: ALLOWED_UPDATES,
  }, fetchFn);
}

/** Where Telegram currently delivers the bot's updates, if anywhere. */
export async function getWebhookUrl(token: string, fetchFn?: FetchLike): Promise<string> {
  return (await callApi<{ url: string }>(token, "getWebhookInfo", {}, fetchFn)).url;
}

export async function deleteWebhook(token: string, fetchFn?: FetchLike): Promise<void> {
  await callApi<boolean>(token, "deleteWebhook", {}, fetchFn);
}

export type SendOptions = {
  replyTo?: string;
  format?: "plain" | "markdown";
  buttons?: TelegramButton[][];
};

/** A file as it is uploaded. */
export type UploadFile = { bytes: Uint8Array; filename: string; mediaType: string };

function keyboard(buttons: TelegramButton[][]): { inline_keyboard: WireButton[][] } {
  return {
    inline_keyboard: buttons.map(row => row.map((button): WireButton => "url" in button
      ? { text: button.text, url: button.url }
      : { text: button.text, callback_data: button.data })),
  };
}

/** The fields every send shares, apart from its text or caption. */
function sendFields(chatId: string, options: SendOptions) {
  return {
    chat_id: chatId,
    ...(options.format === "markdown" ? { parse_mode: "MarkdownV2" } : {}),
    ...(options.replyTo !== undefined
      ? { reply_parameters: { message_id: Number(options.replyTo), allow_sending_without_reply: true } }
      : {}),
    ...(options.buttons?.length ? { reply_markup: keyboard(options.buttons) } : {}),
  };
}

export async function sendMessage(
    token: string, chatId: string, text: string, options: SendOptions = {},
    fetchFn?: FetchLike): Promise<WireMessage> {
  return callApi<WireMessage>(token, "sendMessage", { ...sendFields(chatId, options), text }, fetchFn);
}

/** Uploads a picture (`photo`, which Telegram compresses) or a file (`document`). */
export async function sendMedia(
    token: string, kind: "photo" | "document", chatId: string, file: UploadFile,
    options: SendOptions & { caption?: string } = {}, fetchFn?: FetchLike): Promise<WireMessage> {
  const form = new FormData();
  // Multipart fields are strings: objects travel JSON-encoded, as the Bot API asks.
  for (const [name, value] of Object.entries(sendFields(chatId, options))) {
    form.set(name, typeof value === "string" ? value : JSON.stringify(value));
  }
  if (options.caption) form.set("caption", options.caption);
  form.set(kind, new Blob([file.bytes as Uint8Array<ArrayBuffer>], { type: file.mediaType }), file.filename);
  return callApiForm<WireMessage>(token, kind === "photo" ? "sendPhoto" : "sendDocument", form, fetchFn);
}

/**
 * Replaces the text of one of the bot's messages (`caption: true` for the caption of a picture or
 * file) and its buttons: Telegram removes the buttons an edit does not repeat.
 */
export async function editMessage(
    token: string, chatId: string, messageId: string, text: string,
    options: { format?: "plain" | "markdown"; buttons?: TelegramButton[][]; caption?: boolean } = {},
    fetchFn?: FetchLike): Promise<WireMessage> {
  return callApi<WireMessage>(token, options.caption ? "editMessageCaption" : "editMessageText", {
    chat_id: chatId,
    message_id: Number(messageId),
    [options.caption ? "caption" : "text"]: text,
    ...(options.format === "markdown" ? { parse_mode: "MarkdownV2" } : {}),
    ...(options.buttons?.length ? { reply_markup: keyboard(options.buttons) } : {}),
  }, fetchFn);
}

/** Replaces the buttons of one of the bot's messages; none removes them. */
export async function editButtons(
    token: string, chatId: string, messageId: string, buttons: TelegramButton[][],
    fetchFn?: FetchLike): Promise<WireMessage> {
  return callApi<WireMessage>(token, "editMessageReplyMarkup", {
    chat_id: chatId, message_id: Number(messageId), reply_markup: keyboard(buttons),
  }, fetchFn);
}

export async function deleteMessage(
    token: string, chatId: string, messageId: string, fetchFn?: FetchLike): Promise<void> {
  await callApi<boolean>(token, "deleteMessage", { chat_id: chatId, message_id: Number(messageId) }, fetchFn);
}

/** Sets the bot's one reaction to a message; `null` clears it. */
export async function setReaction(
    token: string, chatId: string, messageId: string, emoji: string | null,
    fetchFn?: FetchLike): Promise<void> {
  await callApi<boolean>(token, "setMessageReaction", {
    chat_id: chatId,
    message_id: Number(messageId),
    // Normalized here too: an action queued before the check existed is stored as it was asked.
    reaction: emoji === null ? [] : [{ type: "emoji", emoji: normalizeReaction(emoji) }],
  }, fetchFn);
}

/**
 * Downloads a file a message carries, by Telegram's `file_id`. The download URL holds the token,
 * like every other, so nothing here quotes it.
 */
export async function downloadFile(
    token: string, fileId: string, fetchFn: FetchLike = fetch): Promise<ArrayBuffer> {
  const file = await callApi<{ file_path?: string; file_size?: number }>(
    token, "getFile", { file_id: fileId }, fetchFn);
  if (!file.file_path) throw new TelegramError("UNAVAILABLE", "Telegram gave no way to download that file.");
  if ((file.file_size ?? 0) > MAX_FILE_BYTES) throw tooLarge();
  let response: Response;
  try {
    response = await fetchFn(`${API_ORIGIN}/file/bot${token}/${file.file_path}`, {
      method: "GET", redirect: "manual",
    });
  } catch {
    throw new TelegramError("UNAVAILABLE", "Telegram could not be reached.");
  }
  if (!response.ok) throw failure(response.status, undefined);
  if (Number(response.headers.get("Content-Length") ?? "0") > MAX_FILE_BYTES) {
    await response.body?.cancel();
    throw tooLarge();
  }
  const content = await response.arrayBuffer();
  if (content.byteLength > MAX_FILE_BYTES) throw tooLarge();
  return content;
}

function tooLarge(): TelegramError {
  return new TelegramError("BAD_REQUEST",
    `That file is larger than the ${MAX_FILE_BYTES / 1024 / 1024} MB that can be read.`);
}

// ---------------------------------------------------------------------------
// Validation and conversions

/** Throws an error the agent can act on for a message Telegram would refuse. */
export function validateSend(text: string, options: SendOptions = {}): void {
  if (text.trim().length === 0) throw new TelegramError("BAD_REQUEST", "A message needs some text.");
  if (text.length > MAX_MESSAGE_LENGTH) {
    throw new TelegramError("BAD_REQUEST",
      `A message can be at most ${MAX_MESSAGE_LENGTH} characters; this one is ${text.length}.`);
  }
  validateOptions(options);
}

/** Checks everything about a send but its text. */
export function validateOptions(options: SendOptions): void {
  if (options.replyTo !== undefined && !/^[1-9]\d{0,15}$/.test(options.replyTo)) {
    throw new TelegramError("BAD_REQUEST", "replyTo must be the id of a message in this chat.");
  }
  if (options.format !== undefined && options.format !== "plain" && options.format !== "markdown") {
    throw new TelegramError("BAD_REQUEST", 'format must be "plain" or "markdown".');
  }
  if (options.buttons !== undefined) validateButtons(options.buttons);
}

/** A caption is optional, unlike a message's text. */
export function validateCaption(caption: string | undefined): void {
  if (caption !== undefined && caption.length > MAX_CAPTION_LENGTH) {
    throw new TelegramError("BAD_REQUEST",
      `A caption can be at most ${MAX_CAPTION_LENGTH} characters; this one is ${caption.length}.`);
  }
}

const bad = (message: string) => new TelegramError("BAD_REQUEST", message);

export function validateButtons(buttons: TelegramButton[][]): void {
  if (buttons.length > MAX_BUTTON_ROWS) throw bad(`A message can have at most ${MAX_BUTTON_ROWS} rows of buttons.`);
  let total = 0;
  for (const row of buttons) {
    if (row.length === 0) throw bad("A row of buttons needs at least one button.");
    if (row.length > MAX_BUTTONS_PER_ROW) throw bad(`A row can have at most ${MAX_BUTTONS_PER_ROW} buttons.`);
    total += row.length;
    for (const button of row) {
      const text = button.text.trim();
      if (text.length === 0 || button.text.length > MAX_BUTTON_TEXT_LENGTH) {
        throw bad(`A button's text must be 1 to ${MAX_BUTTON_TEXT_LENGTH} characters.`);
      }
      if ("url" in button) {
        let url: URL | undefined;
        try {
          url = new URL(button.url);
        } catch {
          url = undefined;
        }
        if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) {
          throw bad(`The "${text}" button's url must be an https or http link.`);
        }
      } else {
        const bytes = new TextEncoder().encode(button.data).length;
        if (bytes === 0 || bytes > MAX_BUTTON_DATA_BYTES) {
          throw bad(`The "${text}" button's data must be 1 to ${MAX_BUTTON_DATA_BYTES} bytes.`);
        }
      }
    }
  }
  if (total > MAX_BUTTONS) throw bad(`A message can have at most ${MAX_BUTTONS} buttons.`);
}

const PHOTO_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

/** Checks a picture or file before it is kept for sending, and returns its bytes. */
export function validateUpload(
    upload: { content: ArrayBuffer | Uint8Array; filename: string; mediaType: string },
    kind: "photo" | "document"): UploadFile {
  const bytes = upload.content instanceof Uint8Array ? upload.content : new Uint8Array(upload.content);
  if (bytes.byteLength === 0) throw bad("That file is empty.");
  const limit = kind === "photo" ? MAX_PHOTO_BYTES : MAX_FILE_BYTES;
  if (bytes.byteLength > limit) {
    throw bad(`A ${kind === "photo" ? "picture" : "file"} can be at most ${limit / 1024 / 1024} MB.`);
  }
  // A name is shown to the approver and the recipient: one line, no path, nothing invisible.
  const name = upload.filename;
  const plain = [...name].every(character => {
    const code = character.codePointAt(0)!;
    return code >= 0x20 && code !== 0x7f && character !== "/" && character !== "\\";
  });
  if (name.length === 0 || name.length > 200 || !plain || name.trim() !== name) {
    throw bad("A filename must be 1 to 200 characters on one line, without slashes.");
  }
  if (!/^[a-z0-9][a-z0-9!#$&^_.+-]{0,62}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,62}$/i.test(upload.mediaType)) {
    throw bad('A mediaType looks like "image/png".');
  }
  if (kind === "photo" && !PHOTO_TYPES.has(upload.mediaType.toLowerCase())) {
    throw bad("A picture must be a JPEG, PNG or WEBP image; send anything else with sendFile().");
  }
  return { bytes, filename: upload.filename, mediaType: upload.mediaType.toLowerCase() };
}

/**
 * The emoji a bot may react with (Bot API, ReactionTypeEmoji). Telegram answers anything else with
 * `REACTION_INVALID`, and only once a person has approved the action, so the set is checked when
 * the reaction is asked for. Spelled as Telegram wants them: without the variation selector.
 */
export const REACTION_EMOJI: ReadonlySet<string> = new Set([
  "👍", "👎", "❤", "🔥", "🥰", "👏", "😁", "🤔", "🤯", "😱", "🤬", "😢", "🎉", "🤩", "🤮", "💩", "🙏",
  "👌", "🕊", "🤡", "🥱", "🥴", "😍", "🐳", "❤‍🔥", "🌚", "🌭", "💯", "🤣", "⚡", "🍌", "🏆", "💔", "🤨",
  "😐", "🍓", "🍾", "💋", "🖕", "😈", "😴", "😭", "🤓", "👻", "👨‍💻", "👀", "🎃", "🙈", "😇", "😨", "🤝",
  "✍", "🤗", "🫡", "🎅", "🎄", "☃", "💅", "🤪", "🗿", "🆒", "💘", "🙉", "🦄", "😘", "💊", "🙊", "😎",
  "👾", "🤷‍♂", "🤷", "🤷‍♀", "😡",
].map(emoji => emoji.replaceAll("\uFE0F", "")));

/**
 * `emoji` as Telegram accepts it, or null to remove the reaction. Most keyboards and models write
 * ❤ and its like with a variation selector (U+FE0F), which Telegram refuses, so it is dropped.
 * Throws for anything outside REACTION_EMOJI, naming a few that work.
 */
export function normalizeReaction(emoji: string | null): string | null {
  if (emoji === null) return null;
  const plain = emoji.trim().replaceAll("\uFE0F", "");
  if (!REACTION_EMOJI.has(plain)) {
    throw bad("Telegram does not allow that emoji as a reaction. Use one of its fixed set, such as " +
      "👍 👎 ❤ 🔥 🎉 👏 😁 🤔 😢 👀 🙏 👌 💯 🤝 ✍ 🫡, or null to remove the reaction.");
  }
  return plain;
}

/** Message ids are positive integers; a cursor or handle must be one. */
export function isMessageId(value: string): boolean {
  return /^[1-9]\d{0,15}$/.test(value);
}

/** Telegram's chat ids: positive for people, negative for groups and channels. */
export function isChatId(value: string): boolean {
  return /^-?[1-9]\d{0,19}$/.test(value);
}

function fullName(user: { first_name?: string; last_name?: string }): string {
  return [user.first_name, user.last_name].filter(Boolean).join(" ");
}

const ATTACHMENT_FIELDS = [
  "photo", "video", "animation", "document", "audio", "voice", "video_note", "sticker",
  "location", "venue", "contact", "poll", "dice", "story",
] as const;

export function toChatInfo(chat: WireChat, lastMessageAt?: number): TelegramChatInfo {
  return {
    id: String(chat.id),
    type: chat.type,
    title: chat.title ?? (fullName(chat) || chat.username || String(chat.id)),
    ...(chat.username ? { username: chat.username } : {}),
    ...(lastMessageAt !== undefined ? { lastMessageAt: new Date(lastMessageAt).toISOString() } : {}),
  };
}

function toSender(message: WireMessage): TelegramSender | undefined {
  if (message.from) {
    return {
      id: String(message.from.id),
      name: fullName(message.from) || message.from.username || String(message.from.id),
      ...(message.from.username ? { username: message.from.username } : {}),
      isBot: message.from.is_bot,
    };
  }
  // A channel post, or a message sent on behalf of a chat.
  if (message.sender_chat?.title) {
    return {
      id: String(message.sender_chat.id),
      name: message.sender_chat.title,
      ...(message.sender_chat.username ? { username: message.sender_chat.username } : {}),
      isBot: false,
    };
  }
  return undefined;
}

/** Attachment kinds whose content is one downloadable file. */
const FILE_FIELDS = ["document", "video", "animation", "audio", "voice", "video_note", "sticker"] as const;

type WireFile = { file_id?: unknown; file_name?: unknown; mime_type?: unknown; file_size?: unknown };

/** The downloadable file a message carries, with Telegram's id for it, if it carries one. */
export function messageFile(message: WireMessage)
    : { fileId: string; filename?: string; mediaType?: string; size?: number } | undefined {
  let wire: WireFile | undefined;
  let mediaType: string | undefined;
  if (Array.isArray(message.photo) && message.photo.length > 0) {
    // A photo comes in several sizes, smallest first; the last is the picture as sent.
    wire = message.photo.at(-1) as WireFile;
    mediaType = "image/jpeg";
  } else {
    const field = FILE_FIELDS.find(name => typeof message[name] === "object" && message[name] !== null);
    if (field) wire = message[field] as WireFile;
  }
  if (!wire || typeof wire.file_id !== "string") return undefined;
  if (typeof wire.mime_type === "string") mediaType = wire.mime_type;
  return {
    fileId: wire.file_id,
    ...(typeof wire.file_name === "string" ? { filename: wire.file_name } : {}),
    ...(mediaType ? { mediaType } : {}),
    ...(typeof wire.file_size === "number" ? { size: wire.file_size } : {}),
  };
}

function toButtons(message: WireMessage): TelegramButton[][] {
  const rows: TelegramButton[][] = [];
  for (const row of message.reply_markup?.inline_keyboard ?? []) {
    const buttons: TelegramButton[] = [];
    for (const button of Array.isArray(row) ? row : []) {
      if (typeof button?.text !== "string") continue;
      if (typeof button.url === "string") buttons.push({ text: button.text, url: button.url });
      else if (typeof button.callback_data === "string") buttons.push({ text: button.text, data: button.callback_data });
    }
    if (buttons.length > 0) rows.push(buttons);
  }
  return rows;
}

export function toMessage(message: WireMessage, botId: string): TelegramMessage {
  const attachment = ATTACHMENT_FIELDS.find(field => message[field] !== undefined);
  const from = toSender(message);
  const text = message.text ?? message.caption;
  const file = messageFile(message);
  const buttons = toButtons(message);
  return {
    id: String(message.message_id),
    chatId: String(message.chat.id),
    sentAt: new Date(message.date * 1000).toISOString(),
    ...(from ? { from } : {}),
    fromBot: message.from !== undefined && String(message.from.id) === botId,
    ...(text !== undefined ? { text } : {}),
    ...(attachment ? { attachment } : {}),
    ...(file ? {
      file: {
        ...(file.filename ? { filename: file.filename } : {}),
        ...(file.mediaType ? { mediaType: file.mediaType } : {}),
        ...(file.size !== undefined ? { size: file.size } : {}),
      },
    } : {}),
    ...(buttons.length > 0 ? { buttons } : {}),
    ...(message.reply_to_message ? { replyTo: String(message.reply_to_message.message_id) } : {}),
  };
}

/** A sender as agents see one. */
export function toUser(user: WireUser): TelegramSender {
  return {
    id: String(user.id),
    name: fullName(user) || user.username || String(user.id),
    ...(user.username ? { username: user.username } : {}),
    isBot: user.is_bot,
  };
}

/** The button press an update carries, if it is a well-formed one under a message. */
export function updatePress(update: WireUpdate)
    : { id: string; from: WireUser; chat: WireChat; messageId: string; data: string } | undefined {
  const query = update.callback_query;
  if (!query || typeof query.id !== "string" || typeof query.data !== "string" ||
      typeof query.from?.id !== "number" || typeof query.message?.message_id !== "number" ||
      typeof query.message.chat?.id !== "number") {
    return undefined;
  }
  return {
    id: query.id, from: query.from, chat: query.message.chat,
    messageId: String(query.message.message_id), data: query.data,
  };
}

/**
 * The reaction change an update carries, if it is a well-formed one. Only standard emoji are
 * kept; a custom or paid reaction is left out of both lists.
 */
export function updateReaction(update: WireUpdate): {
  chat: WireChat; messageId: string; from?: WireUser; date: number; emoji: string[]; previous: string[];
} | undefined {
  const reaction = update.message_reaction;
  if (!reaction || typeof reaction.chat?.id !== "number" || typeof reaction.message_id !== "number" ||
      typeof reaction.date !== "number" || !Array.isArray(reaction.old_reaction) ||
      !Array.isArray(reaction.new_reaction)) {
    return undefined;
  }
  const emoji = (list: WireReaction[]) => list.flatMap(entry =>
    entry?.type === "emoji" && typeof entry.emoji === "string" ? [entry.emoji] : []);
  return {
    chat: reaction.chat, messageId: String(reaction.message_id), date: reaction.date,
    ...(typeof reaction.user?.id === "number" ? { from: reaction.user } : {}),
    emoji: emoji(reaction.new_reaction), previous: emoji(reaction.old_reaction),
  };
}

/** The message an update carries, or undefined for update kinds this gatekeeper ignores. */
export function updateMessage(update: WireUpdate): WireMessage | undefined {
  const message = update.message ?? update.channel_post;
  if (!message || typeof message.message_id !== "number" || typeof message.date !== "number" ||
      typeof message.chat?.id !== "number") {
    return undefined;
  }
  return message;
}
