import {
  CAPNWEB_VALIDATE_BUILD, OBSERVABILITY, defineGadgetsWorker, type DurableObjectMigration,
  type WranglerExtras,
} from "@gadgets/scripts/worker-config";

export default defineGadgetsWorker({
  name: "gatekeeper-telegram",
  entrypoint: ".wrangler/validate/src/index.ts",
  compatibilityFlags: ["allow_irrevocable_stub_storage", "nodejs_compat"],
  observability: OBSERVABILITY,
});

export const wrangler = {
  build: CAPNWEB_VALIDATE_BUILD,
} satisfies WranglerExtras;

export const migrations: DurableObjectMigration[] = [
  { tag: "v0", new_sqlite_classes: ["UserAccount", "TelegramGatekeeperImpl"] },
  // The per-connection bot accounts gave way to the deployment's one bot (TELEGRAM_BOT_TOKEN).
  { tag: "v1", new_sqlite_classes: ["TelegramBotHub"], deleted_classes: ["UserAccount"] },
  // Telegram became a connector: each person connects through a TelegramConnect flow.
  { tag: "v2", new_sqlite_classes: ["TelegramConnect"] },
];
