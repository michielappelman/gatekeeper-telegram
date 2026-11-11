# Agent guide

## What this repository is

`gatekeeper-telegram` is a Cloudflare Worker package for Cloudflare OS. It gives agents a scoped,
approval-controlled connection to a user's chats with the deployment's one Telegram bot:

- `CHAT_RESOURCE` (`https://t.me/<bot>/chat/<chat id>`) binds exactly one linked chat.
- `BOT_RESOURCE` (`https://t.me/<bot>`) binds all of the user's linked chats, including ones
  linked later.

Agents read the messages the bot received, queue sends, edits, button changes, reactions and
deletes for approval, and receive messages, button presses and reactions through hooks.

This repository is normally a Git submodule under `cloudflare-os-starter/packages/`. It is not a
standalone npm package: `@gadgets/*` dependencies resolve from the consuming Cloudflare OS
workspace.

Read [README.md](README.md) for deployment and user-facing behavior. Use this file for the
implementation constraints that are easy to miss.

## Related repositories and references

- [Cloudflare OS starter](https://github.com/michielappelman/cloudflare-os-starter): the consuming
  workspace and deployment host. In this workspace it is normally available at
  `../cloudflare-os-starter/`. Its `scripts/deploy.ts` declares `TELEGRAM_BOT_TOKEN` as this
  Worker's required secret and sets `BASE_URL`.
- [`@gadgets/gatekeeper-kit`](https://github.com/michielappelman/cloudflare-os/tree/main/packages/gatekeeper-kit):
  the shared library used for connect pages, nonces, the hook delivery queue, observer checks,
  action descriptions and subresource ids. Use the copy pinned by the starter
  (`../cloudflare-os-starter/cloudflare-os/packages/gatekeeper-kit/`). Read its `AGENTS.md`,
  `README.md`, and `USAGE.md` before changing those integrations.
- [Telegram Bot API](https://core.telegram.org/bots/api): the protocol contract for the direct
  client. [Bot features](https://core.telegram.org/bots/features) covers privacy mode, deep links
  (`?start=`, `?startgroup=`) and inline keyboards.

## Start here

1. Check `git status` before editing and preserve unrelated worktree changes.
2. Read `src/types.d.ts` for the agent-facing `TelegramBot`, `TelegramChat`,
   `TelegramMessageHandle` and `TelegramMessageHook` contracts.
3. Read `src/resource.ts` for the two resource URLs, their strict parser, and the subresource ids.
4. Read the header comment of `src/hub.ts`: it states who owns a chat and what is stored.
5. Read the focused tests before changing Bot API request shapes, action handling, or linking.

The important code paths are:

```text
src/telegram.ts       Worker entrypoint (webhook + connect routes), GatekeeperVendor,
                      TelegramAccount, TelegramVerifier, TelegramHookController,
                      TelegramGatekeeperImpl DO, bot/chat/message session classes, configurator RPC
src/hub.ts            TelegramBotHub DO: token use, webhook registration, chats, messages, link
                      codes, hook registrations and the delivery queue
src/connect.ts        TelegramConnect DO and the connect page (link code, polling, handoff)
src/commands.ts       /start, /link, /addgroup, /unlink parsing, link codes, the bot's replies
src/actions.ts        PendingAction shapes, approval descriptions, auto-approval rule tags,
                      pending-read simulation, file blobs kept until approval
src/telegram-api.ts   Bot API fetch client, limits and validation, TelegramError codes,
                      wire-to-agent conversions, ALLOWED_UPDATES / WEBHOOK_VERSION
src/resource.ts       Resource URLs and subresource ids
src/configurator/     Chat picker and all-chats confirmation: source UI and RPC types; the built
                      UI lands in src/generated/
__tests__/            actions, commands, connect, hub, resource, session and Bot API tests
vitest.config.ts      Also holds fakeTelegram, the Bot API stub every test talks to
```

## Non-negotiable invariants

Identity that is already deployed:

- Resource `urlPattern`s are permanent. Changing one breaks every existing binding.
- Auto-approval tags are stored in users' rules: `send-message`, `send-media`, `update-message`,
  `react-message`, and the per-group form `<family>:chat:<chat id>`. Never rename a tag, and never
  let an existing tag start covering something new. A new kind of action gets a new tag.
- Durable Object migrations in `cloudflare.config.ts` are append-only. Never edit or reorder a
  deployed tag. `TelegramBotHub` is addressed as `getByName("bot")`; that name is identity too.
- A `PendingAction` without `type` is a text send queued before the other kinds existed. Keep
  reading it.

The token:

- `TELEGRAM_BOT_TOKEN` is read from the secret on each use. Never store it, return it over RPC, or
  put it in a log line. Only its fingerprint is kept.
- Every Bot API URL contains the token. Nothing in `src/telegram-api.ts` may put a URL, a request,
  or a raw `fetch` error that names one into an error message or a log line.

The webhook:

- A delivery is trusted only through `X-Telegram-Bot-Api-Secret-Token`, compared in constant time
  in the hub. Keep the 401 before any use of the body, and keep the path free of data: the
  `webhook/` path bypasses Cloudflare Access, so it is reachable by anyone.
- Changing `ALLOWED_UPDATES` requires bumping `WEBHOOK_VERSION`, or Telegram keeps sending the old
  list.
- The webhook answers Telegram with a method call in the HTTP response (a reply, or
  `answerCallbackQuery`). Do not block that response on hook delivery; deliveries go through the
  queue.

Who sees what:

- The hub serves each account its own chats alone. Every hub method that returns chat data takes
  an account id and checks ownership; never add one that looks a chat up by id only.
- Updates from chats no account linked are neither stored nor delivered. The only response is the
  rate-limited "private bot" notice.
- The bot's own commands are handled by the gatekeeper and never stored or delivered to agents.
- Only a connected person can link a group, and a group belongs to whoever linked it first.
  Linking never grants an agent anything: a chat reaches agents only through a binding.
- Every read that returns data reports its subresource through the typed `authorize()` helper:
  `chatSubresource(chatId)` for a chat's info, messages, files and hook deliveries,
  `accountSubresource(accountId)` for the chat list. Only the bot's public identity reports `[]`.
  `verifyObserverAccess()` admits a collaborator only for chats linked to their own account.

Actions:

- Everything except reading goes through `submitAction` and is applied only on approval.
  `delete` has no rule family (`familyOf()` returns `undefined`): it is always approved by a
  person. Do not make it auto-approvable.
- Pictures and files keep their own rule because the approver sees a filename, type, size and
  SHA-256, not the content. Do not fold `send-media` into `send-message`.
- File bytes stay in the binding's storage, chunked under the per-value limit, until the action is
  decided, and are deleted then, on approval and on rejection alike. Nothing is uploaded early.
- Validate before queueing: limits, the reaction emoji set (`REACTION_EMOJI`), and that an edit,
  button change or delete targets one of the bot's own, already sent messages. An approver should
  never be asked about something Telegram would refuse.
- A `data` button is refused unless an enabled hook of the account watches the chat
  (`requirePressListener`). Keep the check: a press with no listener is a dead button.
- Reads show pending actions (`pendingMessage`, `withPendingChanges`). Keep new action kinds
  consistent with that, or state in the README why one is not simulated (reactions are not part of
  a message).

`src/types.d.ts` is the agents' only documentation of the API, and `src/types.txt` is a symlink to
it (never a copy). Its JSDoc is agent-facing: never mention approvals, storage or internals there.

## Bot API boundary

Keep Telegram's wire shapes inside `src/telegram-api.ts`. Sessions and the hub work with the
agent-facing types from `src/types.d.ts` and with `TelegramError` codes, never with raw response
bodies.

When changing protocol code:

- Update `__tests__/telegram-api.test.ts`, and extend `fakeTelegram` in `vitest.config.ts` when a
  new Bot API method is called. Unknown methods answer 502 there on purpose.
- Preserve the JSON versus `multipart/form-data` split: uploads are multipart, with
  `reply_markup` and `reply_parameters` JSON-encoded as fields.
- Keep the 10 MB caps (`MAX_PHOTO_BYTES`, `MAX_FILE_BYTES`) aligned with what a binding can hold
  while an action waits, and check a download's size before and after reading it.
- Map new failures to an existing `TelegramErrorCode` where one fits.

## Storage and hooks

- The hub keeps the newest 1,000 messages per chat (`MESSAGES_KEPT_PER_CHAT`). Telegram has no
  history a bot can read back, so what is trimmed is gone; a handle to a trimmed message throws.
- Hook registrations are per account, optionally per chat. Deliveries (message, press, reaction)
  go through gatekeeper-kit's `HookDeliveryQueue` with retries, driven by the hub's alarm, which
  also runs the daily webhook check.
- A hook lacking `receiveButtonPress()` or `receiveReaction()` is detected from the RPC error
  (`isMissingMethod`) and flagged (`ignoresPresses`, `ignoresReactions`) so it is not asked again.
  A flagged hook does not count as a press listener.
- Link codes live 15 minutes and work once. `TelegramConnect` holds one connect flow and cleans
  itself up by alarm when the flow times out.

## Development and verification

Run commands from the consuming starter after the submodule and Cloudflare OS workspace are
initialized:

```sh
pnpm --filter gatekeeper-telegram test:run
pnpm --filter gatekeeper-telegram types:check
```

The package scripts are also available directly:

```sh
pnpm test:run
pnpm types:check
pnpm deploy
```

The configurator UI source is under `src/configurator/`; generated `.txt` assets under
`src/generated/` are produced by the package build (`vp run -F gatekeeper-telegram --no-cache
build:configurator`), are not committed, and must exist before tests or type checks can import
them. The Worker config is authored in `cloudflare.config.ts`; `wrangler.jsonc` is generated from
it, so never edit it by hand: change `cloudflare.config.ts`, run `pnpm configs:generate` from the
starter root (`pnpm configs:check` fails on a stale file), and regenerate
`worker-configuration.d.ts` with `pnpm --filter gatekeeper-telegram exec wrangler types` when
bindings or Durable Object classes change.

Tests run in workerd and reach only `fakeTelegram`; they need no bot and no token. Nothing here is
verified against the live Bot API by the suite, so say which behavior was checked against a real
bot and which was not.

A change lands by committing here and bumping the gitlink in the starter, never by editing the
checked-out copy under `packages/` in place and leaving it uncommitted. If the local package
manager or workspace links are unavailable, report that explicitly rather than claiming tests
passed. At minimum run `git diff --check` and inspect the final diff.
