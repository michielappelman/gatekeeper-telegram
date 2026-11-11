import { env, runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { TelegramConnect } from "../src/connect";
import type { TelegramBotHub } from "../src/hub";

const TOKEN = "123456789:AAEexampleexampleexampleexample123";
const SECRET = "s".repeat(64);
const NONCE = "a".repeat(64);
const ACCOUNT = "33333333-3333-4333-8333-333333333333";
const BASE = "http://localhost:8787/gatekeeper/telegram";

type Bindings = { TelegramBotHub: DurableObjectNamespace<TelegramBotHub>; TelegramConnect: DurableObjectNamespace<TelegramConnect> };
const bindings = () => env as unknown as Bindings;

async function fingerprint(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest).slice(0, 8)].map(b => b.toString(16).padStart(2, "0")).join("");
}

/** The deployment's hub, set up without Telegram, and a connect flow seeded for ACCOUNT. */
async function setUp() {
  const hub = bindings().TelegramBotHub.getByName("bot");
  const fp = await fingerprint(TOKEN);
  await runInDurableObject(hub, async (_instance, state) => {
    state.storage.kv.put("secret", SECRET);
    state.storage.kv.put("setup", {
      fingerprint: fp, bot: { id: "42", username: "family_bot", name: "Family" },
      webhookUrl: `${BASE}/webhook/bot`, checkedAt: Date.now(), webhookVersion: 3,
    });
  });
  const id = bindings().TelegramConnect.newUniqueId();
  await runInDurableObject(bindings().TelegramConnect.get(id), async (_instance, state) => {
    state.storage.kv.put("flow", { accountId: ACCOUNT, nonce: { value: NONCE, expiresAt: Date.now() + 60_000 } });
  });
  const page = `${BASE}/connect/${id.toString()}/${NONCE}`;
  const request = (path: string, init?: RequestInit) => (exports as any).default.fetch(new Request(path, init));
  return { hub, page, request };
}

describe("the connect page", () => {
  it("shows a link code for the flow's account, and waits for Start", async () => {
    const { page, request } = await setUp();
    const html = await (await request(page)).text();
    const code = /start=([A-Za-z0-9_-]{24})/.exec(html)?.[1];
    expect(code).toBeDefined();
    expect(html).toContain(`/start ${code}`);
    expect(await (await request(`${page}/status`)).json()).toEqual({ linked: false, expired: false });
    expect((await request(page, { method: "POST" })).status).toBe(409);
  });

  it("sees the person linked once they press Start with its code", async () => {
    const { hub, page, request } = await setUp();
    const code = /start=([A-Za-z0-9_-]{24})/.exec(await (await request(page)).text())![1];
    await hub.receiveUpdate(SECRET, {
      update_id: 1,
      message: { message_id: 1, date: 1_700_000_000, chat: { id: 7, type: "private", first_name: "Cas" },
        from: { id: 7, is_bot: false, first_name: "Cas" }, text: `/start ${code}` },
    });
    expect(await (await request(`${page}/status`)).json()).toEqual({ linked: true, expired: false });
    expect(await (await request(page)).text()).toContain("Linked to Cas in Telegram");
  });

  it("refuses a wrong nonce or a malformed path", async () => {
    const { page, request } = await setUp();
    const wrong = page.replace(NONCE, "b".repeat(64));
    expect(await (await request(wrong)).text()).toContain("This link has expired");
    expect(await (await request(`${wrong}/status`)).json()).toEqual({ linked: false, expired: true });
    expect((await request(`${BASE}/connect/nope/${NONCE}`)).status).toBe(404);
    expect((await request(`${page}/other`)).status).toBe(404);
  });
});
