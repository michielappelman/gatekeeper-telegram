import { describe, expect, it } from "vitest";
import {
  normalizeReaction,
  REACTION_EMOJI,
  callApi,
  downloadFile,
  editButtons,
  editMessage,
  getMe,
  isBotTokenShaped,
  messageFile,
  sendMedia,
  sendMessage,
  setReaction,
  setWebhook,
  TelegramError,
  toChatInfo,
  toMessage,
  updateMessage,
  updatePress,
  updateReaction,
  validateSend,
  type WireMessage,
} from "../src/telegram-api";

const TOKEN = "123456789:AAEexampleexampleexampleexample123";

type Captured = { url: string; body: unknown };

function fakeFetch(status: number, envelope: unknown, captured: Captured[] = []) {
  return async (url: string, init: RequestInit) => {
    captured.push({ url, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify(envelope), { status, headers: { "Content-Type": "application/json" } });
  };
}

async function failureOf(promise: Promise<unknown>): Promise<TelegramError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof TelegramError) return error;
    throw error;
  }
  throw new Error("expected a TelegramError");
}

describe("tokens", () => {
  it("recognizes BotFather's token shape", () => {
    expect(isBotTokenShaped(TOKEN)).toBe(true);
    expect(isBotTokenShaped("not-a-token")).toBe(false);
    expect(isBotTokenShaped("123456789:short")).toBe(false);
  });

  it("never sends a malformed token", async () => {
    const captured: Captured[] = [];
    const error = await failureOf(callApi("nope", "getMe", {}, fakeFetch(200, { ok: true, result: {} }, captured)));
    expect(error.code).toBe("INVALID_TOKEN");
    expect(captured).toHaveLength(0);
  });
});

describe("callApi", () => {
  it("returns the result of a successful call", async () => {
    const captured: Captured[] = [];
    const result = await callApi<boolean>(TOKEN, "deleteWebhook", {}, fakeFetch(200, { ok: true, result: true }, captured));
    expect(result).toBe(true);
    expect(captured[0].url).toBe(`https://api.telegram.org/bot${TOKEN}/deleteWebhook`);
  });

  it.each([
    [401, "AUTH_EXPIRED"],
    [403, "FORBIDDEN"],
    [400, "BAD_REQUEST"],
    [429, "RATE_LIMITED"],
    [502, "UNAVAILABLE"],
  ] as const)("maps HTTP %i to %s", async (status, code) => {
    const error = await failureOf(callApi(TOKEN, "getMe", {},
      fakeFetch(status, { ok: false, error_code: status, description: "Bad Request: chat not found" })));
    expect(error.code).toBe(code);
  });

  it("passes on Telegram's reason and retry time", async () => {
    expect((await failureOf(callApi(TOKEN, "sendMessage", {},
      fakeFetch(400, { ok: false, description: "Bad Request: chat not found" })))).message)
      .toBe("Telegram refused: Bad Request: chat not found");
    expect((await failureOf(callApi(TOKEN, "sendMessage", {},
      fakeFetch(429, { ok: false, parameters: { retry_after: 7 } })))).message)
      .toContain("retry in 7 s");
  });

  it("keeps the token out of every error", async () => {
    const failing = async () => { throw new Error(`fetch failed for https://api.telegram.org/bot${TOKEN}/getMe`); };
    for (const fetchFn of [failing, fakeFetch(401, { ok: false }), fakeFetch(500, "not json")]) {
      const error = await failureOf(callApi(TOKEN, "getMe", {}, fetchFn));
      expect(error.message).not.toContain(TOKEN.split(":")[1]);
    }
  });

  it("treats ok: false on HTTP 200 as a failure", async () => {
    expect((await failureOf(callApi(TOKEN, "getMe", {}, fakeFetch(200, { ok: false })))).code).toBe("UNAVAILABLE");
  });
});

describe("calls", () => {
  it("getMe refuses a token that isn't a bot's", async () => {
    const user = { id: 1, is_bot: false, first_name: "A" };
    expect((await failureOf(getMe(TOKEN, fakeFetch(200, { ok: true, result: user })))).code).toBe("BAD_REQUEST");
  });

  it("getMe returns the bot's identity", async () => {
    const bot = { id: 42, is_bot: true, first_name: "Home", last_name: "Bot", username: "home_bot" };
    expect(await getMe(TOKEN, fakeFetch(200, { ok: true, result: bot })))
      .toEqual({ id: "42", username: "home_bot", name: "Home Bot" });
  });

  it("setWebhook asks for messages, channel posts and button presses, with the secret", async () => {
    const captured: Captured[] = [];
    await setWebhook(TOKEN, "https://os.example.com/gatekeeper/telegram/webhook/x", "s3cret",
      fakeFetch(200, { ok: true, result: true }, captured));
    expect(captured[0].body).toEqual({
      url: "https://os.example.com/gatekeeper/telegram/webhook/x",
      secret_token: "s3cret",
      allowed_updates: ["message", "channel_post", "callback_query", "message_reaction"],
    });
  });

  it("sendMessage sends plain text by default, and MarkdownV2 and replies when asked", async () => {
    const captured: Captured[] = [];
    const fetchFn = fakeFetch(200, { ok: true, result: { message_id: 1, date: 0, chat: { id: 5, type: "private" } } }, captured);
    await sendMessage(TOKEN, "5", "hi", {}, fetchFn);
    await sendMessage(TOKEN, "5", "*hi*", { format: "markdown", replyTo: "9" }, fetchFn);
    expect(captured[0].body).toEqual({ chat_id: "5", text: "hi" });
    expect(captured[1].body).toEqual({
      chat_id: "5", text: "*hi*", parse_mode: "MarkdownV2",
      reply_parameters: { message_id: 9, allow_sending_without_reply: true },
    });
  });
});

describe("reaction changes", () => {
  const change = {
    chat: { id: -100, type: "group" as const, title: "Family" }, message_id: 7, date: 1_800_000_000,
    user: { id: 5, is_bot: false, first_name: "Ann" },
    old_reaction: [],
    new_reaction: [{ type: "emoji", emoji: "👍" }, { type: "custom_emoji" }, { type: "paid" }],
  };

  it("are read with the standard emoji before and after, and who reacted", () => {
    expect(updateReaction({ update_id: 1, message_reaction: change })).toEqual({
      chat: change.chat, messageId: "7", date: 1_800_000_000, from: change.user, emoji: ["👍"], previous: [],
    });
    const anonymous = updateReaction({ update_id: 1, message_reaction: { ...change, user: undefined } });
    expect(anonymous?.from).toBeUndefined();
    expect(updateMessage({ update_id: 1, message_reaction: change })).toBeUndefined();
  });

  it("are ignored when malformed", () => {
    expect(updateReaction({ update_id: 1 })).toBeUndefined();
    expect(updateReaction({ update_id: 1, message_reaction: { ...change, new_reaction: undefined as never } }))
      .toBeUndefined();
    expect(updateReaction({ update_id: 1, message_reaction: { ...change, message_id: "7" as never } }))
      .toBeUndefined();
  });
});

describe("reactions", () => {
  it("accepts Telegram's fixed set, however the emoji was typed", () => {
    expect(normalizeReaction(null)).toBeNull();
    expect(normalizeReaction("👍")).toBe("👍");
    // With the variation selector most keyboards add, which Telegram refuses.
    expect(normalizeReaction("\u2764\uFE0F")).toBe("\u2764");
    expect(normalizeReaction(" \u270D\uFE0F ")).toBe("\u270D");
    expect(normalizeReaction("\u2764\uFE0F\u200D\uD83D\uDD25")).toBe("\u2764\u200D\uD83D\uDD25");
    expect(REACTION_EMOJI.size).toBe(73);
    for (const emoji of REACTION_EMOJI) expect(emoji.includes("\uFE0F"), emoji).toBe(false);
  });

  it("refuses any other emoji before anyone is asked to approve it", () => {
    for (const emoji of ["✅", "☑️", "🚀", "", "ok", "👍👍"]) {
      expect(() => normalizeReaction(emoji), emoji).toThrow(/does not allow that emoji/);
    }
  });
});

describe("validateSend", () => {
  it("accepts an ordinary message", () => {
    expect(() => validateSend("hello", { replyTo: "12", format: "plain" })).not.toThrow();
  });

  it.each([
    ["empty text", "   ", {}],
    ["text over 4096 characters", "x".repeat(4097), {}],
    ["a replyTo that isn't a message id", "hi", { replyTo: "pending-3" }],
    ["an unknown format", "hi", { format: "html" }],
  ])("refuses %s", (_case, text, options) => {
    expect(() => validateSend(text, options as never)).toThrow(TelegramError);
  });
});

describe("conversions", () => {
  const BOT_ID = "42";
  const base: WireMessage = {
    message_id: 7, date: 1_700_000_000, chat: { id: 5, type: "private", first_name: "Ann", last_name: "Lee" },
  };

  it("converts a text message from a person", () => {
    expect(toMessage({ ...base, from: { id: 5, is_bot: false, first_name: "Ann", username: "ann" }, text: "hi",
      reply_to_message: { message_id: 3 } }, BOT_ID)).toEqual({
      id: "7", chatId: "5", sentAt: "2023-11-14T22:13:20.000Z",
      from: { id: "5", name: "Ann", username: "ann", isBot: false },
      fromBot: false, text: "hi", replyTo: "3",
    });
  });

  it("names the attachment and keeps a photo's caption as its text", () => {
    const message = toMessage({ ...base, photo: [{}], caption: "look" }, BOT_ID);
    expect(message.attachment).toBe("photo");
    expect(message.text).toBe("look");
  });

  it("marks the bot's own messages", () => {
    expect(toMessage({ ...base, from: { id: 42, is_bot: true, first_name: "Home" } }, BOT_ID).fromBot).toBe(true);
  });

  it("names a channel post by its channel", () => {
    expect(toMessage({ ...base, chat: { id: -100, type: "channel", title: "News" },
      sender_chat: { id: -100, type: "channel", title: "News" }, text: "x" }, BOT_ID).from)
      .toEqual({ id: "-100", name: "News", isBot: false });
  });

  it("titles a chat by its title, else the person's name", () => {
    expect(toChatInfo({ id: -1, type: "group", title: "Family" }).title).toBe("Family");
    expect(toChatInfo(base.chat).title).toBe("Ann Lee");
    expect(toChatInfo({ id: 9, type: "private", username: "x" }).title).toBe("x");
  });

  it("takes messages and channel posts from updates, and ignores the rest", () => {
    expect(updateMessage({ update_id: 1, message: base })).toBe(base);
    expect(updateMessage({ update_id: 1, channel_post: base })).toBe(base);
    expect(updateMessage({ update_id: 1 })).toBeUndefined();
    expect(updateMessage({ update_id: 1, message: { ...base, chat: undefined } as never })).toBeUndefined();
  });
});

describe("buttons, media and changes on the wire", () => {
  const BUTTONS = [[{ text: "Add", data: "add:1" }, { text: "Open", url: "https://www.ah.nl" }]];
  const KEYBOARD = { inline_keyboard: [[{ text: "Add", callback_data: "add:1" }, { text: "Open", url: "https://www.ah.nl" }]] };
  const sent = { ok: true, result: { message_id: 1, date: 1, chat: { id: 5, type: "private" } } };

  it("sends buttons as an inline keyboard", async () => {
    const captured: Captured[] = [];
    await sendMessage(TOKEN, "5", "Order?", { buttons: BUTTONS }, fakeFetch(200, sent, captured));
    expect(captured[0].body).toEqual({ chat_id: "5", text: "Order?", reply_markup: KEYBOARD });
  });

  it("uploads a picture as multipart, with JSON-encoded options", async () => {
    const forms: { url: string; form: FormData; contentType: unknown }[] = [];
    const fetchFn = async (url: string, init: RequestInit) => {
      forms.push({ url, form: init.body as FormData, contentType: (init.headers as Record<string, string> | undefined)?.["Content-Type"] });
      return new Response(JSON.stringify(sent));
    };
    const file = { bytes: new Uint8Array([1, 2, 3]), filename: "shot.png", mediaType: "image/png" };
    await sendMedia(TOKEN, "photo", "5", file, { caption: "look", replyTo: "9", buttons: BUTTONS }, fetchFn);
    await sendMedia(TOKEN, "document", "5", file, {}, fetchFn);

    expect(forms[0].url.endsWith("/sendPhoto")).toBe(true);
    // Left to fetch, which adds the multipart boundary.
    expect(forms[0].contentType).toBeUndefined();
    const { form } = forms[0];
    expect(form.get("chat_id")).toBe("5");
    expect(form.get("caption")).toBe("look");
    expect(JSON.parse(form.get("reply_markup") as string)).toEqual(KEYBOARD);
    expect(JSON.parse(form.get("reply_parameters") as string)).toEqual({ message_id: 9, allow_sending_without_reply: true });
    const photo = form.get("photo") as File;
    expect([photo.name, photo.type, photo.size]).toEqual(["shot.png", "image/png", 3]);

    expect(forms[1].url.endsWith("/sendDocument")).toBe(true);
    expect(forms[1].form.has("caption")).toBe(false);
    expect((forms[1].form.get("document") as File).name).toBe("shot.png");
  });

  it("edits text or a caption, replaces buttons, and sets or clears a reaction", async () => {
    const captured: Captured[] = [];
    const fetchFn = fakeFetch(200, sent, captured);
    await editMessage(TOKEN, "5", "7", "*Added*", { format: "markdown", buttons: BUTTONS }, fetchFn);
    await editMessage(TOKEN, "5", "7", "new caption", { caption: true }, fetchFn);
    await editButtons(TOKEN, "5", "7", [], fetchFn);
    const ok = fakeFetch(200, { ok: true, result: true }, captured);
    await setReaction(TOKEN, "5", "7", "👍", ok);
    await setReaction(TOKEN, "5", "7", null, ok);
    expect(captured.map(call => [call.url.split("/").pop(), call.body])).toEqual([
      ["editMessageText", { chat_id: "5", message_id: 7, text: "*Added*", parse_mode: "MarkdownV2", reply_markup: KEYBOARD }],
      ["editMessageCaption", { chat_id: "5", message_id: 7, caption: "new caption" }],
      ["editMessageReplyMarkup", { chat_id: "5", message_id: 7, reply_markup: { inline_keyboard: [] } }],
      ["setMessageReaction", { chat_id: "5", message_id: 7, reaction: [{ type: "emoji", emoji: "👍" }] }],
      ["setMessageReaction", { chat_id: "5", message_id: 7, reaction: [] }],
    ]);
  });

  it("downloads a file by its id, and refuses one too large before fetching it", async () => {
    const urls: string[] = [];
    const fetchFn = (size: number) => async (url: string, _init: RequestInit) => {
      urls.push(url);
      return url.includes("/file/bot")
        ? new Response(new Uint8Array([9, 8, 7]))
        : new Response(JSON.stringify({ ok: true, result: { file_path: "photos/a.jpg", file_size: size } }));
    };
    expect(new Uint8Array(await downloadFile(TOKEN, "f-1", fetchFn(3)))).toEqual(new Uint8Array([9, 8, 7]));
    expect(urls[1]).toBe(`https://api.telegram.org/file/bot${TOKEN}/photos/a.jpg`);

    urls.length = 0;
    const error = await failureOf(downloadFile(TOKEN, "f-1", fetchFn(21 * 1024 * 1024)));
    expect(error.message).toContain("larger than the 10 MB");
    expect(error.message).not.toContain(TOKEN);
    expect(urls).toHaveLength(1);
  });
});

describe("what a message carries", () => {
  const base: WireMessage = { message_id: 1, date: 1, chat: { id: 5, type: "private" } };

  it("finds the full-size photo, or a document with its name and type", () => {
    expect(messageFile({ ...base, photo: [{ file_id: "small", file_size: 1 }, { file_id: "big", file_size: 99 }] }))
      .toEqual({ fileId: "big", mediaType: "image/jpeg", size: 99 });
    expect(messageFile({ ...base, document: { file_id: "d", file_name: "a.pdf", mime_type: "application/pdf", file_size: 5 } }))
      .toEqual({ fileId: "d", filename: "a.pdf", mediaType: "application/pdf", size: 5 });
    expect(messageFile({ ...base, voice: { file_id: "v", mime_type: "audio/ogg" } })).toEqual({ fileId: "v", mediaType: "audio/ogg" });
    expect(messageFile({ ...base, location: { latitude: 1, longitude: 2 } })).toBeUndefined();
    expect(messageFile({ ...base, text: "hi" })).toBeUndefined();
  });

  it("shows the file without Telegram's id for it, and the buttons under a message", () => {
    const message = toMessage({
      ...base,
      photo: [{ file_id: "big", file_size: 99 }], caption: "look",
      reply_markup: { inline_keyboard: [[{ text: "Add", callback_data: "add:1" }, { text: "Pay", pay: true } as never], []] },
    }, "42");
    expect(message).toMatchObject({
      text: "look", attachment: "photo", file: { mediaType: "image/jpeg", size: 99 },
      buttons: [[{ text: "Add", data: "add:1" }]],
    });
    expect(JSON.stringify(message)).not.toContain("big");
  });
});

describe("button presses", () => {
  const press = {
    update_id: 1,
    callback_query: {
      id: "q1", from: { id: 5, is_bot: false, first_name: "Ann" }, data: "add:1",
      message: { message_id: 7, chat: { id: -100, type: "group" as const, title: "Family" } },
    },
  };

  it("are read from a callback query under a message", () => {
    expect(updatePress(press)).toEqual({
      id: "q1", from: press.callback_query.from, chat: press.callback_query.message.chat, messageId: "7", data: "add:1",
    });
    expect(updateMessage(press)).toBeUndefined();
  });

  it("are ignored when malformed or not under a message", () => {
    expect(updatePress({ update_id: 1 })).toBeUndefined();
    expect(updatePress({ update_id: 1, callback_query: { ...press.callback_query, data: undefined } })).toBeUndefined();
    expect(updatePress({ update_id: 1, callback_query: { ...press.callback_query, message: undefined } })).toBeUndefined();
  });
});
