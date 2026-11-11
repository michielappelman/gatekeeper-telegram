import { Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type { TelegramChatConfiguratorRpc } from "./telegram-chat-configurator-types";

// The all-chats resource has no inputs; the connect modal still requires a configurator for every
// SupportedResource, so this one only says what is being connected.

export default {
  initial: { confirmed: "yes" },

  isReady() {
    return true;
  },

  resourceUrl({ ui }) {
    return ui.botResourceUrl();
  },

  render() {
    return <Section>
      <Field
        label="All your Telegram chats"
        description="This connection can read and receive the messages the bot gets in every chat you link, including chats you link later, and send messages there that you approve. To limit it to one chat, connect a Telegram chat instead.">
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<TelegramChatConfiguratorRpc, { confirmed?: string }>;
