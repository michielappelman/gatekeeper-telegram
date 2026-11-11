import { RpcStub, RpcTarget } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { describeSend, groupSendKind, TelegramBotSessionImpl, TelegramChatSessionImpl } from "../src/telegram";
import type { TelegramChatInfo, TelegramMessage } from "../src/types";

const BOT = { id: "42", username: "family_bot", name: "Family" };
const ANN = "11111111-1111-4111-8111-111111111111";
const CHAT: TelegramChatInfo = { id: "5", type: "private", title: "Ann" };

function stored(id: number): TelegramMessage {
  return { id: String(id), chatId: "5", sentAt: new Date(id * 1000).toISOString(), fromBot: false, text: `m${id}` };
}

/** A fake approval queue recording what the session asked of it. */
function fakeQueue() {
  const observations: { title: string; subresources?: string[] }[] = [];
  const queue = {
    authorizeObservation: vi.fn(async (description: { title: string; subresources?: string[] }) => {
      observations.push(description);
    }),
    submitAction: vi.fn(async () => {}),
    bindHook: vi.fn(async () => {}),
    dup() { return queue; },
    [Symbol.dispose]() {},
  };
  return { queue, observations };
}

type Queued = { actionId: number; action: any };

function fakeBinding(options: {
  chatId?: string; linked?: boolean; pending?: Queued[]; sent?: Record<number, string>;
  kept?: TelegramMessage[]; listening?: boolean;
} = {}) {
  const queued: Queued[] = [...(options.pending ?? [])];
  const uploads: (Uint8Array | undefined)[] = [];
  const queue = vi.fn(async (action: any, _chatTitle: string, _queue: unknown, bytes?: Uint8Array) => {
    const actionId = queued.length + 1;
    queued.push({ actionId, action: { ...action, submittedAt: 1_900_000_000_000 + actionId } });
    uploads.push(bytes);
    return actionId;
  });
  const kept = options.kept ?? [3, 2, 1].map(stored);
  const readFile = vi.fn(async () => ({ content: new Uint8Array([1, 2, 3]).buffer, filename: "a.jpg", mediaType: "image/jpeg" }));
  const binding = {
    props: { accountId: ANN, ...(options.chatId ? { chatId: options.chatId } : {}) },
    hub: {
      getBot: async () => BOT,
      listChats: async () => [CHAT],
      getChat: async (_accountId: string, chatId: string) =>
        (options.linked === false || chatId !== CHAT.id ? null : CHAT),
      listMessages: async (_accountId: string, _chatId: string, beforeId: number | null, limit: number) => {
        const all = kept.filter(message => beforeId === null || Number(message.id) < beforeId);
        return { messages: all.slice(0, limit), more: all.length > limit };
      },
      getMessage: async (_accountId: string, _chatId: string, id: string) =>
        kept.find(message => message.id === id) ?? null,
      readFile,
      listensForPresses: async () => options.listening !== false,
    },
    queue,
    pending: (chatId: string) => queued.filter(entry => entry.action.chatId === chatId),
    sentMessageId: (actionId: number) => options.sent?.[actionId],
    hookController: () => ({}),
  };
  return { binding: binding as never, queue, queued, uploads, readFile };
}

const chatSession = (queue: unknown, options: Parameters<typeof fakeBinding>[0] = { chatId: "5" }) =>
  new TelegramChatSessionImpl(queue as never, fakeBinding(options).binding, "5");

describe("a chat", () => {
  it("reports the chat on every read", async () => {
    const { queue, observations } = fakeQueue();
    const session = chatSession(queue);
    await session.getInfo();
    await session.listMessages();
    expect(observations.map(o => o.subresources)).toEqual([["chat/5"], ["chat/5"]]);
  });

  it("pages messages with an opaque cursor", async () => {
    const { queue } = fakeQueue();
    const session = chatSession(queue);
    const first = await session.listMessages({ limit: 2 });
    expect(first.messages.map(m => m.id)).toEqual(["3", "2"]);
    const next = await session.listMessages({ limit: 2, cursor: first.nextCursor });
    expect(next.messages.map(m => m.id)).toEqual(["1"]);
    expect(next.nextCursor).toBeUndefined();
  });

  it("shows a message waiting to be sent as the newest, on the first page only", async () => {
    const { queue } = fakeQueue();
    const pending = { actionId: 1, action: { chatId: "5", text: "hi", options: {}, submittedAt: Date.parse("2030-01-01T00:00:00.000Z") } };
    const session = chatSession(queue, { chatId: "5", pending: [pending] });
    expect((await session.listMessages({ limit: 2 })).messages[0]).toEqual({
      id: "pending-1", chatId: "5", sentAt: "2030-01-01T00:00:00.000Z", fromBot: true, text: "hi",
    });
    expect((await session.listMessages({ limit: 2, cursor: "2" })).messages.map(m => m.id)).toEqual(["1"]);
  });

  it("refuses a bad limit or cursor without reading anything", async () => {
    const { queue, observations } = fakeQueue();
    const session = chatSession(queue);
    await expect(session.listMessages({ limit: 0 })).rejects.toThrow("limit");
    await expect(session.listMessages({ limit: 101 })).rejects.toThrow("limit");
    await expect(session.listMessages({ cursor: "pending-1" })).rejects.toThrow("cursor");
    expect(observations).toEqual([]);
  });

  it("queues a send, and refuses one Telegram would refuse", async () => {
    const { queue } = fakeQueue();
    const { binding, queue: queueAction } = fakeBinding({ chatId: "5" });
    const session = new TelegramChatSessionImpl(queue as never, binding, "5");
    await session.sendMessage("hello", { replyTo: "2" });
    expect(queueAction).toHaveBeenCalledWith(
      { type: "text", chatId: "5", text: "hello", options: { replyTo: "2" } }, "Ann", queue);
    await expect(session.sendMessage("")).rejects.toThrow();
    await expect(session.sendMessage("x".repeat(5000))).rejects.toThrow("4096");
    expect(queueAction).toHaveBeenCalledTimes(1);
  });

  it("refuses everything for a chat not linked to the user", async () => {
    const { queue, observations } = fakeQueue();
    const session = chatSession(queue, { chatId: "5", linked: false });
    await expect(session.getInfo()).rejects.toThrow("isn't linked to you");
    await expect(session.listMessages()).rejects.toThrow("isn't linked to you");
    await expect(session.sendMessage("hi")).rejects.toThrow("isn't linked to you");
    expect(observations).toEqual([]);
  });

  it("binds a hook for its chat", async () => {
    const { queue } = fakeQueue();
    const session = chatSession(queue);
    const hook = new RpcStub(new class extends RpcTarget { async receiveMessage() {} }());
    await session.subscribe(hook as never);
    expect(queue.bindHook).toHaveBeenCalledWith({}, expect.anything(),
      expect.objectContaining({ title: "Receive Telegram messages in Ann" }));
  });
});

describe("the user's bot", () => {
  it("reports nothing for the bot's public identity, the account for the chat list, the chat for a chat's", async () => {
    const { queue, observations } = fakeQueue();
    const session = new TelegramBotSessionImpl(queue as never, fakeBinding().binding);
    expect(await session.getInfo()).toEqual(BOT);
    expect(await session.listChats()).toEqual([CHAT]);
    await session.getChat("5").listMessages();
    expect(observations.map(o => o.subresources)).toEqual([[], [`account/${ANN}`], ["chat/5"]]);
  });

  it("refuses a chat id that isn't one", () => {
    const { queue } = fakeQueue();
    const session = new TelegramBotSessionImpl(queue as never, fakeBinding().binding);
    expect(() => session.getChat("abc")).toThrow("not a Telegram chat id");
  });
});

describe("describeSend", () => {
  const send = { chatTitle: "Ann", botUsername: "family_bot", text: "hello", options: {} };

  it("makes a send eligible under the rule its caller names", () => {
    expect(describeSend({ ...send, kind: { tag: "send-message", label: "Send Telegram messages" } })).toMatchObject({
      autoApprovable: true,
      actionKind: { tag: "send-message", label: "Send Telegram messages" },
      implementsRevert: false,
    });
    expect(describeSend({ ...send, kind: groupSendKind({ id: "-100", title: "Family" }) }).actionKind)
      .toEqual({ tag: "send-message:chat:-100", label: "Send Telegram messages to Family" });
  });

  it("keeps a send without a rule for a person to approve", () => {
    const description = describeSend({ ...send, kind: undefined });
    expect(description.autoApprovable).toBe(false);
    expect(description.actionKind).toBeUndefined();
  });

  it("shows the chat, the exact text, and any reply or format", () => {
    expect(describeSend({ ...send, options: { replyTo: "9", format: "markdown" }, kind: undefined }).fields).toEqual([
      { label: "Chat", kind: "inline", value: "Ann" },
      { label: "Message", kind: "text", value: "hello" },
      { label: "In reply to", kind: "inline", value: "9" },
      { label: "Format", kind: "inline", value: "MarkdownV2" },
    ]);
  });
});


const BUTTONS = [[{ text: "Add milk", data: "add:33693" }, { text: "Skip", data: "skip" }], [{ text: "Open", url: "https://www.ah.nl" }]];
const OWN: TelegramMessage = { id: "7", chatId: "5", sentAt: new Date(7000).toISOString(), fromBot: true, text: "Order?", buttons: BUTTONS };
const PHOTO: TelegramMessage = {
  id: "8", chatId: "5", sentAt: new Date(8000).toISOString(), fromBot: false, text: "receipt", attachment: "photo",
  file: { mediaType: "image/jpeg", size: 3 },
};

function chatWith(options: Parameters<typeof fakeBinding>[0] = {}) {
  const { queue, observations } = fakeQueue();
  const fake = fakeBinding({ chatId: "5", kept: [PHOTO, OWN, ...[3, 2, 1].map(stored)], ...options });
  return { ...fake, observations, session: new TelegramChatSessionImpl(queue as never, fake.binding, "5") };
}

describe("buttons, pictures and files", () => {
  it("queues a message with buttons, and shows them on the waiting message", async () => {
    const { session, queue } = chatWith();
    const handle = await session.sendMessage("Order?", { buttons: BUTTONS });
    expect(queue.mock.calls[0][0]).toEqual({ type: "text", chatId: "5", text: "Order?", options: { buttons: BUTTONS } });
    expect(await handle.get()).toMatchObject({ id: "pending-1", text: "Order?", buttons: BUTTONS, fromBot: true });
  });

  it("refuses buttons Telegram or a phone could not show", async () => {
    const { session, queue } = chatWith();
    const send = (buttons: unknown) => session.sendMessage("x", { buttons: buttons as never });
    await expect(send([[]])).rejects.toThrow("at least one button");
    await expect(send([[{ text: "", data: "a" }]])).rejects.toThrow("text must be");
    await expect(send([[{ text: "a", data: "x".repeat(65) }]])).rejects.toThrow("1 to 64 bytes");
    await expect(send([[{ text: "a", url: "javascript:alert(1)" }]])).rejects.toThrow("https or http");
    await expect(send(Array.from({ length: 11 }, () => [{ text: "a", data: "a" }]))).rejects.toThrow("10 rows");
    expect(queue).not.toHaveBeenCalled();
  });

  it("queues a picture with its bytes kept aside, described by name, size and checksum", async () => {
    const { session, queue, uploads } = chatWith();
    const content = new Uint8Array([1, 2, 3, 4]);
    const handle = await session.sendPhoto({ content, filename: "shot.png", mediaType: "image/png" }, { caption: "look" });
    expect(queue.mock.calls[0][0]).toEqual({
      type: "media", chatId: "5", media: "photo", caption: "look", options: {},
      file: {
        filename: "shot.png", mediaType: "image/png", size: 4, chunks: 0,
        sha256: "9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a",
      },
    });
    expect(uploads[0]).toEqual(content);
    expect(await handle.get()).toMatchObject({
      id: "pending-1", text: "look", attachment: "photo", file: { filename: "shot.png", mediaType: "image/png", size: 4 },
    });
  });

  it("takes an ArrayBuffer and any file type through sendFile, but only images through sendPhoto", async () => {
    const { session, queue } = chatWith();
    const pdf = { content: new Uint8Array([1]).buffer, filename: "scan.pdf", mediaType: "application/pdf" };
    await session.sendFile(pdf);
    expect(queue.mock.calls[0][0]).toMatchObject({ media: "document", file: { filename: "scan.pdf", size: 1 } });
    await expect(session.sendPhoto(pdf)).rejects.toThrow("JPEG, PNG or WEBP");
    await expect(session.sendFile({ ...pdf, content: new Uint8Array(0) })).rejects.toThrow("empty");
    await expect(session.sendFile({ ...pdf, filename: "../x" })).rejects.toThrow("filename");
    await expect(session.sendFile({ ...pdf, mediaType: "pdf" })).rejects.toThrow("mediaType");
    await expect(session.sendFile(pdf, { caption: "c".repeat(1025) })).rejects.toThrow("1024");
    expect(queue).toHaveBeenCalledTimes(1);
  });
});

describe("buttons with nothing listening", () => {
  const DATA = [[{ text: "Yes", data: "yes" }]];
  const LINK = [[{ text: "Open", url: "https://www.ah.nl" }]];

  it("are refused wherever they could be put under a message, with what to do instead", async () => {
    const { session, queue } = chatWith({ listening: false });
    await expect(session.sendMessage("Add milk?", { buttons: DATA }))
      .rejects.toThrow(/Nothing is listening for button presses.*subscribe\(\).*receiveButtonPress\(\)/s);
    await expect(session.sendPhoto(
      { content: new Uint8Array([1]), filename: "a.png", mediaType: "image/png" }, { buttons: DATA }))
      .rejects.toThrow("Nothing is listening");
    await expect(session.getMessage("7").edit("Add milk?", { buttons: DATA })).rejects.toThrow("Nothing is listening");
    await expect(session.getMessage("7").setButtons(DATA)).rejects.toThrow("Nothing is listening");
    expect(queue).not.toHaveBeenCalled();
  });

  it("still allow link buttons, removing buttons, and messages without any", async () => {
    const { session, queue } = chatWith({ listening: false });
    await session.sendMessage("See the order", { buttons: LINK });
    await session.sendMessage("plain");
    await session.getMessage("7").setButtons([]);
    await session.getMessage("7").edit("Done");
    expect(queue).toHaveBeenCalledTimes(4);
  });
});

describe("a message handle", () => {
  it("reads a kept message and its file, reporting the chat", async () => {
    const { session, observations, readFile } = chatWith();
    expect(await session.getMessage("8").get()).toEqual(PHOTO);
    const file = await session.getMessage("8").readFile();
    expect(new Uint8Array(file.content)).toEqual(new Uint8Array([1, 2, 3]));
    expect(readFile).toHaveBeenCalledWith(ANN, "5", "8");
    expect(observations.map(o => o.subresources)).toEqual([["chat/5"], ["chat/5"]]);
  });

  it("refuses an id that is not one, and a message the chat no longer keeps", async () => {
    const { session } = chatWith();
    expect(() => session.getMessage("abc")).toThrow("not a message id");
    await expect(session.getMessage("99").get()).rejects.toThrow("no longer kept");
  });

  it("queues an edit, new buttons, a deletion and a reaction for the bot's own message", async () => {
    const { session, queue } = chatWith();
    const handle = session.getMessage("7");
    await handle.edit("Added milk");
    await handle.setButtons([]);
    await handle.react("👍");
    await handle.delete();
    expect(queue.mock.calls.map(call => call[0])).toEqual([
      { type: "edit", chatId: "5", messageId: "7", text: "Added milk", options: {} },
      { type: "buttons", chatId: "5", messageId: "7", buttons: [] },
      { type: "react", chatId: "5", messageId: "7", emoji: "👍" },
      { type: "delete", chatId: "5", messageId: "7" },
    ]);
  });

  it("shows queued changes at once: the edit, then the message gone", async () => {
    const { session } = chatWith();
    const handle = session.getMessage("7");
    await handle.edit("Added milk");
    expect(await handle.get()).toEqual({ id: "7", chatId: "5", sentAt: OWN.sentAt, fromBot: true, text: "Added milk" });
    expect((await session.listMessages()).messages.find(m => m.id === "7")?.text).toBe("Added milk");
    await handle.delete();
    await expect(handle.get()).rejects.toThrow("no longer kept");
    expect((await session.listMessages()).messages.some(m => m.id === "7")).toBe(false);
  });

  it("lets anyone's message be reacted to, but only the bot's own be changed", async () => {
    const { session, queue } = chatWith();
    const theirs = session.getMessage("8");
    await theirs.react(null);
    await expect(theirs.edit("x")).rejects.toThrow("Only the bot's own");
    await expect(theirs.setButtons([])).rejects.toThrow("Only the bot's own");
    await expect(theirs.delete()).rejects.toThrow("Only the bot's own");
    await expect(theirs.react("two words")).rejects.toThrow("does not allow that emoji");
    expect(queue).toHaveBeenCalledTimes(1);
  });

  it("can't change a message that has not been sent, and follows it once it has", async () => {
    const waiting = chatWith();
    const handle = await waiting.session.sendMessage("Order?");
    await expect(handle.edit("x")).rejects.toThrow("has not been sent yet");
    await expect(handle.react("👍")).rejects.toThrow("has not been sent yet");
    await expect(handle.readFile()).rejects.toThrow("has not been sent yet");

    // The same handle id after its send was carried out as message 7.
    const sent = chatWith({ sent: { 1: "7" } });
    const later = sent.session.getMessage("pending-1");
    expect((await later.get()).id).toBe("7");
    await later.edit("Done");
    expect(sent.queue.mock.calls[0][0]).toMatchObject({ type: "edit", messageId: "7" });
    await expect(chatWith().session.getMessage("pending-4").get()).rejects.toThrow("was not sent");
  });

  it("checks an edited caption as a caption, and an edited message as a message", async () => {
    const own = { ...PHOTO, id: "9", fromBot: true };
    const { session } = chatWith({ kept: [own, OWN] });
    await expect(session.getMessage("9").edit("")).resolves.toBeUndefined();
    await expect(session.getMessage("9").edit("c".repeat(1025))).rejects.toThrow("1024");
    await expect(session.getMessage("7").edit("")).rejects.toThrow("needs some text");
  });
});
