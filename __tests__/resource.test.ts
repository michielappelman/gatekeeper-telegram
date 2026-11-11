import { describe, expect, it } from "vitest";
import {
  accountSubresource,
  BOT_RESOURCE,
  botResourceUrl,
  CHAT_RESOURCE,
  chatResourceUrl,
  chatSubresource,
  parseResourceUrl,
  parseSubresource,
} from "../src/resource";
import { isReportedBy } from "../src/telegram";
import { TelegramError } from "../src/telegram-api";

const ANN = "11111111-1111-4111-8111-111111111111";
const BEN = "22222222-2222-4222-8222-222222222222";

describe("chat resource URLs", () => {
  it("round-trips a chat", () => {
    expect(parseResourceUrl(chatResourceUrl("family_bot", "-1001234")))
      .toEqual({ botUsername: "family_bot", chatId: "-1001234" });
  });

  it("matches its pattern", () => {
    expect(new URLPattern(CHAT_RESOURCE.urlPattern).test(chatResourceUrl("family_bot", "5"))).toBe(true);
  });

  it("round-trips the bot, for all the user's chats, and matches only its own pattern", () => {
    expect(parseResourceUrl(botResourceUrl("family_bot"))).toEqual({ botUsername: "family_bot" });
    expect(new URLPattern(BOT_RESOURCE.urlPattern).test(botResourceUrl("family_bot"))).toBe(true);
    expect(new URLPattern(BOT_RESOURCE.urlPattern).test(chatResourceUrl("family_bot", "5"))).toBe(false);
    expect(new URLPattern(CHAT_RESOURCE.urlPattern).test(botResourceUrl("family_bot"))).toBe(false);
  });

  it.each([
    "https://evil.example/family_bot/chat/5",
    "https://t.me/family_bot/",
    "https://t.me/family_bot?start=x",
    "https://t.me/family_bot/chat/5?x=1",
    "https://t.me/family_bot/chat/abc",
    "https://t.me/1bad/chat/5",
    "not a url",
  ])("refuses %s", url => {
    expect(() => parseResourceUrl(url)).toThrow(TelegramError);
  });
});

describe("subresources", () => {
  it("name a chat and an account, and read back", () => {
    expect(chatSubresource("-100")).toBe("chat/-100");
    expect(parseSubresource(chatSubresource("-100"))).toEqual({ kind: "chat", chatId: "-100" });
    expect(parseSubresource(accountSubresource(ANN))).toEqual({ kind: "account", accountId: ANN });
    expect(parseSubresource("bot/42")).toBeUndefined();
    expect(parseSubresource("chat/abc")).toBeUndefined();
  });

  it("let the user's bot be asked about their account and their chats", () => {
    expect(isReportedBy({ accountId: ANN }, accountSubresource(ANN))).toBe(true);
    expect(isReportedBy({ accountId: ANN }, chatSubresource("5"))).toBe(true);
    expect(isReportedBy({ accountId: ANN }, accountSubresource(BEN))).toBe(false);
    expect(isReportedBy({ accountId: ANN }, "repo/1")).toBe(false);
  });

  it("let a one-chat binding be asked about its chat alone", () => {
    expect(isReportedBy({ accountId: ANN, chatId: "5" }, chatSubresource("5"))).toBe(true);
    expect(isReportedBy({ accountId: ANN, chatId: "5" }, chatSubresource("6"))).toBe(false);
    expect(isReportedBy({ accountId: ANN, chatId: "5" }, accountSubresource(ANN))).toBe(false);
  });
});
