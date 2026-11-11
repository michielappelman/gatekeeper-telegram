/**
 * Connecting Telegram from Cloudflare OS: one page that links the person's Telegram account to a
 * new connection on the deployment's one shared bot.
 *
 * `connectAccount()` starts a TelegramConnect object holding the Workshop's callback, a nonce for
 * the page's URL, and a fresh account id. The page shows a link code for that account
 * (https://t.me/<bot>?start=<code>); once the person presses Start in Telegram, the bot's hub has
 * their private chat linked to the account, and the page completes the connection.
 */

import { DurableObject } from "cloudflare:workers";
import type { ConnectHandoff, GatekeeperConnectCallback, GatekeeperUser } from "@gadgets/workshop-shared/gatekeeper";
import {
  connectHandoffPageHtml,
  errorPageHtml,
  escapeHtml,
  htmlResponse,
  PAGE_STYLE,
} from "@gadgets/gatekeeper-kit/connect-pages";
import {
  CONNECT_TIMEOUT_MS,
  generateNonce,
  isLiveNonce,
  NONCE_BYTES,
  type TimedNonce,
} from "@gadgets/gatekeeper-kit/connect-nonce";
import type { HubEnv, LinkCode, TelegramBotHub } from "./hub";

type Flow = { accountId: string; nonce: TimedNonce; code?: LinkCode };

export type ConnectStatus =
  | { kind: "invalid" }
  | { kind: "waiting"; code: LinkCode }
  | { kind: "linked"; name: string };

type CompleteResult =
  | { kind: "invalid" }
  | { kind: "waiting"; code: LinkCode }
  | { kind: "ok"; handoff: ConnectHandoff };

function hub(exports: Cloudflare.Exports): DurableObjectStub<TelegramBotHub> {
  return exports.TelegramBotHub.getByName("bot");
}

// Typed by hand: Cloudflare.Exports is computed from this module's own exports, a cycle in which
// TypeScript resolves the class but not its namespace.
function flows(exports: Cloudflare.Exports): DurableObjectNamespace<TelegramConnect> {
  return exports.TelegramConnect as unknown as DurableObjectNamespace<TelegramConnect>;
}

/** One connect flow, from `connectAccount()` until the page completes or the flow times out. */
export class TelegramConnect extends DurableObject<HubEnv> {
  async start(callback: Fetcher<GatekeeperConnectCallback>): Promise<string> {
    const nonce = generateNonce();
    this.ctx.storage.kv.put("callback", callback);
    this.ctx.storage.kv.put<Flow>("flow", {
      accountId: crypto.randomUUID(),
      // The page polls while the person is in Telegram, so the nonce lives as long as the flow.
      nonce: { value: nonce, expiresAt: Date.now() + CONNECT_TIMEOUT_MS },
    });
    await this.ctx.storage.setAlarm(Date.now() + CONNECT_TIMEOUT_MS);
    return nonce;
  }

  #flow(nonce: string): Flow | undefined {
    const flow = this.ctx.storage.kv.get<Flow>("flow");
    return flow && isLiveNonce(flow.nonce, nonce, Date.now()) ? flow : undefined;
  }

  /** Where the flow stands, minting (or renewing) the link code the page shows. */
  async status(nonce: string): Promise<ConnectStatus> {
    const flow = this.#flow(nonce);
    if (!flow) return { kind: "invalid" };
    const person = await hub(this.ctx.exports).linkedPerson(flow.accountId);
    if (person) return { kind: "linked", name: person.title };
    let code = flow.code;
    if (!code || code.expiresAt - Date.now() < 60_000) {
      code = await hub(this.ctx.exports).createLinkCode(flow.accountId);
      this.ctx.storage.kv.put<Flow>("flow", { ...flow, code });
    }
    return { kind: "waiting", code };
  }

  /** Hands the connection to the Workshop once the person's Telegram is linked. */
  async complete(nonce: string): Promise<CompleteResult> {
    const status = await this.status(nonce);
    if (status.kind !== "linked") return status;
    const flow = this.#flow(nonce)!;
    const callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
    if (!callback) return { kind: "invalid" };
    // Single use: a second submit finds no flow.
    this.ctx.storage.kv.delete("flow");
    const account = this.ctx.exports.TelegramAccount({ props: { accountId: flow.accountId } });
    const handoff = await callback.complete(account as unknown as Fetcher<GatekeeperUser>);
    this.ctx.storage.kv.put("completed", true);
    return { kind: "ok", handoff };
  }

  /** An abandoned flow forgets any Telegram link made for it: no connection ever owned it. */
  async alarm(): Promise<void> {
    const flow = this.ctx.storage.kv.get<Flow>("flow");
    if (flow && !this.ctx.storage.kv.get("completed")) {
      await hub(this.ctx.exports).forgetAccount(flow.accountId);
    }
    this.ctx.storage.kv.delete("callback");
    this.ctx.storage.kv.delete("flow");
  }
}

/** The connect page's URL for a new flow. */
export async function startConnect(
    exports: Cloudflare.Exports, baseUrl: string, callback: Fetcher<GatekeeperConnectCallback>): Promise<string> {
  const id = flows(exports).newUniqueId();
  const nonce = await flows(exports).get(id).start(callback);
  return `${baseUrl}/connect/${id.toString()}/${nonce}`;
}

/** Serves `/connect/<flow>/<nonce>` (the page and its form) and `.../status` (what the page polls). */
export async function handleConnect(
    req: Request, segments: string[], exports: Cloudflare.Exports): Promise<Response> {
  const [flowId, nonce, tail] = segments;
  if (!/^[0-9a-f]{64}$/.test(flowId ?? "") || nonce?.length !== NONCE_BYTES * 2 ||
      (tail !== undefined && tail !== "status") || segments.length > 3) {
    return new Response("Not Found", { status: 404 });
  }
  const flow = flows(exports).get(flows(exports).idFromString(flowId));
  const expired = () => htmlResponse(errorPageHtml("This link has expired", "Start connecting Telegram again."));

  if (tail === "status") {
    if (req.method !== "GET") return new Response("Method Not Allowed", { status: 405 });
    const status = await flow.status(nonce);
    return Response.json({ linked: status.kind === "linked", expired: status.kind === "invalid" },
      { headers: { "Cache-Control": "no-store" } });
  }
  if (req.method === "GET") {
    const status = await flow.status(nonce);
    if (status.kind === "invalid") return expired();
    return htmlResponse(connectPageHtml(status));
  }
  if (req.method === "POST") {
    const result = await flow.complete(nonce);
    if (result.kind === "invalid") return expired();
    if (result.kind === "waiting") {
      return htmlResponse(connectPageHtml(result, "Press Start in Telegram first, then come back here."), 409);
    }
    return htmlResponse(connectHandoffPageHtml(result.handoff));
  }
  return new Response("Method Not Allowed", { status: 405 });
}

const STYLE = `${PAGE_STYLE}
  ol { padding-left: 1.2em; margin: 0 0 20px; }
  li { margin-bottom: 12px; }
  a.button, button { display: inline-block; font: inherit; font-weight: 600; padding: 10px 18px;
    border-radius: 8px; border: 0; cursor: pointer; text-decoration: none; }
  a.button { background: #2aabee; color: #fff; }
  button { background: var(--contrast); color: var(--on-contrast); }
  code { font-family: ui-monospace, monospace; font-size: 13px; background: var(--control);
    border: 1px solid var(--line); border-radius: 6px; padding: 2px 6px; user-select: all; }
  p.note { color: var(--subtle); font-size: 13px; }
`;

function connectPageHtml(status: Exclude<ConnectStatus, { kind: "invalid" }>, error?: string): string {
  const step = status.kind === "linked"
    ? `<p class="sub">Linked to ${escapeHtml(status.name)} in Telegram. Finish to add the connection.</p>
<form method="POST"><button type="submit">Finish connecting</button></form>`
    : `<p class="sub">Link your Telegram to the shared bot, @${escapeHtml(status.code.botUsername)}.</p>
${error ? `<p class="err">${escapeHtml(error)}</p>` : ""}
<ol>
<li><a class="button" href="${escapeHtml(status.code.url)}" target="_blank" rel="noopener">Open Telegram</a><br>
and press <b>Start</b> in the chat with the bot.</li>
<li>Come back here: this page continues by itself.</li>
</ol>
<p class="note">Telegram on another device? Send <code>/start ${escapeHtml(status.code.code)}</code>
to @${escapeHtml(status.code.botUsername)}. The code works once, for 15 minutes.</p>
<form method="POST"><button type="submit">I pressed Start</button></form>
<script>
(function () {
  var url = location.pathname.replace(/\\/$/, "") + "/status";
  function poll() {
    fetch(url, { cache: "no-store" }).then(function (r) { return r.json(); }).then(function (s) {
      if (s.linked) { document.forms[0].submit(); return; }
      if (!s.expired) setTimeout(poll, 2000);
    }).catch(function () { setTimeout(poll, 5000); });
  }
  setTimeout(poll, 2000);
})();
</script>`;
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Connect Telegram</title><style>${STYLE}</style></head>
<body><main><h1>Connect Telegram</h1>
${step}
</main></body></html>`;
}
