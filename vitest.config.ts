import { cloudflareTest } from "@cloudflare/vitest-plugin";
import capnwebValidate from "capnweb-validate/vite";
import { defineConfig } from "vitest/config";

const BOT_USER = { id: 42, is_bot: true, first_name: "Family", username: "family_bot" };
const FILE_BYTES = new TextEncoder().encode("picture bytes");

/**
 * Telegram's Bot API, as far as the hub's tests reach it. A send echoes the message it was given
 * (as message 900), an edit echoes the edited message, and file "f-photo" downloads as
 * `FILE_BYTES`; "f-huge" claims to be too large to read.
 */
async function fakeTelegram(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.hostname !== "api.telegram.org") return new Response("No outbound requests in tests", { status: 502 });
  if (url.pathname.includes("/file/bot")) return new Response(FILE_BYTES);
  const method = url.pathname.split("/").pop()!;
  const multipart = (request.headers.get("Content-Type") ?? "").startsWith("multipart/form-data");
  const fields: Record<string, any> = {};
  if (multipart) {
    for (const [name, value] of await request.formData()) {
      fields[name] = typeof value === "string"
        ? value
        : { name: (value as File).name, type: (value as File).type, size: (value as File).size };
    }
    for (const name of ["reply_markup", "reply_parameters"]) {
      if (typeof fields[name] === "string") fields[name] = JSON.parse(fields[name]);
    }
  } else {
    Object.assign(fields, await request.json().catch(() => ({})));
  }
  const ok = (result: unknown) => Response.json({ ok: true, result });
  const message = (extra: Record<string, unknown>) => ok({
    message_id: Number(fields.message_id ?? 900), date: 1_800_000_000,
    chat: { id: Number(fields.chat_id), type: "group", title: "Family" }, from: BOT_USER,
    ...(fields.reply_markup ? { reply_markup: fields.reply_markup } : {}),
    ...extra,
  });
  switch (method) {
    case "getMe": return ok(BOT_USER);
    case "getWebhookInfo": return ok({ url: "http://localhost:8787/gatekeeper/telegram/webhook/bot" });
    case "setWebhook": return ok(true);
    case "sendMessage": return message({ text: fields.text });
    case "sendPhoto": return message({
      photo: [{ file_id: "f-thumb", file_size: 10 }, { file_id: "f-photo", file_size: fields.photo.size }],
      ...(fields.caption ? { caption: fields.caption } : {}),
    });
    case "sendDocument": return message({
      document: { file_id: "f-doc", file_name: fields.document.name, mime_type: fields.document.type, file_size: fields.document.size },
      ...(fields.caption ? { caption: fields.caption } : {}),
    });
    case "editMessageText": return message({ text: fields.text, edit_date: 1_800_000_100 });
    case "editMessageCaption": return message({ photo: [{ file_id: "f-photo" }], caption: fields.caption });
    case "editMessageReplyMarkup": return message({ text: "kept text" });
    case "deleteMessage": return ok(true);
    case "setMessageReaction":
      return fields.reaction?.[0]?.emoji === "🦖"
        ? Response.json({ ok: false, error_code: 400, description: "Bad Request: REACTION_INVALID" }, { status: 400 })
        : ok(true);
    case "getFile": return ok({
      file_path: "photos/file_1.jpg", file_size: fields.file_id === "f-huge" ? 50 * 1024 * 1024 : FILE_BYTES.byteLength,
    });
    default: return new Response("Not part of the fake", { status: 502 });
  }
}

export default defineConfig({
  plugins: [
    capnwebValidate(),
    cloudflareTest({
      main: "./__tests__/worker.ts",
      miniflare: {
        compatibilityDate: "2026-08-04",
        compatibilityFlags: ["allow_irrevocable_stub_storage", "nodejs_compat"],
        // For __tests__/hub.test.ts, which reaches the bot's hub and webhook as deployed.
        durableObjects: {
          TelegramBotHub: { className: "TelegramBotHub", useSQLite: true },
          TelegramConnect: { className: "TelegramConnect", useSQLite: true },
        },
        outboundService: fakeTelegram,
        bindings: {
          BASE_URL: "http://localhost:8787/gatekeeper/telegram",
          TELEGRAM_BOT_TOKEN: "123456789:AAEexampleexampleexampleexample123",
        },
      },
    }),
  ],
  test: { include: ["__tests__/*.test.ts"] },
});
