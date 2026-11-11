declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("./index.js");
    durableNamespaces: "TelegramBotHub" | "TelegramGatekeeperImpl";
  }
}
