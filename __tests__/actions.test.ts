import { describe, expect, it } from "vitest";
import {
  buttonRows,
  chatKind,
  deleteBlob,
  describeAction,
  familyOf,
  groupKind,
  pendingActionId,
  pendingMessage,
  readBlob,
  RULE_FAMILIES,
  selfKind,
  storeBlob,
  withPendingChanges,
  type NewAction,
  type StoredFile,
} from "../src/actions";
import type { TelegramMessage } from "../src/types";

const CONTEXT = { chatTitle: "Family", botUsername: "family_bot" };
const BUTTONS = [[{ text: "Add milk", data: "add:1" }], [{ text: "Open", url: "https://www.ah.nl" }]];
const FILE: StoredFile = { filename: "shot.png", mediaType: "image/png", size: 4, sha256: "ab".repeat(32), chunks: 1 };

describe("rules", () => {
  it("keep sending text under the tag it always had", () => {
    expect(chatKind("send-message")).toEqual({ tag: "send-message", label: "Send Telegram messages" });
    expect(selfKind("send-message")).toEqual({ tag: "send-message", label: "Send Telegram messages to yourself" });
    expect(groupKind("send-message", { id: "-100", title: "Family" }))
      .toEqual({ tag: "send-message:chat:-100", label: "Send Telegram messages to Family" });
  });

  it("give pictures and files, edits, and reactions tags of their own", () => {
    expect(RULE_FAMILIES).toEqual(["send-message", "send-media", "update-message", "react-message"]);
    expect(selfKind("send-media").label).toBe("Send Telegram pictures and files to yourself");
    expect(chatKind("update-message")).toEqual({ tag: "update-message", label: "Edit Telegram messages" });
    expect(chatKind("react-message")).toEqual({ tag: "react-message", label: "React to Telegram messages" });
    expect(selfKind("update-message").label).toBe("Edit Telegram messages in your own chat");
    expect(selfKind("react-message").label).toBe("React to Telegram messages in your own chat");
    expect(groupKind("update-message", { id: "-100", title: "Family" }))
      .toEqual({ tag: "update-message:chat:-100", label: "Edit Telegram messages in Family" });
    expect(groupKind("react-message", { id: "-100", title: "Family" }))
      .toEqual({ tag: "react-message:chat:-100", label: "React to Telegram messages in Family" });
  });

  it("put each action under one family, and deleting under none", () => {
    const family = (action: object) => familyOf({ chatId: "5", ...action } as NewAction);
    expect(family({ text: "hi", options: {} })).toBe("send-message");
    expect(family({ type: "text", text: "hi", options: {} })).toBe("send-message");
    expect(family({ type: "media", media: "photo", file: FILE, options: {} })).toBe("send-media");
    expect(family({ type: "edit", messageId: "7", text: "x", options: {} })).toBe("update-message");
    expect(family({ type: "buttons", messageId: "7", buttons: [] })).toBe("update-message");
    // A reaction is never approved by the rule for edits, nor an edit by the one for reactions.
    expect(family({ type: "react", messageId: "7", emoji: "👍" })).toBe("react-message");
    expect(family({ type: "delete", messageId: "7" })).toBeUndefined();
  });
});

describe("approval descriptions", () => {
  it("list each button with what pressing it does", () => {
    expect(buttonRows(BUTTONS)).toEqual([
      'Row 1: [Add milk] reports "add:1"',
      "Row 2: [Open] opens https://www.ah.nl",
    ]);
    const description = describeAction(
      { type: "text", chatId: "5", text: "Order?", options: { buttons: BUTTONS } },
      { ...CONTEXT, kind: chatKind("send-message") });
    expect(description.fields?.at(-1)).toEqual({ label: "Buttons", kind: "list", items: buttonRows(BUTTONS) });
    expect(description).toMatchObject({ autoApprovable: true, actionKind: { tag: "send-message" } });
  });

  it("name a picture without claiming to have shown it", () => {
    const description = describeAction(
      { type: "media", chatId: "5", media: "photo", file: FILE, caption: "look", options: {} },
      { ...CONTEXT, kind: chatKind("send-media") });
    expect(description.title).toBe("Send a picture to Family on Telegram");
    expect(description.description).toContain("Its content is not shown here");
    expect(description.fields).toEqual([
      { label: "Chat", kind: "inline", value: "Family" },
      { label: "Picture", kind: "file", name: "shot.png", mediaType: "image/png", size: 4, sha256: FILE.sha256, origin: "agent" },
      { label: "Caption", kind: "text", value: "look" },
    ]);
    // Bytes the approver cannot read leave the description incomplete.
    expect(description.descriptionIsComplete).toBeUndefined();
    expect(description.actionKind).toEqual({ tag: "send-media", label: "Send Telegram pictures and files" });
  });

  it("show an edit against the message it changes", () => {
    const target: TelegramMessage = { id: "7", chatId: "5", sentAt: "", fromBot: true, text: "Order?" };
    const description = describeAction(
      { type: "edit", chatId: "5", messageId: "7", text: "Added milk", options: {} },
      { ...CONTEXT, kind: chatKind("update-message"), target });
    expect(description.fields).toEqual([
      { label: "Chat", kind: "inline", value: "Family" },
      { label: "Message", kind: "inline", value: "7" },
      { label: "Current text", kind: "text", value: "Order?" },
      { label: "New text", kind: "text", value: "Added milk" },
    ]);
    expect(description.descriptionIsComplete).toBe(true);
  });

  it("always leave a deletion to a person", () => {
    const description = describeAction({ type: "delete", chatId: "5", messageId: "7" }, { ...CONTEXT, kind: undefined });
    expect(description).toMatchObject({ title: "Delete a Telegram message in Family", autoApprovable: false });
    expect(description.actionKind).toBeUndefined();
  });

  it("say whose message a reaction is on", () => {
    const target: TelegramMessage = {
      id: "8", chatId: "5", sentAt: "", fromBot: false, text: "dinner at 7",
      from: { id: "5", name: "Ann", isBot: false },
    };
    const description = describeAction(
      { type: "react", chatId: "5", messageId: "8", emoji: "👍" }, { ...CONTEXT, kind: chatKind("react-message"), target });
    expect(description.actionKind).toEqual({ tag: "react-message", label: "React to Telegram messages" });
    expect(description.fields).toEqual([
      { label: "Chat", kind: "inline", value: "Family" },
      { label: "Reaction", kind: "inline", value: "👍" },
      { label: "Message", kind: "inline", value: "8" },
      { label: "From", kind: "inline", value: "Ann" },
      { label: "Its text", kind: "text", value: "dinner at 7" },
    ]);
  });
});

describe("queued actions in what is read", () => {
  const kept: TelegramMessage[] = [
    { id: "7", chatId: "5", sentAt: "", fromBot: true, text: "Order?", buttons: BUTTONS },
    { id: "6", chatId: "5", sentAt: "", fromBot: false, text: "hi" },
  ];

  it("read a waiting send as a message, and anything else as none", () => {
    expect(pendingMessage(3, { chatId: "5", text: "hi", options: { replyTo: "6" }, submittedAt: 0 })).toEqual({
      id: "pending-3", chatId: "5", sentAt: "1970-01-01T00:00:00.000Z", fromBot: true, text: "hi", replyTo: "6",
    });
    expect(pendingMessage(4, { type: "react", chatId: "5", messageId: "6", emoji: "👍", submittedAt: 0 })).toBeUndefined();
    expect(pendingActionId("pending-3")).toBe(3);
    expect(pendingActionId("3")).toBeUndefined();
    expect(pendingActionId("pending-0")).toBeUndefined();
  });

  it("apply edits, button changes and deletions in order, leaving the rest alone", () => {
    const edited = withPendingChanges(kept, [
      { type: "edit", chatId: "5", messageId: "7", text: "Added milk", options: {}, submittedAt: 1 },
    ]);
    expect(edited[0]).toEqual({ id: "7", chatId: "5", sentAt: "", fromBot: true, text: "Added milk" });
    expect(edited[1]).toBe(kept[1]);

    const rebuttoned = withPendingChanges(kept, [
      { type: "buttons", chatId: "5", messageId: "7", buttons: [[{ text: "Undo", data: "undo" }]], submittedAt: 1 },
    ]);
    expect(rebuttoned[0]).toMatchObject({ text: "Order?", buttons: [[{ text: "Undo", data: "undo" }]] });

    expect(withPendingChanges(kept, [
      { type: "delete", chatId: "5", messageId: "7", submittedAt: 1 },
      { type: "react", chatId: "5", messageId: "6", emoji: "👍", submittedAt: 2 },
      { type: "delete", chatId: "-100", messageId: "6", submittedAt: 3 },
    ])).toEqual([kept[1]]);
  });
});

describe("kept file bytes", () => {
  function memoryKv() {
    const map = new Map<string, unknown>();
    return {
      map,
      get: <T>(key: string) => map.get(key) as T | undefined,
      put: (key: string, value: unknown) => { map.set(key, value); },
      delete: (key: string) => map.delete(key),
    };
  }

  it("round-trip across chunks, and are gone once deleted", () => {
    const kv = memoryKv();
    const bytes = new Uint8Array(2 * 1024 * 1024 + 5).map((_, index) => index % 251);
    const chunks = storeBlob(kv, 9, bytes);
    expect(chunks).toBe(3);
    const file = { ...FILE, size: bytes.byteLength, chunks };
    const read = readBlob(kv, 9, file)!;
    // Compared by hand: a deep-equality check of two megabytes is slow enough to time out.
    expect(read.byteLength).toBe(bytes.byteLength);
    expect(read.every((byte, index) => byte === bytes[index])).toBe(true);
    // Another action's bytes are its own.
    expect(readBlob(kv, 10, file)).toBeUndefined();

    kv.delete("blob:9:1");
    expect(readBlob(kv, 9, file)).toBeUndefined();
    deleteBlob(kv, 9, chunks);
    expect(kv.map.size).toBe(0);
  });
});
