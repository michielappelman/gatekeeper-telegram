import { Field, Autocomplete, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type {
  TelegramChatConfiguratorRpc,
  TelegramChatConfiguratorValues,
} from "./telegram-chat-configurator-types";

// Mirrors parseResourceUrl() in ../resource.ts; configurator modules are transpiled standalone and
// cannot import runtime helpers.
const CHAT_URL = /^https:\/\/t\.me\/[A-Za-z][A-Za-z0-9_]{3,31}\/chat\/(-?[1-9]\d{0,19})$/;

export default {
  initial: {},

  isReady({ values }) {
    return typeof values.chatId === "string" && values.chatId.length > 0;
  },

  initialValuesFromResourceUrl({ resourceUrl }) {
    const match = CHAT_URL.exec(resourceUrl);
    return match ? { chatId: match[1] } : {};
  },

  resourceUrl({ values, ui }) {
    return ui.chatResourceUrl(values.chatId ?? "");
  },

  render({ values, setValues, ui }) {
    return <Section>
      <Field
        label="Chat"
        description="Choose the chat this connection can read, receive and send messages in. Your private chat with the bot is there once you connect Telegram; a group once you add the bot to it (send /addgroup to the bot for a button) or send /link in it.">
        <Autocomplete
          name="chatId"
          value={values.chatId}
          placeholder="Search chats..."
          loadOptions={query => ui.listChats(query)}
          onChange={chatId => setValues({ chatId })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<TelegramChatConfiguratorRpc, TelegramChatConfiguratorValues>;
