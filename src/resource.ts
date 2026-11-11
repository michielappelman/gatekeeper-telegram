/**
 * The grantable resources -- all of the user's chats with the bot, or one of them -- and the
 * subresource IDs reads report.
 *
 * A resource's `urlPattern` is permanent identity: never change it after deploy.
 */

import type { SupportedResource } from "@gadgets/workshop-shared/gatekeeper";
import { formatSubresourceId } from "@gadgets/gatekeeper-kit/subresource-ids";
import { isChatId, TelegramError } from "./telegram-api";

const HOST = "t.me";

export const CHAT_RESOURCE: SupportedResource = {
  urlPattern: `https://${HOST}/:bot/chat/:chatId`,
  title: "Telegram chat",
  description: "One of your linked Telegram chats: read, receive and send messages.",
};

export const BOT_RESOURCE: SupportedResource = {
  urlPattern: `https://${HOST}/:bot`,
  title: "All your Telegram chats",
  description: "Every chat you link with the family bot, including ones you link later.",
};

export const SUPPORTED_RESOURCES: SupportedResource[] = [CHAT_RESOURCE, BOT_RESOURCE];

export function botResourceUrl(botUsername: string): string {
  return `https://${HOST}/${botUsername}`;
}

const USERNAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{3,31}$/;

export function chatResourceUrl(botUsername: string, chatId: string): string {
  return `https://${HOST}/${botUsername}/chat/${chatId}`;
}

/**
 * What a resource URL names: one chat, or (no chatId) all the user's chats. The bot is the
 * deployment's, so its name is only checked.
 */
export function parseResourceUrl(url: string): { botUsername: string; chatId?: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new TelegramError("BAD_REQUEST", "Not a valid resource URL.");
  }
  const segments = parsed.pathname.split("/").slice(1);
  if (parsed.protocol === "https:" && parsed.hostname === HOST && !parsed.search && !parsed.hash &&
      segments.length === 1 && USERNAME_PATTERN.test(segments[0])) {
    return { botUsername: segments[0] };
  }
  if (parsed.protocol === "https:" && parsed.hostname === HOST && !parsed.search && !parsed.hash &&
      segments.length === 3 && USERNAME_PATTERN.test(segments[0]) && segments[1] === "chat" &&
      isChatId(segments[2])) {
    return { botUsername: segments[0], chatId: segments[2] };
  }
  throw new TelegramError("BAD_REQUEST",
    `Telegram resource URLs are https://${HOST}/<bot> or https://${HOST}/<bot>/chat/<chat id>.`);
}

// Subresource IDs. The bot is fixed by the deployment's configuration, so IDs name no bot. A chat's
// messages are its owner's: the user who linked it. The list of a user's chats is private to that
// user's account.

export function chatSubresource(chatId: string): string {
  return formatSubresourceId({ fragments: [{ name: "chat", id: chatId }] });
}

export function accountSubresource(accountId: string): string {
  return formatSubresourceId({ fragments: [{ name: "account", id: accountId }] });
}

export type ReportedSubresource = { kind: "chat"; chatId: string } | { kind: "account"; accountId: string };

/** What a subresource ID this gatekeeper reports names, or undefined for any other ID. */
export function parseSubresource(id: string): ReportedSubresource | undefined {
  const chat = /^chat\/(-?[1-9]\d{0,19})$/.exec(id);
  if (chat) return { kind: "chat", chatId: chat[1] };
  const account = /^account\/([0-9a-f-]{36})$/.exec(id);
  if (account) return { kind: "account", accountId: account[1] };
  return undefined;
}
