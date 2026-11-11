/**
 * What a binding can ask of the bot besides reading: the actions it queues for approval, what the
 * approver is shown for each, the rules that may approve them, and how a queued action already
 * shows in what the agent reads.
 */

import { buildDescription } from "@gadgets/gatekeeper-kit/action-description";
import type { ActionDescription, ActionKind } from "@gadgets/workshop-shared/gatekeeper";
import type { SendOptions } from "./telegram-api";
import type { TelegramButton, TelegramChatInfo, TelegramMessage } from "./types";

/** A file kept until its send is approved: what it is, and how many chunks hold its bytes. */
export type StoredFile = {
  filename: string;
  mediaType: string;
  size: number;
  sha256: string;
  chunks: number;
};

/**
 * An action waiting to be approved, kept so it can be carried out and so reads already show it.
 * A record without `type` is a text message queued before the other kinds existed.
 */
export type PendingAction = { chatId: string; submittedAt: number } & (
  | { type?: "text"; text: string; options: SendOptions }
  | { type: "media"; media: "photo" | "document"; file: StoredFile; caption?: string; options: SendOptions }
  | { type: "edit"; messageId: string; text: string; options: { format?: "plain" | "markdown"; buttons?: TelegramButton[][] } }
  | { type: "buttons"; messageId: string; buttons: TelegramButton[][] }
  | { type: "delete"; messageId: string }
  | { type: "react"; messageId: string; emoji: string | null }
);

/** `PendingAction` without what the binding fills in when it queues one. */
export type NewAction = PendingAction extends infer A
  ? A extends PendingAction ? Omit<A, "submittedAt"> : never
  : never;

// ---------------------------------------------------------------------------
// Auto-approval rules. A tag is stored in users' rules: never rename one, and never let an
// existing tag start covering something new.

/**
 * What a rule covers: text messages, pictures and files, edits of the bot's own messages, or
 * reactions. Edits and reactions are separate because they differ in weight: an edit rewrites what
 * the bot told people, a reaction is one emoji. `update-message` covered both for a day; it kept
 * the edits, so a rule someone enabled then covers less than it did, never more.
 */
export type RuleFamily = "send-message" | "send-media" | "update-message" | "react-message";

const FAMILY_LABEL: Record<RuleFamily, string> = {
  "send-message": "Send Telegram messages",
  "send-media": "Send Telegram pictures and files",
  "update-message": "Edit Telegram messages",
  "react-message": "React to Telegram messages",
};

/** Families that act on messages already in a chat, rather than sending to it. */
const IN_CHAT = new Set<RuleFamily>(["update-message", "react-message"]);

export const RULE_FAMILIES = Object.keys(FAMILY_LABEL) as RuleFamily[];

/** The rule for a one-chat binding's own chat. */
export function chatKind(family: RuleFamily): ActionKind {
  return { tag: family, label: FAMILY_LABEL[family] };
}

/** The same rule as the user's bot offers it: for their own private chat with the bot. */
export function selfKind(family: RuleFamily): ActionKind {
  return {
    tag: family,
    label: `${FAMILY_LABEL[family]} ${IN_CHAT.has(family) ? "in your own chat" : "to yourself"}`,
  };
}

/**
 * The rule for one group through the user's bot, so enabling it lets agents act in that group
 * alone. The tag's shape is stored in users' rules: never change it.
 */
export function groupKind(family: RuleFamily, chat: Pick<TelegramChatInfo, "id" | "title">): ActionKind {
  return {
    tag: `${family}:chat:${chat.id}`,
    label: `${FAMILY_LABEL[family]} ${IN_CHAT.has(family) ? "in" : "to"} ${chat.title}`,
  };
}

/** Sending text to one group: the rule this gatekeeper started with. */
export function groupSendKind(chat: Pick<TelegramChatInfo, "id" | "title">): ActionKind {
  return groupKind("send-message", chat);
}

/** The family that may approve an action, or `undefined` for one a person always approves. */
export function familyOf(action: NewAction): RuleFamily | undefined {
  switch (action.type) {
    case undefined:
    case "text": return "send-message";
    case "media": return "send-media";
    case "edit":
    case "buttons": return "update-message";
    case "react": return "react-message";
    // Opt-out rule 1 of the write-gatekeeper skill: it deletes content.
    case "delete": return undefined;
  }
}

// ---------------------------------------------------------------------------
// Approval descriptions

/** One line per button: what it says and what pressing it does. */
export function buttonRows(buttons: TelegramButton[][]): string[] {
  return buttons.flatMap((row, index) => row.map(button => {
    const effect = "url" in button ? `opens ${button.url}` : `reports "${button.data}"`;
    return `Row ${index + 1}: [${button.text}] ${effect}`;
  }));
}

type Context = {
  chatTitle: string;
  botUsername: string;
  /** The rule that may auto-approve this, decided by the caller; without one, a person approves. */
  kind: ActionKind | undefined;
  /** The message an edit, deletion or reaction is about, as it is now, when it is still kept. */
  target?: TelegramMessage;
};

function policy(kind: ActionKind | undefined): Pick<ActionDescription, "autoApprovable" | "actionKind"> {
  return kind ? { autoApprovable: true, actionKind: kind } : { autoApprovable: false };
}

/** Who wrote the target and what it says, for the approver to recognise it by. */
function targetFields(builder: ReturnType<typeof buildDescription>, messageId: string, target?: TelegramMessage) {
  builder.inline("Message", messageId);
  if (target?.from?.name) builder.inline("From", target.from.name);
  if (target?.text) builder.verbatim(target.fromBot ? "Current text" : "Its text", target.text);
  else if (target?.attachment) builder.inline("It carries", target.attachment);
}

/** What the person approving a text message sees. */
export function describeSend(send: {
  chatTitle: string;
  botUsername: string;
  text: string;
  options: SendOptions;
  kind: ActionKind | undefined;
}): ActionDescription {
  const { chatTitle, botUsername, text, options } = send;
  return {
    title: `Send a Telegram message to ${chatTitle}`,
    description: `Send this message to ${chatTitle} as @${botUsername}.`,
    fields: [
      { label: "Chat", kind: "inline", value: chatTitle },
      { label: "Message", kind: "text", value: text },
      ...(options.replyTo !== undefined ? [{ label: "In reply to", kind: "inline" as const, value: options.replyTo }] : []),
      ...(options.format === "markdown" ? [{ label: "Format", kind: "inline" as const, value: "MarkdownV2" }] : []),
      ...(options.buttons?.length ? [{ label: "Buttons", kind: "list" as const, items: buttonRows(options.buttons) }] : []),
    ],
    implementsRevert: false,
    ...policy(send.kind),
  };
}

/** What the person approving any queued action sees. */
export function describeAction(action: NewAction, context: Context): ActionDescription {
  const { chatTitle, botUsername, kind, target } = context;
  switch (action.type) {
    case undefined:
    case "text":
      return describeSend({ chatTitle, botUsername, text: action.text, options: action.options, kind });

    case "media": {
      const what = action.media === "photo" ? "picture" : "file";
      const builder = buildDescription(
        `Send this ${what} to ${chatTitle} as @${botUsername}. Its content is not shown here: only ` +
        "its name, type, size and checksum are.")
        .inline("Chat", chatTitle)
        .file(action.media === "photo" ? "Picture" : "File", {
          name: action.file.filename, mediaType: action.file.mediaType, size: action.file.size,
          sha256: action.file.sha256, origin: "agent",
        });
      if (action.caption) builder.verbatim("Caption", action.caption);
      if (action.options.replyTo !== undefined) builder.inline("In reply to", action.options.replyTo);
      if (action.options.format === "markdown") builder.inline("Format", "MarkdownV2");
      if (action.options.buttons?.length) builder.list("Buttons", buttonRows(action.options.buttons));
      return {
        title: `Send a ${what} to ${chatTitle} on Telegram`,
        ...builder.finish(), implementsRevert: false, ...policy(kind),
      };
    }

    case "edit": {
      const builder = buildDescription(
        `Replace the text of one of @${botUsername}'s messages in ${chatTitle}. Buttons not listed ` +
        "below are removed from it.")
        .inline("Chat", chatTitle);
      targetFields(builder, action.messageId, target);
      builder.verbatim("New text", action.text);
      if (action.options.format === "markdown") builder.inline("Format", "MarkdownV2");
      if (action.options.buttons?.length) builder.list("Buttons", buttonRows(action.options.buttons));
      return {
        title: `Edit a Telegram message in ${chatTitle}`,
        ...builder.finish(), implementsRevert: false, ...policy(kind),
      };
    }

    case "buttons": {
      const builder = buildDescription(action.buttons.length > 0
        ? `Replace the buttons under one of @${botUsername}'s messages in ${chatTitle}.`
        : `Remove the buttons under one of @${botUsername}'s messages in ${chatTitle}.`)
        .inline("Chat", chatTitle);
      targetFields(builder, action.messageId, target);
      if (action.buttons.length > 0) builder.list("New buttons", buttonRows(action.buttons));
      return {
        title: `Change the buttons of a Telegram message in ${chatTitle}`,
        ...builder.finish(), implementsRevert: false, ...policy(kind),
      };
    }

    case "delete": {
      const builder = buildDescription(
        `Delete one of @${botUsername}'s messages in ${chatTitle}, for everyone in the chat.`)
        .inline("Chat", chatTitle);
      targetFields(builder, action.messageId, target);
      return {
        title: `Delete a Telegram message in ${chatTitle}`,
        ...builder.finish(), implementsRevert: false, ...policy(kind),
      };
    }

    case "react": {
      const builder = buildDescription(action.emoji === null
        ? `Remove @${botUsername}'s reaction from a message in ${chatTitle}.`
        : `React as @${botUsername} to a message in ${chatTitle}.`)
        .inline("Chat", chatTitle);
      if (action.emoji !== null) builder.inline("Reaction", action.emoji);
      targetFields(builder, action.messageId, target);
      return {
        title: `React to a Telegram message in ${chatTitle}`,
        ...builder.finish(), implementsRevert: false, ...policy(kind),
      };
    }
  }
}

// ---------------------------------------------------------------------------
// How queued actions show in what is read

/** The id a message has while its send waits; `sentMessageId` gives the real one afterwards. */
export const pendingId = (actionId: number) => `pending-${actionId}`;

/** The action a pending id names, or `undefined` for a real message id. */
export function pendingActionId(messageId: string): number | undefined {
  const match = /^pending-([1-9]\d{0,15})$/.exec(messageId);
  return match ? Number(match[1]) : undefined;
}

/** A queued send as the message it will be, or `undefined` for an action that sends nothing. */
export function pendingMessage(actionId: number, action: PendingAction): TelegramMessage | undefined {
  if (action.type !== undefined && action.type !== "text" && action.type !== "media") return undefined;
  const base = {
    id: pendingId(actionId),
    chatId: action.chatId,
    sentAt: new Date(action.submittedAt).toISOString(),
    fromBot: true,
  };
  const tail = {
    ...(action.options.buttons?.length ? { buttons: action.options.buttons } : {}),
    ...(action.options.replyTo !== undefined ? { replyTo: action.options.replyTo } : {}),
  };
  if (action.type === "media") {
    return {
      ...base,
      ...(action.caption ? { text: action.caption } : {}),
      attachment: action.media,
      file: { filename: action.file.filename, mediaType: action.file.mediaType, size: action.file.size },
      ...tail,
    };
  }
  return { ...base, text: action.text, ...tail };
}

/**
 * `messages` as they will be once the queued edits, button changes and deletions of their chat are
 * carried out, oldest action first. Reactions are not part of a message, so they change nothing.
 */
export function withPendingChanges(messages: TelegramMessage[], pending: PendingAction[]): TelegramMessage[] {
  let result = messages;
  for (const action of pending) {
    if (action.type === "delete") {
      result = result.filter(message => message.id !== action.messageId || message.chatId !== action.chatId);
      continue;
    }
    if (action.type !== "edit" && action.type !== "buttons") continue;
    result = result.map(message => {
      if (message.id !== action.messageId || message.chatId !== action.chatId) return message;
      const { buttons: _replaced, ...rest } = message;
      const buttons = action.type === "edit" ? action.options.buttons : action.buttons;
      return {
        ...rest,
        ...(action.type === "edit" ? { text: action.text } : {}),
        ...(buttons?.length ? { buttons } : {}),
      };
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// File bytes, kept in the binding's own storage until the send is approved or rejected: nothing
// reaches Telegram before a person (or a rule they enabled) said so.

type BlobKv = {
  get<T>(key: string): T | undefined;
  put<T>(key: string, value: T): void;
  delete(key: string): unknown;
};

/** Under the 2 MiB a Durable Object's storage takes per value. */
const CHUNK_BYTES = 1024 * 1024;

const blobKey = (actionId: number, index: number) => `blob:${actionId}:${index}`;

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

/** Stores `bytes` for `actionId`, returning how many chunks hold them. */
export function storeBlob(kv: BlobKv, actionId: number, bytes: Uint8Array): number {
  const chunks = Math.ceil(bytes.byteLength / CHUNK_BYTES);
  for (let index = 0; index < chunks; index++) {
    // Copied, so a chunk never pins or aliases the caller's buffer.
    kv.put(blobKey(actionId, index), bytes.slice(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES));
  }
  return chunks;
}

/** The bytes stored for `actionId`, or `undefined` if any of them are gone. */
export function readBlob(kv: BlobKv, actionId: number, file: StoredFile): Uint8Array | undefined {
  const bytes = new Uint8Array(file.size);
  let offset = 0;
  for (let index = 0; index < file.chunks; index++) {
    const chunk = kv.get<Uint8Array | ArrayBuffer>(blobKey(actionId, index));
    if (chunk === undefined) return undefined;
    const view = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    if (offset + view.byteLength > file.size) return undefined;
    bytes.set(view, offset);
    offset += view.byteLength;
  }
  return offset === file.size ? bytes : undefined;
}

export function deleteBlob(kv: BlobKv, actionId: number, chunks: number): void {
  for (let index = 0; index < chunks; index++) kv.delete(blobKey(actionId, index));
}
