import { describe, expect, it } from "vitest";
import { LINK_CODE_PATTERN, newLinkCode, parseCommand } from "../src/commands";

describe("parseCommand", () => {
  it.each([
    ["/start", { kind: "start" }],
    ["/start abcDEF123_-abcDEF123_-", { kind: "start", code: "abcDEF123_-abcDEF123_-" }],
    ["/link", { kind: "link" }],
    ["/link@family_bot", { kind: "link" }],
    ["/LINK@Family_Bot", { kind: "link" }],
    ["  /unlink  ", { kind: "unlink" }],
  ])("reads %j", (text, command) => {
    expect(parseCommand(text, "family_bot")).toEqual(command);
  });

  it.each([
    ["ordinary text", "hello"],
    ["a command for another bot", "/link@other_bot"],
    ["an unknown command", "/help"],
    ["a command with a sentence after it", "/link the family group please"],
    ["no text", undefined],
  ])("ignores %s", (_case, text) => {
    expect(parseCommand(text, "family_bot")).toBeUndefined();
  });
});

describe("link codes", () => {
  it("fit Telegram's deep-link alphabet and length, and differ every time", () => {
    const codes = new Set(Array.from({ length: 50 }, newLinkCode));
    expect(codes.size).toBe(50);
    for (const code of codes) expect(code).toMatch(LINK_CODE_PATTERN);
  });
});
