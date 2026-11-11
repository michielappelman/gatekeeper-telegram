/**
 * The bot's own commands, which connected people send in Telegram to link and unlink chats. They are
 * handled by the gatekeeper, never stored or delivered to agents.
 */

export type BotCommand =
  /** `/start <code>`: link the sender, and their private chat, with the code's Workshop user. */
  | { kind: "start"; code?: string }
  /** `/link`: link a group to the sender's Workshop user. */
  | { kind: "link" }
  /** `/addgroup`: in a private chat, offer a button that adds the bot to a group. */
  | { kind: "addgroup" }
  /** `/unlink`: unlink this chat (and, in a private chat, the sender). */
  | { kind: "unlink" };

/**
 * The command a message's text is, or undefined. In groups Telegram appends the bot's username
 * (`/link@family_bot`); a command addressed to another bot is not this bot's.
 */
export function parseCommand(text: string | undefined, botUsername: string): BotCommand | undefined {
  const match = /^\/([a-z]+)(?:@([A-Za-z0-9_]+))?(?:\s+(\S+))?\s*$/i.exec(text?.trim() ?? "");
  if (!match) return undefined;
  const [, name, addressee, argument] = match;
  if (addressee !== undefined && addressee.toLowerCase() !== botUsername.toLowerCase()) return undefined;
  switch (name.toLowerCase()) {
    case "start": return { kind: "start", ...(argument !== undefined ? { code: argument } : {}) };
    case "link": return { kind: "link" };
    case "addgroup": return { kind: "addgroup" };
    case "unlink": return { kind: "unlink" };
    default: return undefined;
  }
}

/** A link code: 24 characters of Telegram's deep-link alphabet, carrying 144 random bits. */
export function newLinkCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_");
}

export const LINK_CODE_PATTERN = /^[A-Za-z0-9_-]{24}$/;

/** What the bot answers, in plain words for the people using the bot. */
export const REPLIES = {
  linked: "Linked to your Cloudflare OS. Go back to the connect page there to finish. " +
    "To use me in a group, tap Add to a group.",
  groupLinked: "Linked this group to your Cloudflare OS. Agents can use it once you connect it to a " +
    "gadget there.",
  addGroup: "Tap Add to a group and pick one. I link it to your Cloudflare OS as soon as I'm in.",
  badCode: "That link has expired or was already used. Start connecting Telegram in Cloudflare OS again.",
  linkFirst: "Link your own Telegram first: in Cloudflare OS, open Connectors and connect Telegram.",
  alreadyLinked: "This group is already linked to your Cloudflare OS.",
  groupTaken: "This group is already linked to someone else's Cloudflare OS. They can send /unlink here.",
  groupOnly: "Send /link in a group to link it, or send /addgroup here for a button that adds me to one.",
  unlinked: "Unlinked. Cloudflare OS no longer reads or sends messages in this chat.",
  notYours: "Only the person who linked this chat can unlink it.",
  notLinked: "This chat isn't linked to Cloudflare OS.",
  private: "This is a private bot. To use it, connect Telegram in Cloudflare OS.",
} as const;

/**
 * The button under a reply that adds the bot to a group the user picks. Only connected people get
 * it, and the group links to whoever pressed it (see the hub's `/start` handling in groups).
 */
export function addGroupButton(botUsername: string): { text: string; url: string } {
  // Telegram opens a group picker, adds the bot, and has the person send /start in the group.
  return { text: "Add to a group", url: `https://t.me/${botUsername}?startgroup=link` };
}
