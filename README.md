# Telegram

Telegram is a Cloudflare OS gatekeeper that gives the agent and gadgets access to a user's chats
with one [Telegram bot](https://core.telegram.org/bots/api). The agent can read the messages the
bot receives, send text, pictures, files and buttons, edit and delete the bot's own messages,
react, and receive new messages, button presses and reactions through hooks. Everything except
reading waits for the user's approval; reads are recorded.

A deployment has **one bot**, shared by everyone on it (a family, a team). Its token is the
Worker's only secret. Each person connects their own Telegram to that bot from Connectors, and then
chooses per gadget which of their chats with it the gadget may use.

It acts as a **bot**, not as anyone's personal Telegram account: it sees the chats it is in, from
the moment they are linked, and nothing else.

## What a connection can do

| Capability | Methods | Needs approval |
|---|---|---|
| See the bot and your chats | `getInfo`, `listChats`, `getChat` | No (recorded) |
| Read messages | `listMessages`, `getMessage(id).get` | No (recorded) |
| Read a picture or file | `getMessage(id).readFile` | No (recorded) |
| Send text, with or without buttons | `sendMessage` | Yes, auto-approvable |
| Send pictures and files | `sendPhoto`, `sendFile` | Yes, auto-approvable (its own rule) |
| Edit the bot's own messages | `edit`, `setButtons` | Yes, auto-approvable |
| React to any message | `react` | Yes, auto-approvable |
| Delete the bot's own messages | `delete` | Yes, always by a person |
| Receive messages, presses and reactions | `subscribe` | The user enables each hook |

What a connection gets depends on what the user picks when adding it to a gadget:

| Resource | URL | Agent gets |
|---|---|---|
| Telegram chat | `https://t.me/<bot>/chat/<chat id>` | `TelegramChat`: one chat, its messages and their files, sending to it, changing the bot's messages in it, and a hook for it |
| All your Telegram chats | `https://t.me/<bot>` | `TelegramBot`: the bot's identity, every chat you linked (including ones linked later), any of them by id, and a hook for all of them |

## Setting up the bot (once per deployment)

1. In Telegram, open [@BotFather](https://t.me/BotFather), send `/newbot`, and pick a name and a
   username ending in `bot`.
2. Optional: send `/setprivacy` and turn
   [privacy mode](https://core.telegram.org/bots/features#privacy-mode) **off**, so the bot sees
   every message in linked groups. With it on, the bot sees only commands, @mentions and replies
   to it.
3. Store the token as the Worker's secret. The deploy refuses to run without it:

   ```sh
   pnpm exec wrangler secret put TELEGRAM_BOT_TOKEN --name <your telegram Worker name>
   ```

4. Let Telegram reach the webhook through Cloudflare Access (see
   [Receiving updates behind Cloudflare Access](#receiving-updates-behind-cloudflare-access)).

The webhook is registered the first time anyone uses the bot, and rechecked daily: if something
else takes the bot's webhook over, it is taken back. Rotating the token (BotFather `/revoke`) only
needs the secret updated; the webhook follows.

## Connecting your Telegram

1. In Cloudflare OS, open **Connectors**, choose **Telegram** and **Connect**. A page opens.
2. Press **Open Telegram** and then **Start** in the chat with the bot. With Telegram on another
   device, send the `/start <code>` the page shows instead. A code works once, for 15 minutes.
3. The page notices and finishes the connection by itself.

Your private chat with the bot is now linked. What you can send the bot:

| Command | Where | What it does |
|---|---|---|
| `/start <code>` | Private chat | Links your Telegram, and this chat, to the connection the code belongs to |
| `/addgroup` | Private chat | Answers with an **Add to a group** button: pick a group, the bot joins and links it to you |
| `/link` | A group the bot is in | Links that group to you |
| `/unlink` | Any linked chat | Unlinks it (only its owner can); in your private chat it also unlinks you |

Only a connected person can link a group, and a group belongs to whoever linked it. A second person
who sends `/link` there is told it is taken.

A linked chat is inert until you connect it to a gadget (Add connection, then **Telegram chat** or
**All your Telegram chats**), so linking a group never by itself gives an agent anything.

Removing the Telegram connection forgets all its links, chats and hooks. Connecting again moves
your Telegram account, and your private chat, to the new connection; groups stay with the
connection that linked them.

Messages in chats nobody linked are neither stored nor shown to any agent. A private chat, or a
group message that @mentions the bot, is answered (at most once a day) that the bot is private;
being added to a group, or anything else said there, gets no reply.

## Agent API

The full contract lives in [`src/types.d.ts`](src/types.d.ts). A one-chat binding is suggested as
`TELEGRAM_CHAT`, an all-chats binding as `TELEGRAM_BOT`.

```js
export default async function(self, env) {
  // Newest first. Only what the bot received since the chat was linked, plus what it sent.
  const { messages, nextCursor } = await env.TELEGRAM_CHAT.listMessages({ limit: 20 });

  // A picture or file a message carries, up to 10 MB.
  const scan = messages.find((m) => m.file?.mediaType === "application/pdf");
  if (scan) {
    const { content, filename } = await env.TELEGRAM_CHAT.getMessage(scan.id).readFile();
  }

  // Every send returns a handle to the message it becomes.
  const sent = await env.TELEGRAM_CHAT.sendMessage("Dinner is at *19:00*\\.", {
    format: "markdown",          // Telegram's MarkdownV2: escape _*[]()~`>#+-=|{}.!
    replyTo: messages[0]?.id,
  });
  await env.TELEGRAM_CHAT.getMessage(messages[0].id).react("👍");
}
```

The handle a send returns can `edit()`, `setButtons()` or `delete()` the message once it has
actually been sent; while its send still waits for approval those throw. The same handle follows
the message from pending to sent.

With an all-chats binding, pick the chat first:

```js
const chats = await env.TELEGRAM_BOT.listChats();          // most recently active first
const family = chats.find((c) => c.title === "Family");
await env.TELEGRAM_BOT.getChat(family.id).sendPhoto(
  { content: pngBytes, filename: "chart.png", mediaType: "image/png" },
  { caption: "This week's energy use" },
);
```

Limits the API enforces before anything is queued:

| What | Limit |
|---|---|
| Message text | 4096 characters |
| Caption | 1024 characters |
| Picture (`sendPhoto`) | JPEG, PNG or WEBP, 10 MB |
| File (`sendFile`), and any file read back | 10 MB |
| Buttons | 10 rows, 8 per row, 40 in all; button text 1 to 64 characters, `data` 1 to 64 bytes |
| `listMessages` page | 1 to 100, 50 by default |
| Reactions | Telegram's [fixed emoji set](https://core.telegram.org/bots/api#reactiontypeemoji); anything else throws at once |

Errors carry a stable `code` (`TelegramError` in `src/telegram-api.ts`): `BAD_REQUEST`,
`FORBIDDEN` (a person blocked the bot, or it left the group), `RATE_LIMITED`, `UNAVAILABLE`,
`AUTH_EXPIRED` or `INVALID_TOKEN` (the deployment's token needs attention).

## How a change runs

1. The call is validated against the limits above and against the chat: a message id must be one
   the chat still keeps, an edit or delete must target one of the bot's own messages, and a
   reaction emoji must be one Telegram offers. A bad call throws before anyone is asked.
2. The action is queued in the binding's `ApprovalQueue`. A send returns a handle with a
   `pending-<n>` id right away.
3. Reads already show what is waiting: a queued send appears in `listMessages()` and `get()`, and a
   queued edit, button change or delete is applied to the message it targets.
4. On approval the gatekeeper calls the Bot API and stores the resulting message. On rejection
   nothing is sent and the pending message disappears.

What the approver sees:

- **Text:** the message, the chat, and each button with what it does (the link it opens, or the
  `data` it reports).
- **Pictures and files:** filename, media type, size and SHA-256. The content is not shown, which
  is why they have their own auto-approval rule. The bytes stay in the binding's storage until the
  send is decided and are deleted then; nothing is uploaded to Telegram before approval.
- **Edits, button changes, reactions, deletes:** the message they act on and what changes.

Each connection offers four auto-approval rules per chat on its Auto-approval tab:

| Rule | Covers |
|---|---|
| Send Telegram messages | Text, with or without buttons |
| Send Telegram pictures and files | `sendPhoto` and `sendFile` |
| Edit Telegram messages | `edit` and `setButtons` on the bot's own messages |
| React to Telegram messages | The bot's emoji reaction, on anyone's message |

A one-chat binding has them for its chat. An all-chats binding has them for your own private chat
with the bot and once per linked group, so enabling one lets agents act in that group alone.
Deleting a message is never auto-approved.

## Buttons

`buttons` on any send is rows of
[inline keyboard](https://core.telegram.org/bots/api#inlinekeyboardmarkup) buttons. A button with
`url` opens a link and needs nothing else. A button with `data` reports its press to a hook:

```js
// server.js (the gadget): the persistent callback
class Answers extends RpcTarget {
  async receiveMessage(message) {}
  async receiveButtonPress(press) {
    if (press.data === "milk:yes") { /* ... */ }
    // Stop the choice being made twice.
    await env.TELEGRAM_CHAT.getMessage(press.messageId).setButtons([]);
  }
}

// Once, before any buttons are sent.
await env.TELEGRAM_CHAT.subscribe(await env.MY_GADGET[restore]({ type: "telegram" }));

await env.TELEGRAM_CHAT.sendMessage("Add milk to the order?", {
  buttons: [[{ text: "Yes", data: "milk:yes" }, { text: "No", data: "milk:no" }]],
});
```

- A `data` button is refused unless an enabled hook of the account already watches the chat and is
  not known to lack `receiveButtonPress()`. The error tells the agent to subscribe first, so a
  button never ends up with nothing listening.
- A press carries who pressed. In a group that can be anyone, so the gadget decides whose press
  counts.
- Telegram is told at once that the press arrived (the spinner on the button stops). Nothing else
  happens until the gadget acts.
- A press may be delivered more than once; remove or replace the buttons once it is handled.

## Hooks

`subscribe(callback)` binds a hook the user enables once. `callback` is a persistent stub (from
`ctx.restore()`), so it keeps receiving after the session ends. Deliveries are queued per hook and
retried.

| Callback | Called for | Notes |
|---|---|---|
| `receiveMessage(message)` | Each message the bot receives in the watched chats | Required |
| `receiveButtonPress(press)` | Each press of a `data` button | Optional |
| `receiveReaction(reaction)` | Each reaction set, changed or removed | Optional |

A hook without one of the optional methods is found out on the first delivery and not asked again.

Reactions have conditions Telegram sets:

- The webhook has to ask for `message_reaction`, which it does.
- In a **group**, Telegram sends them only when the bot is an **administrator**. A private chat
  needs nothing.
- A bot's own reactions are never reported.
- Custom and paid reactions are left out of the emoji lists, and the anonymous totals Telegram
  sends for channels are not asked for.

A reaction reports who reacted, the emoji they have on the message now and had before, and whether
the message is the bot's own, as far as it is still kept. Existing hooks need no new approval: a
reaction is recorded as an observation, like a message.

## Security

- **The token.** `TELEGRAM_BOT_TOKEN` is read from the Worker secret on each use. It is never
  stored, returned or logged; the hub keeps only an 8-byte SHA-256 fingerprint to notice a
  rotation. The Bot API puts the token in the request URL, so `src/telegram-api.ts` never puts a
  URL or a request into an error or a log line.
- **The webhook.** The gatekeeper gives Telegram a random secret in
  [`setWebhook`](https://core.telegram.org/bots/api#setwebhook). Telegram returns it in the
  `X-Telegram-Bot-Api-Secret-Token` header, it is compared in constant time, and a delivery without
  it is refused (401) before the body is used. The path (`webhook/bot`) carries no data and no
  capability. Bodies over 1 MB are refused.
- **Who owns a chat.** One Durable Object, `TelegramBotHub`, holds every chat and message and
  records which account linked each. Every call names an account and is served that account's
  chats alone. `getChat()` on a chat that is not yours throws.
- **Link codes.** A code is 144 random bits, works once, and expires after 15 minutes. It links a
  Telegram account to the connection that asked for it, nothing else.
- **Capability boundary.** A binding's chat lives in its resource URL, which `src/resource.ts`
  parses strictly: `https://t.me/<bot>` or `https://t.me/<bot>/chat/<chat id>`, no query, no
  fragment. A one-chat binding cannot be pointed at another chat.
- **Observers.** A chat's messages belong to the person who linked it. Reads report
  `chat/<chat id>` (a chat's info, messages, files and every hook delivery) or
  `account/<account id>` (the user's chat list); the bot's public identity reports nothing.
  `verifyObserverAccess()` passes a collaborator only for chats linked to their own account, so
  sharing a workspace never shows one person's Telegram to another.
- **Unlinked chats.** Updates from chats nobody linked are dropped: not stored, not delivered.
- **Untrusted content.** Messages come from whoever is in the chat. An agent that reads them can
  meet a prompt injection; in a group, check `from` before acting on a message, press or reaction.

## Why a bot

Telegram offers two ways in. The [Bot API](https://core.telegram.org/bots/api) is plain HTTPS with
a webhook, which fits a Worker and limits the gatekeeper to chats the bot was deliberately added
to. The alternative, a user client over MTProto, would act as a person's whole account: every chat,
every contact, with a long-lived session to guard. A bot is the smaller grant.

One bot for the deployment, instead of one per person, keeps setup to a single BotFather step and a
single secret, and lets a group be shared by a household while still belonging to one account.

```text
src/
  telegram.ts      Worker entrypoint: webhook route, vendor, account, gatekeeper DO, sessions
  hub.ts           TelegramBotHub: the bot's webhook, chats, messages, links and hook deliveries
  connect.ts       TelegramConnect: the connect page and its link-code flow
  commands.ts      The bot's own commands (/start, /link, /addgroup, /unlink) and its replies
  actions.ts       Queued actions, approval descriptions, auto-approval rules, pending reads
  telegram-api.ts  Bot API client, validation, wire-to-agent conversions
  resource.ts      Resource URLs and subresource ids
  configurator/    The chat picker and its RPC types
  types.d.ts       Agent-facing interfaces
```

## Deployment

This repository is consumed as a Git submodule by a
[`cloudflare-os-starter`](https://github.com/cloudflare/cloudflare-os-starter)-style deployment. It
is not an npm package: its `@gadgets/*` dependencies resolve from the Cloudflare OS workspace pinned
in the starter, which keeps the Gatekeeper Kit ABI aligned with the deployment.

From the root of the starter:

```sh
git submodule add https://github.com/michielappelman/gatekeeper-telegram.git packages/gatekeeper-telegram
git submodule update --init --recursive
pnpm install
```

The starter must include `packages/*` in `pnpm-workspace.yaml`, and its deploy wrapper must treat
`packages/gatekeeper-telegram` as the Telegram Worker package:

1. Use this package's `wrangler.jsonc` as the base config. It is generated from
   `cloudflare.config.ts`: edit that, then run `pnpm configs:generate` from the starter root.
2. Generate the production config with the deployment's account, Worker name, service bindings,
   `BASE_URL`, and observability settings, and declare `TELEGRAM_BOT_TOKEN` as a required secret.
3. Run `vp run -F gatekeeper-telegram --no-cache build` before deploying the Worker.
4. Deploy it before the Workshop and Router, which consume its service binding.
5. Pin the submodule commit in the starter and record it in the deployment inventory.

What the Worker needs:

- **Secret.** `TELEGRAM_BOT_TOKEN`, the token BotFather gave.
- **`BASE_URL`.** The public URL the router serves the gatekeeper on, for example
  `https://os.example.com/gatekeeper/telegram`. The connect page and the webhook live under it.
- **Bindings.** SQLite-backed Durable Objects only. Compatibility flags `nodejs_compat` and
  `allow_irrevocable_stub_storage`.
- **Routing.** The public router is the only route: the Worker needs no `workers.dev` or preview
  URL.

Durable Object migrations are append-only. `v0` created `UserAccount` and
`TelegramGatekeeperImpl`; `v1` replaced the per-connection `UserAccount` with the shared
`TelegramBotHub`; `v2` added `TelegramConnect`, the connect flow.

### Receiving updates behind Cloudflare Access

Telegram posts updates to `<BASE_URL>/webhook/bot`. When the deployment sits behind
[Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/), that one
path has to be reachable without a login:

- Add a self-hosted Access application for the router's hostname with path
  `gatekeeper/telegram/webhook/*`.
- Give it a single policy with action
  [**Bypass**](https://developers.cloudflare.com/cloudflare-one/policies/access/#bypass), include
  **Everyone**. The more specific path wins over the application protecting the host.

The bypass exposes nothing by itself: a request without Telegram's secret header is refused before
anything is read. The connect page (`<BASE_URL>/connect/...`) stays behind Access like the rest of
Cloudflare OS.

The webhook asks Telegram for `message`, `channel_post`, `callback_query` and `message_reaction`
updates. When that list changes (`ALLOWED_UPDATES` and `WEBHOOK_VERSION` in
`src/telegram-api.ts`), the hub registers the webhook again the next time the bot is used, or at
its daily check.

### Development

Run tests and type checks from the consuming starter once the Cloudflare OS submodule is
initialized:

```sh
pnpm --filter gatekeeper-telegram test:run
pnpm --filter gatekeeper-telegram types:check
```

Tests run in workerd against a fake Bot API (`fakeTelegram` in `vitest.config.ts`, wired in as
Miniflare's `outboundService`) and need no bot or token. Keep the Cloudflare OS submodule and this
gatekeeper pinned together: if either changes, run the gatekeeper tests, the starter's type checks,
and the full starter check before updating the submodule gitlinks. Implementation invariants for
contributors and agents are in [AGENTS.md](AGENTS.md).

## Known limits

- **No history.** Telegram keeps nothing a bot can read back, so a chat starts empty when it is
  linked. The gatekeeper keeps the newest 1,000 messages per chat.
- **Groups and privacy mode.** With privacy mode on (BotFather's default), the bot sees only
  commands, @mentions and replies to it in groups.
- **Reactions in groups need admin.** Telegram reports them only where the bot is an
  administrator.
- **10 MB.** Sends and reads are capped at 10 MB, below Telegram's own limits, so a file fits in
  the binding's storage while it waits for approval.
- **Not supported:** polls, albums, voice and video messages as such (send them as files), and
  editing a message that is still waiting for approval.
- **Deleting is time-limited.** Telegram lets a bot delete its own messages for 48 hours.
- **One bot per deployment.** Everyone shares it; a second bot needs a second deployment of the
  Worker.
- **Wording.** The bot's replies and the connector's texts call it the "family bot". They live in
  `src/commands.ts`, `src/resource.ts` and `GatekeeperVendor.describe()` in `src/telegram.ts`.
- **Not an identity provider.** `getAuthenticatedEmail()` returns `null`.

## License

[MIT](LICENSE)
