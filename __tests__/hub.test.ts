import { env, runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { addGroupButton, REPLIES } from "../src/commands";
import type { TelegramBotHub } from "../src/hub";
import type { WireMessage } from "../src/telegram-api";

const TOKEN = "123456789:AAEexampleexampleexampleexample123";
const SECRET = "s".repeat(64);
const BOT = { id: "42", username: "family_bot", name: "Family" };
const ANN = "11111111-1111-4111-8111-111111111111";
const BEN = "22222222-2222-4222-8222-222222222222";

type HubNamespace = DurableObjectNamespace<TelegramBotHub>;
const hubs = () => (env as unknown as { TelegramBotHub: HubNamespace }).TelegramBotHub;

async function fingerprint(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest).slice(0, 8)].map(b => b.toString(16).padStart(2, "0")).join("");
}

/** A hub whose bot is set up, seeded directly: setting it up for real needs Telegram. */
async function setUpHub() {
  const stub = hubs().get(hubs().newUniqueId());
  const fp = await fingerprint(TOKEN);
  await runInDurableObject(stub, async (_instance, state) => {
    state.storage.kv.put("secret", SECRET);
    state.storage.kv.put("setup", {
      fingerprint: fp, bot: BOT, webhookUrl: "http://localhost:8787/gatekeeper/telegram/webhook/bot", checkedAt: Date.now(), webhookVersion: 3,
    });
  });
  return stub;
}

let nextId = 1;

/** A message from Telegram user `from` in chat `chat`. */
function update(text: string, from: number, chat: WireMessage["chat"] = { id: from, type: "private", first_name: `User ${from}` }) {
  const id = nextId++;
  return {
    update_id: id,
    message: { message_id: id, date: 1_700_000_000 + id, chat, from: { id: from, is_bot: false, first_name: `User ${from}` }, text },
  };
}

const GROUP = { id: -100, type: "group" as const, title: "Family" };

/** Links GROUP through `/link` from `telegramUser`. */
async function linkGroup(stub: DurableObjectStub<TelegramBotHub>, telegramUser: number) {
  return stub.receiveUpdate(SECRET, update("/link", telegramUser, GROUP));
}

const BUTTON = addGroupButton("family_bot");

/** Links Telegram user `telegramUser` to `account` through a fresh link code. */
async function link(stub: DurableObjectStub<TelegramBotHub>, account: string, telegramUser: number) {
  const { url } = await stub.createLinkCode(account);
  const code = new URL(url).searchParams.get("start")!;
  return stub.receiveUpdate(SECRET, update(`/start ${code}`, telegramUser));
}

describe("the webhook secret", () => {
  it("refuses a delivery without it, storing nothing", async () => {
    const stub = await setUpHub();
    expect(await stub.receiveUpdate("wrong", update("hi", 5))).toEqual({ accepted: false });
  });

  it("refuses every delivery before the bot is set up", async () => {
    const stub = hubs().get(hubs().newUniqueId());
    expect((await stub.receiveUpdate(SECRET, update("hi", 5))).accepted).toBe(false);
  });
});

describe("linking", () => {
  it("makes a link that opens the bot with a code", async () => {
    const stub = await setUpHub();
    const { url, code, botUsername, expiresAt } = await stub.createLinkCode(ANN);
    expect(url).toBe(`https://t.me/family_bot?start=${code}`);
    expect(code).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(botUsername).toBe("family_bot");
    expect(expiresAt - Date.now()).toBeGreaterThan(14 * 60_000);
  });

  it("links a person's private chat to the account whose code they started", async () => {
    const stub = await setUpHub();
    expect(await stub.linkedPerson(ANN)).toBeNull();
    expect(await link(stub, ANN, 5)).toEqual({
      accepted: true, reply: { chatId: "5", text: REPLIES.linked, button: BUTTON },
    });
    expect((await stub.listChats(ANN)).map(chat => chat.id)).toEqual(["5"]);
    expect(await stub.isOwnPrivateChat(ANN, "5")).toBe(true);
    expect((await stub.linkedPerson(ANN))?.title).toBe("User 5");
  });

  it("uses each code once, and not after it expires", async () => {
    const stub = await setUpHub();
    const { url } = await stub.createLinkCode(ANN);
    const code = new URL(url).searchParams.get("start")!;
    await stub.receiveUpdate(SECRET, update(`/start ${code}`, 5));
    expect((await stub.receiveUpdate(SECRET, update(`/start ${code}`, 6))).reply?.text).toBe(REPLIES.badCode);

    const expired = (await stub.createLinkCode(ANN)).url.split("start=")[1];
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec("UPDATE codes SET expires_at = 0 WHERE code = ?", expired);
    });
    expect((await stub.receiveUpdate(SECRET, update(`/start ${expired}`, 7))).reply?.text).toBe(REPLIES.badCode);
    expect(await stub.listChats(ANN)).toHaveLength(1);
  });

  it("moves a Telegram account, with its private chat, to a newer connection's code", async () => {
    const stub = await setUpHub();
    await link(stub, ANN, 5);
    await linkGroup(stub, 5);
    expect((await link(stub, BEN, 5)).reply?.text).toBe(REPLIES.linked);
    expect((await stub.listChats(BEN)).map(chat => chat.id)).toEqual(["5"]);
    expect(await stub.linkedPerson(ANN)).toBeNull();
    // Groups stay with the connection that linked them.
    expect(await stub.chatOwner("-100")).toBe(ANN);
  });
});

describe("one person's chats", () => {
  it("are stored, and seen by their account alone", async () => {
    const stub = await setUpHub();
    await link(stub, ANN, 5);
    expect(await stub.receiveUpdate(SECRET, update("hello", 5))).toEqual({ accepted: true });
    expect((await stub.listMessages(ANN, "5", null, 10)).messages.map(m => m.text)).toEqual(["hello"]);

    expect(await stub.listChats(BEN)).toEqual([]);
    expect(await stub.getChat(BEN, "5")).toBeNull();
    expect(await stub.listMessages(BEN, "5", null, 10)).toEqual({ messages: [], more: false });
    expect(await stub.chatOwner("5")).toBe(ANN);
    await expect(runInDurableObject(stub, (instance: TelegramBotHub) => instance.send(BEN, "5", "hi", {})))
      .rejects.toThrow("no longer linked");
  });

  it("never store the link code itself", async () => {
    const stub = await setUpHub();
    await link(stub, ANN, 5);
    const bodies = await runInDurableObject(stub, async (_instance, state) =>
      state.storage.sql.exec<{ body: string }>("SELECT body FROM messages").toArray().map(row => row.body));
    expect(bodies).toEqual([]);
  });
});

describe("unlinked chats", () => {
  it("in a group are answered only when they mention the bot", async () => {
    const stub = await setUpHub();
    const OTHER = { id: -300, type: "group" as const, title: "Strangers" };
    expect(await stub.receiveUpdate(SECRET, update("hello everyone", 9, OTHER))).toEqual({ accepted: true });
    expect((await stub.receiveUpdate(SECRET, update("hey @Family_Bot", 9, OTHER))).reply?.text).toBe(REPLIES.private);
  });

  it("are told the bot is private, at most daily, and nothing is kept", async () => {
    const stub = await setUpHub();
    expect(await stub.receiveUpdate(SECRET, update("hi", 9))).toEqual({
      accepted: true, reply: { chatId: "9", text: REPLIES.private },
    });
    expect(await stub.receiveUpdate(SECRET, update("hi again", 9))).toEqual({ accepted: true });
    expect(await stub.chatOwner("9")).toBeNull();
    const stored = await runInDurableObject(stub, async (_instance, state) =>
      state.storage.sql.exec("SELECT * FROM messages").toArray().length);
    expect(stored).toBe(0);
  });
});

describe("groups", () => {
  it("belong to the linked person who sends /link, or adds the bot with the button", async () => {
    const stub = await setUpHub();
    await link(stub, ANN, 5);
    expect((await stub.receiveUpdate(SECRET, update("/link@family_bot", 5, GROUP))).reply?.text).toBe(REPLIES.groupLinked);
    await stub.receiveUpdate(SECRET, update("dinner at 7", 6, GROUP));
    expect((await stub.listMessages(ANN, "-100", null, 10)).messages.map(m => m.text)).toEqual(["dinner at 7"]);
    expect(await stub.isOwnPrivateChat(ANN, "-100")).toBe(false);
    expect((await linkGroup(stub, 5)).reply?.text).toBe(REPLIES.alreadyLinked);

    // Telegram's group picker has the person send `/start@bot link` in the group.
    const other = { id: -200, type: "supergroup" as const, title: "Cousins" };
    expect((await stub.receiveUpdate(SECRET, update("/start@family_bot link", 5, other))).reply?.text)
      .toBe(REPLIES.groupLinked);
    expect(await stub.chatOwner("-200")).toBe(ANN);
  });

  it("are offered with a button in a linked person's private chat", async () => {
    const stub = await setUpHub();
    expect((await stub.receiveUpdate(SECRET, update("/addgroup", 5))).reply).toEqual({ chatId: "5", text: REPLIES.linkFirst });
    await link(stub, ANN, 5);
    expect((await stub.receiveUpdate(SECRET, update("/addgroup", 5))).reply)
      .toEqual({ chatId: "5", text: REPLIES.addGroup, button: BUTTON });
    expect(BUTTON.url).toBe("https://t.me/family_bot?startgroup=link");
  });

  it("can't be linked by someone not linked themselves, or taken from their owner", async () => {
    const stub = await setUpHub();
    expect((await linkGroup(stub, 6)).reply?.text).toBe(REPLIES.linkFirst);
    await link(stub, ANN, 5);
    await link(stub, BEN, 6);
    await linkGroup(stub, 5);
    expect((await linkGroup(stub, 6)).reply?.text).toBe(REPLIES.groupTaken);
    expect(await stub.chatOwner("-100")).toBe(ANN);
  });

  it("ignore a command addressed to another bot", async () => {
    const stub = await setUpHub();
    await link(stub, ANN, 5);
    await linkGroup(stub, 5);
    expect(await stub.receiveUpdate(SECRET, update("/unlink@other_bot", 5, GROUP))).toEqual({ accepted: true });
    expect(await stub.chatOwner("-100")).toBe(ANN);
  });
});

describe("unlinking", () => {
  it("lets the owner unlink a group, and no one else", async () => {
    const stub = await setUpHub();
    await link(stub, ANN, 5);
    await link(stub, BEN, 6);
    await linkGroup(stub, 5);
    expect((await stub.receiveUpdate(SECRET, update("/unlink", 6, GROUP))).reply?.text).toBe(REPLIES.notYours);
    expect((await stub.receiveUpdate(SECRET, update("/unlink", 5, GROUP))).reply?.text).toBe(REPLIES.unlinked);
    expect(await stub.chatOwner("-100")).toBeNull();
  });

  it("unlinks a person and their private chat", async () => {
    const stub = await setUpHub();
    await link(stub, ANN, 5);
    await stub.receiveUpdate(SECRET, update("/unlink", 5));
    expect(await stub.listChats(ANN)).toEqual([]);
    expect((await stub.receiveUpdate(SECRET, update("hi", 5))).reply?.text).toBe(REPLIES.private);
  });

  it("forgets everything of a removed account", async () => {
    const stub = await setUpHub();
    await link(stub, ANN, 5);
    await linkGroup(stub, 5);
    await stub.forgetAccount(ANN);
    expect(await stub.linkedPerson(ANN)).toBeNull();
    expect(await stub.listChats(ANN)).toEqual([]);
    expect(await stub.chatOwner("-100")).toBeNull();
    await expect(runInDurableObject(stub, (instance: TelegramBotHub) =>
      instance.registerHook("k", { accountId: ANN }, {} as never))).rejects.toThrow("removed");
  });
});

describe("hooks", () => {
  it("queue a message for its owner's hooks only", async () => {
    const stub = await setUpHub();
    await link(stub, ANN, 5);
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.kv.put("reg:ann", { accountId: ANN });
      state.storage.kv.put("reg:ann-five", { accountId: ANN, chatId: "5" });
      state.storage.kv.put("reg:ann-group", { accountId: ANN, chatId: "-100" });
      state.storage.kv.put("reg:ben", { accountId: BEN });
    });
    await stub.receiveUpdate(SECRET, update("hello", 5));
    const queued = await runInDurableObject(stub, async (_instance, state) =>
      [...state.storage.kv.list({ prefix: "msg:" })].map(([key]) => key.split(":")[1]).toSorted());
    expect(queued).toEqual(["ann", "ann-five"]);
  });

  it("let a disabled hook be unregistered whatever its state", async () => {
    const stub = await setUpHub();
    await expect(stub.unregisterHook("never-registered")).resolves.toBeUndefined();
  });
});

describe("the webhook endpoint", () => {
  const post = (path: string, init: RequestInit = {}) => (exports as any).default.fetch(new Request(
    `http://localhost:8787/gatekeeper/telegram${path}`, { method: "POST", ...init }));

  it("needs Telegram's secret header", async () => {
    expect((await post("/webhook/bot", { body: JSON.stringify(update("hi", 5)) })).status).toBe(401);
  });

  it("refuses a malformed body, other methods and other paths", async () => {
    expect((await post("/webhook/bot", { headers: { "X-Telegram-Bot-Api-Secret-Token": "x" }, body: "{" })).status).toBe(400);
    expect((await post("/webhook/bot", { method: "GET" })).status).toBe(405);
    expect((await post("/elsewhere")).status).toBe(404);
    expect((await post("/webhook")).status).toBe(404);
    expect((await post("/webhook/other")).status).toBe(404);
  });
});

/** A press of a `data` button under message `messageId`, by Telegram user `from`. */
function press(data: string, from: number, messageId: number, chat: WireMessage["chat"] = GROUP) {
  const id = nextId++;
  return {
    update_id: id,
    callback_query: {
      id: `q${id}`, from: { id: from, is_bot: false, first_name: `User ${from}` }, data,
      message: { message_id: messageId, chat },
    },
  };
}

const queuedFor = (stub: DurableObjectStub<TelegramBotHub>) => runInDurableObject(stub, async (_instance, state) =>
  [...state.storage.kv.list<{ payload?: unknown }>({ prefix: "msg:" })].map(([key, value]) => ({ hook: key.split(":")[1], value })));

describe("button presses", () => {
  it("are acknowledged, and queued for the chat owner's hooks with who pressed", async () => {
    const stub = await setUpHub();
    await link(stub, ANN, 5);
    await linkGroup(stub, 5);
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.kv.put("reg:ann", { accountId: ANN });
      state.storage.kv.put("reg:ben", { accountId: BEN });
    });
    // Anyone in the group can press; the gadget is told who did.
    const update = press("add:1", 77, 900);
    expect(await stub.receiveUpdate(SECRET, update)).toEqual({
      accepted: true, reply: { answerPress: update.callback_query.id },
    });
    const queued = await queuedFor(stub);
    expect(queued.map(entry => entry.hook)).toEqual(["ann"]);
    expect(JSON.stringify(queued[0].value)).toContain('"data":"add:1"');
    expect(JSON.stringify(queued[0].value)).toContain('"name":"User 77"');
    expect(JSON.stringify(queued[0].value)).toContain('"messageId":"900"');
  });

  it("go nowhere in a chat nobody linked, but are still acknowledged", async () => {
    const stub = await setUpHub();
    const update = press("add:1", 77, 900);
    expect((await stub.receiveUpdate(SECRET, update)).reply).toEqual({ answerPress: update.callback_query.id });
    expect(await queuedFor(stub)).toEqual([]);
  });

  it("need the webhook secret like any delivery", async () => {
    const stub = await setUpHub();
    expect(await stub.receiveUpdate("wrong", press("add:1", 5, 900))).toEqual({ accepted: false });
  });
});

/** Telegram user `from` setting `emoji` (none: removing it) on message `messageId`. */
function reaction(emoji: string[], from: number | undefined, messageId: number, date = 1_800_000_000) {
  return {
    update_id: nextId++,
    message_reaction: {
      chat: GROUP, message_id: messageId, date,
      ...(from === undefined ? {} : { user: { id: from, is_bot: false, first_name: `User ${from}` } }),
      old_reaction: [{ type: "emoji", emoji: "👀" }],
      new_reaction: [...emoji.map(e => ({ type: "emoji", emoji: e })), { type: "custom_emoji", custom_emoji_id: "1" }],
    },
  };
}

describe("reactions", () => {
  it("are queued for the chat owner's hooks with who reacted, once per change", async () => {
    const stub = await setUpHub();
    await link(stub, ANN, 5);
    await linkGroup(stub, 5);
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.kv.put("reg:ann", { accountId: ANN });
      state.storage.kv.put("reg:ann-deaf", { accountId: ANN, ignoresReactions: true });
      state.storage.kv.put("reg:ben", { accountId: BEN });
    });
    // Read in the same turn as the last update, before the queue's alarm can deliver anything.
    const queued = await runInDurableObject(stub, async (instance: TelegramBotHub, state) => {
      const update = reaction(["👍"], 77, 41);
      expect(await instance.receiveUpdate(SECRET, update)).toEqual({ accepted: true });
      // Telegram redelivering the same change adds nothing.
      await instance.receiveUpdate(SECRET, { ...update, update_id: nextId++ });
      // Removing it within the same second is another change, not a repeat.
      await instance.receiveUpdate(SECRET, reaction([], 77, 41));
      return [...state.storage.kv.list<{ message?: unknown }>({ prefix: "msg:" })]
        .map(([key, value]) => ({ hook: key.split(":")[1], value }));
    });
    expect(queued.map(entry => entry.hook)).toEqual(["ann", "ann"]);
    expect(queued.map(entry => JSON.stringify(entry.value)).filter(v => v.includes('"emoji":[]'))).toHaveLength(1);
    const text = queued.map(entry => JSON.stringify(entry.value)).find(v => !v.includes('"emoji":[]'))!;
    expect(text).toContain('"emoji":["👍"]');
    expect(text).toContain('"previous":["👀"]');
    expect(text).toContain('"name":"User 77"');
    expect(text).toContain('"messageId":"41"');
    // Not a message the bot is known to have sent.
    expect(text).toContain('"onBotMessage":false');
    expect(text).toContain('"reactedAt":"2027-01-15T08:00:00.000Z"');
  });

  it("say when the message is the bot's own, and report a removal or an anonymous admin", async () => {
    const stub = await setUpHub();
    await link(stub, ANN, 5);
    await linkGroup(stub, 5);
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.kv.put("reg:ann", { accountId: ANN });
    });
    const sent = await stub.send(ANN, "-100", "Shall I order?", {});
    await stub.receiveUpdate(SECRET, reaction([], undefined, Number(sent.id)));
    const text = JSON.stringify((await queuedFor(stub))[0].value);
    expect(text).toContain('"onBotMessage":true');
    expect(text).toContain('"emoji":[]');
    expect(text).not.toContain('"from"');
  });

  it("go nowhere in a chat nobody linked, and need the webhook secret", async () => {
    const stub = await setUpHub();
    expect(await stub.receiveUpdate(SECRET, reaction(["👍"], 77, 41))).toEqual({ accepted: true });
    expect(await queuedFor(stub)).toEqual([]);
    expect(await stub.receiveUpdate("wrong", reaction(["👍"], 77, 41))).toEqual({ accepted: false });
  });
});

describe("listening for presses", () => {
  it("is true only for an enabled hook of the account that covers the chat and takes presses", async () => {
    const stub = await setUpHub();
    expect(await stub.listensForPresses(ANN, "-100")).toBe(false);
    const put = (key: string, registration: object) => runInDurableObject(stub, async (_instance, state) => {
      state.storage.kv.put(`reg:${key}`, registration);
    });
    await put("ben", { accountId: BEN });
    await put("ann-other", { accountId: ANN, chatId: "5" });
    expect(await stub.listensForPresses(ANN, "-100")).toBe(false);
    // A hook already found to have no receiveButtonPress() does not count.
    await put("ann-deaf", { accountId: ANN, chatId: "-100", ignoresPresses: true });
    expect(await stub.listensForPresses(ANN, "-100")).toBe(false);
    await put("ann-all", { accountId: ANN });
    expect(await stub.listensForPresses(ANN, "-100")).toBe(true);
    expect(await stub.listensForPresses(ANN, "5")).toBe(true);
  });
});

describe("pictures, files and changes", () => {
  async function groupHub() {
    const stub = await setUpHub();
    await link(stub, ANN, 5);
    await linkGroup(stub, 5);
    return stub;
  }
  const FILE = { bytes: new Uint8Array([1, 2, 3]), filename: "shot.png", mediaType: "image/png" };
  const BUTTONS = [[{ text: "Add", data: "add:1" }]];

  it("send a picture with a caption and buttons, and keep it with the chat", async () => {
    const stub = await groupHub();
    const sent = await stub.sendMedia(ANN, "-100", "photo", FILE, { caption: "look", buttons: BUTTONS });
    expect(sent).toMatchObject({
      id: "900", chatId: "-100", fromBot: true, text: "look", attachment: "photo", buttons: BUTTONS,
      file: { mediaType: "image/jpeg", size: 3 },
    });
    expect(await stub.getMessage(ANN, "-100", "900")).toEqual(sent);
    // Telegram's id for the file is kept beside the message, never in it.
    expect(JSON.stringify(sent)).not.toContain("f-photo");
    expect(new TextDecoder().decode((await stub.readFile(ANN, "-100", "900")).content)).toBe("picture bytes");
  });

  it("send a file under its own name and type", async () => {
    const stub = await groupHub();
    const sent = await stub.sendMedia(ANN, "-100", "document", { ...FILE, filename: "scan.pdf", mediaType: "application/pdf" }, {});
    expect(sent).toMatchObject({ attachment: "document", file: { filename: "scan.pdf", mediaType: "application/pdf", size: 3 } });
    expect(await stub.readFile(ANN, "-100", "900")).toMatchObject({ filename: "scan.pdf", mediaType: "application/pdf" });
  });

  it("keep a received photo readable, and say so when a message carries none", async () => {
    const stub = await groupHub();
    const incoming = update("", 5);
    Object.assign(incoming.message, { text: undefined, caption: "receipt", photo: [{ file_id: "f-thumb" }, { file_id: "f-photo", file_size: 13 }] });
    await stub.receiveUpdate(SECRET, incoming);
    const id = String(incoming.message.message_id);
    expect(await stub.getMessage(ANN, "5", id)).toMatchObject({ text: "receipt", attachment: "photo", file: { size: 13 } });
    expect((await stub.readFile(ANN, "5", id)).mediaType).toBe("image/jpeg");

    const text = update("no file", 5);
    await stub.receiveUpdate(SECRET, text);
    await expect(runInDurableObject(stub, (instance: TelegramBotHub) =>
      instance.readFile(ANN, "5", String(text.message.message_id)))).rejects.toThrow("carries no picture or file");
  });

  it("edit the bot's own message, replace its buttons, and delete it", async () => {
    const stub = await groupHub();
    await stub.send(ANN, "-100", "Order?", { buttons: BUTTONS });
    expect((await stub.getMessage(ANN, "-100", "900"))?.buttons).toEqual(BUTTONS);

    expect(await stub.editMessage(ANN, "-100", "900", "Added milk", {})).toMatchObject({ id: "900", text: "Added milk" });
    expect((await stub.getMessage(ANN, "-100", "900"))?.buttons).toBeUndefined();

    expect((await stub.setButtons(ANN, "-100", "900", [[{ text: "Undo", data: "undo" }]])).buttons)
      .toEqual([[{ text: "Undo", data: "undo" }]]);

    await stub.deleteMessage(ANN, "-100", "900");
    expect(await stub.getMessage(ANN, "-100", "900")).toBeNull();
  });

  it("edit a picture's caption rather than its text", async () => {
    const stub = await groupHub();
    await stub.sendMedia(ANN, "-100", "photo", FILE, { caption: "look" });
    expect(await stub.editMessage(ANN, "-100", "900", "look again", {})).toMatchObject({ text: "look again", attachment: "photo" });
  });

  it("never change someone else's message, or anything in a chat that isn't the account's", async () => {
    const stub = await groupHub();
    const theirs = update("hello", 5, GROUP);
    await stub.receiveUpdate(SECRET, theirs);
    const id = String(theirs.message.message_id);
    const failing = (call: (hub: TelegramBotHub) => Promise<unknown>) => runInDurableObject(stub, call);
    await expect(failing(hub => hub.editMessage(ANN, "-100", id, "x", {}))).rejects.toThrow("Only the bot's own");
    await expect(failing(hub => hub.deleteMessage(ANN, "-100", id))).rejects.toThrow("Only the bot's own");
    await expect(failing(hub => hub.setButtons(ANN, "-100", "12345", []))).rejects.toThrow("no longer kept");

    await stub.send(ANN, "-100", "Order?", {});
    await expect(failing(hub => hub.editMessage(BEN, "-100", "900", "x", {}))).rejects.toThrow("no longer linked");
    await expect(failing(hub => hub.react(BEN, "-100", "900", "👍"))).rejects.toThrow("no longer linked");
    await expect(failing(hub => hub.readFile(BEN, "-100", "900"))).rejects.toThrow("no longer linked");
    expect(await stub.getMessage(BEN, "-100", "900")).toBeNull();
    await expect(failing(hub => hub.sendMedia(BEN, "-100", "photo", FILE, {}))).rejects.toThrow("no longer linked");
  });

  it("react to anyone's message, refusing an emoji Telegram doesn't offer without asking it", async () => {
    const stub = await groupHub();
    await expect(stub.react(ANN, "-100", "5", "👍")).resolves.toBeUndefined();
    await expect(stub.react(ANN, "-100", "5", null)).resolves.toBeUndefined();
    await expect(runInDurableObject(stub, (instance: TelegramBotHub) => instance.react(ANN, "-100", "5", "🦖")))
      .rejects.toThrow("does not allow that emoji");
  });

  it("refuse to read a file larger than can be carried", async () => {
    const stub = await groupHub();
    const incoming = update("", 5);
    Object.assign(incoming.message, { text: undefined, document: { file_id: "f-huge", file_name: "movie.mkv" } });
    await stub.receiveUpdate(SECRET, incoming);
    await expect(runInDurableObject(stub, (instance: TelegramBotHub) =>
      instance.readFile(ANN, "5", String(incoming.message.message_id)))).rejects.toThrow("larger than the 10 MB");
  });
});

describe("the webhook registration", () => {
  it("is renewed once when it predates the update kinds asked for now", async () => {
    const stub = await setUpHub();
    await runInDurableObject(stub, async (_instance, state) => {
      const { webhookVersion: _dropped, ...old } = state.storage.kv.get<Record<string, unknown>>("setup")!;
      state.storage.kv.put("setup", old);
    });
    expect((await stub.getBot()).username).toBe("family_bot");
    expect(await runInDurableObject(stub, async (_instance, state) =>
      state.storage.kv.get<{ webhookVersion?: number }>("setup")?.webhookVersion)).toBe(3);
  });
});
