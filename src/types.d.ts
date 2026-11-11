import type { RpcStub, RpcTarget } from "cloudflare:workers";

/**
 * The deployment's shared Telegram bot, as one user reaches it: all their linked chats with it.
 *
 * Each person connects their own Telegram in Cloudflare OS (Connectors, Telegram); their private
 * chat with the bot is then linked, and so is any group they add the bot to. The bot only sees
 * messages sent after a chat was linked: Telegram keeps no history a bot can read back. In groups
 * it sees only messages that mention it, reply to it or start with a command, unless its privacy
 * mode is off.
 */
export interface TelegramBot extends RpcTarget {
  /** The bot's own identity. */
  getInfo(): Promise<TelegramBotInfo>;

  /** The user's linked chats, most recently active first. */
  listChats(): Promise<TelegramChatInfo[]>;

  /**
   * One of the user's linked chats, by the id `listChats()` or a received message gave. Its
   * methods throw if the chat isn't linked to the user.
   */
  getChat(chatId: string): TelegramChat;

  /**
   * Calls `callback.receiveMessage()` for every message the bot receives in the user's chats,
   * and `callback.receiveButtonPress()`, if it has one, for every press of a button there.
   *
   * `callback` must be a persistent stub, created with `ctx.restore()`: it keeps receiving
   * messages after this session ends.
   */
  subscribe(callback: RpcStub<TelegramMessageHook>): Promise<void>;
}

/** One of the user's linked chats: their private chat with the bot, or a group. */
export interface TelegramChat extends RpcTarget {
  /** What the chat is. */
  getInfo(): Promise<TelegramChatInfo>;

  /**
   * Messages in the chat, newest first: those the bot received since the chat was linked, and
   * those it sent. Pass the previous page's `nextCursor` to read older ones.
   */
  listMessages(options?: { limit?: number; cursor?: string }): Promise<TelegramMessagePage>;

  /**
   * Sends a text message to the chat as the bot, and returns the message it becomes.
   *
   * @param text The message, at most 4096 characters.
   */
  sendMessage(text: string, options?: TelegramSendOptions): Promise<TelegramMessageHandle>;

  /**
   * Sends a picture to the chat as the bot. Telegram compresses it; use `sendFile()` to deliver an
   * image untouched.
   *
   * @param photo A JPEG, PNG or WEBP image, at most 10 MB.
   * @param options.caption Text shown under the picture, at most 1024 characters.
   */
  sendPhoto(
    photo: TelegramUpload,
    options?: TelegramSendOptions & { caption?: string },
  ): Promise<TelegramMessageHandle>;

  /**
   * Sends a file of any kind to the chat as the bot, for the recipient to download.
   *
   * @param file The file, at most 10 MB.
   * @param options.caption Text shown under the file, at most 1024 characters.
   */
  sendFile(
    file: TelegramUpload,
    options?: TelegramSendOptions & { caption?: string },
  ): Promise<TelegramMessageHandle>;

  /**
   * A message in this chat, by the `id` a listing, a received message, a button press or
   * `TelegramMessageHandle.get()` gave. Its methods throw if the chat no longer keeps the message.
   */
  getMessage(messageId: string): TelegramMessageHandle;

  /**
   * Calls `callback.receiveMessage()` for every message the bot receives in this chat, and
   * `callback.receiveButtonPress()`, if it has one, for every press of a button there.
   *
   * `callback` must be a persistent stub, created with `ctx.restore()`: it keeps receiving
   * messages after this session ends.
   */
  subscribe(callback: RpcStub<TelegramMessageHook>): Promise<void>;
}

/** One message in a chat: read it, and for the bot's own messages change or delete it. */
export interface TelegramMessageHandle extends RpcTarget {
  /** The message as it is now. */
  get(): Promise<TelegramMessage>;

  /**
   * Reads the picture or file the message carries (`TelegramMessage.file`). Throws if it carries
   * none, or one over 10 MB.
   */
  readFile(): Promise<TelegramFileContent>;

  /**
   * Replaces the text of one of the bot's own messages, or the caption of a picture or file it
   * sent. Buttons are replaced too: pass the ones to keep, or none to remove them. Throws for
   * anyone else's message, and for a message that has not been sent yet.
   */
  edit(text: string, options?: { format?: "plain" | "markdown"; buttons?: TelegramButton[][] }): Promise<void>;

  /**
   * Replaces the buttons of one of the bot's own messages, leaving its text as it is; `[]` removes
   * them. Use it after a press, so a choice can't be made twice. Throws for anyone else's
   * message, and for a message that has not been sent yet.
   */
  setButtons(buttons: TelegramButton[][]): Promise<void>;

  /**
   * Deletes one of the bot's own messages, which Telegram allows for 48 hours after sending.
   * Throws for anyone else's message, and for a message that has not been sent yet.
   */
  delete(): Promise<void>;

  /**
   * Sets the bot's reaction to the message, replacing any it had; `null` removes it. Telegram
   * accepts only a fixed set of emoji, among them 👍 👎 ❤ 🔥 🎉 👏 😁 🤔 😢 👀 🙏 👌 💯 🤝 ✍ 🫡.
   * Any other emoji throws at once, ✅ and ☑ included: use 👍 or 👌 to confirm something.
   * Throws for a message that has not been sent yet.
   */
  react(emoji: string | null): Promise<void>;
}

/**
 * Implement this to receive messages, and button presses, from `subscribe()`.
 *
 * A gadget that asks a question with buttons needs both halves, the listener first:
 *
 *   // server.js (the gadget): the persistent callback
 *   class Answers extends RpcTarget {
 *     async receiveMessage(message) {}
 *     async receiveButtonPress(press) {
 *       // act on press.data, then stop the choice being made twice:
 *       await env.TELEGRAM_CHAT.getMessage(press.messageId).setButtons([]);
 *     }
 *   }
 *
 *   // once, before any buttons are sent
 *   await env.TELEGRAM_CHAT.subscribe(await env.MY_GADGET[restore]({ type: "telegram" }));
 *
 *   // then
 *   await env.TELEGRAM_CHAT.sendMessage("Add milk to the order?", {
 *     buttons: [[{ text: "Yes", data: "milk:yes" }, { text: "No", data: "milk:no" }]],
 *   });
 */
export interface TelegramMessageHook {
  /** Called once for each message the bot receives. */
  receiveMessage(message: TelegramMessage): Promise<void>;

  /**
   * Called each time someone presses a `data` button under one of the bot's messages. Optional:
   * leave it out to ignore presses. In a group anyone can press, so check `press.from` before
   * acting on a press that should only count from one person. A press may be delivered more than
   * once; remove or replace the buttons (`TelegramMessageHandle.setButtons()`) once it is handled.
   */
  receiveButtonPress?(press: TelegramButtonPress): Promise<void>;

  /**
   * Called each time someone sets, changes or removes their reaction on a message in the chat, the
   * bot's own or anyone else's (`reaction.onBotMessage` tells which). Optional: leave it out to
   * ignore reactions. Telegram only reports reactions in a group where the bot is an administrator
   * (a private chat needs nothing), never reports a bot's reactions, and may deliver one more than
   * once. In a group anyone can react, so check `reaction.from` before treating 👍 as an answer.
   */
  receiveReaction?(reaction: TelegramReactionChange): Promise<void>;
}

/** How a message is sent. */
export interface TelegramSendOptions {
  /** The `id` of a message in this chat to reply to. */
  replyTo?: string;
  /**
   * "plain" (the default) sends the text as written; "markdown" renders Telegram's MarkdownV2, in
   * which `_*[]()~\`>#+-=|{}.!` must be escaped with a backslash.
   */
  format?: "plain" | "markdown";
  /**
   * Buttons under the message, as rows from top to bottom: at most 10 rows of at most 8 buttons,
   * 40 in all. Keep a row to two or three buttons so they stay readable on a phone.
   *
   * A `data` button only does something if a hook is already listening: before sending one,
   * `subscribe()` a callback that implements `receiveButtonPress()`, and make sure the user has
   * enabled that hook. Sending a `data` button with no hook listening throws.
   */
  buttons?: TelegramButton[][];
}

/**
 * A button under a message. With `url` it opens that link (https or http) and needs nothing else.
 * With `data` it reports the press to `TelegramMessageHook.receiveButtonPress()`, which has to be
 * subscribed first (see `TelegramSendOptions.buttons`); `data` is at most 64 bytes and is never
 * shown to the person, so put the choice it stands for in it ("add:33693", "skip").
 */
export type TelegramButton =
  | { text: string; url: string }
  | { text: string; data: string };

/** A press of a `data` button. */
export interface TelegramButtonPress {
  /** The chat the message is in. */
  chatId: string;
  /** The `id` of the message the button is under. */
  messageId: string;
  /** The pressed button's `data`. */
  data: string;
  /** Who pressed it. */
  from: TelegramSender;
  /** When, as an ISO 8601 timestamp. */
  pressedAt: string;
}

/** One person's reaction to a message changing. */
export interface TelegramReactionChange {
  /** The chat the message is in. */
  chatId: string;
  /** The `id` of the message reacted to. */
  messageId: string;
  /** True when that message is one the bot sent, as far as it is still remembered. */
  onBotMessage: boolean;
  /** The emoji this person has on the message now. Empty when they removed their reaction. */
  emoji: string[];
  /** The emoji they had on it before. */
  previous: string[];
  /** Who reacted. Absent for an anonymous group administrator. */
  from?: TelegramSender;
  /** When, as an ISO 8601 timestamp. */
  reactedAt: string;
}

/** A picture or file to send. */
export interface TelegramUpload {
  content: ArrayBuffer | Uint8Array;
  /** The name the recipient sees and saves it under, e.g. "scan.pdf". */
  filename: string;
  /** Its media type, e.g. "image/png" or "application/pdf". */
  mediaType: string;
}

/** The content of a picture or file a message carries. */
export interface TelegramFileContent {
  content: ArrayBuffer;
  /** The file's name, when the sender's app gave one. */
  filename?: string;
  /** Its media type, when known; "image/jpeg" for a photo. */
  mediaType?: string;
}

/** A Telegram bot's identity. */
export interface TelegramBotInfo {
  /** Telegram's numeric id for the bot, as a string. */
  id: string;
  /** The bot's username, without the "@". */
  username: string;
  /** The bot's display name. */
  name: string;
}

/** A chat a bot is in. */
export interface TelegramChatInfo {
  /** Telegram's id for the chat, as a string (group ids are negative). */
  id: string;
  /** "private" for a one-to-one chat with a person; otherwise a group or channel. */
  type: "private" | "group" | "supergroup" | "channel";
  /** The group or channel title, or the person's name for a private chat. */
  title: string;
  /** The chat's public @username, without the "@", if it has one. */
  username?: string;
  /** When the bot last received a message here, as an ISO 8601 timestamp. */
  lastMessageAt?: string;
}

/** A page of messages, newest first. */
export interface TelegramMessagePage {
  messages: TelegramMessage[];
  /** Pass as `cursor` to read the next, older page; absent on the last page. */
  nextCursor?: string;
}

/** A message in a Telegram chat. */
export interface TelegramMessage {
  /** The message's id, unique within its chat. */
  id: string;
  /** The chat it was sent in. */
  chatId: string;
  /** When it was sent, as an ISO 8601 timestamp. */
  sentAt: string;
  /** Who sent it. Absent for a channel post signed by no one. */
  from?: TelegramSender;
  /** True for a message the bot itself sent. */
  fromBot: boolean;
  /** The text, or the caption of a photo, video or file. */
  text?: string;
  /**
   * What the message carries besides text, such as "photo", "video", "document", "voice",
   * "sticker" or "location".
   */
  attachment?: string;
  /**
   * Present when the attachment is a picture or file that `TelegramMessageHandle.readFile()` can
   * read.
   */
  file?: {
    /** The file's name, when the sender's app gave one. */
    filename?: string;
    mediaType?: string;
    /** Its size in bytes, when Telegram reports it. */
    size?: number;
  };
  /** The buttons under one of the bot's messages. */
  buttons?: TelegramButton[][];
  /** The `id` of the message this one replies to. */
  replyTo?: string;
}

/** The person or bot that sent a message. */
export interface TelegramSender {
  /** Telegram's numeric id for them, as a string. */
  id: string;
  /** Their name as they set it. */
  name: string;
  /** Their @username, without the "@", if they have one. */
  username?: string;
  /** True if the sender is a bot. */
  isBot: boolean;
}
