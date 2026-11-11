/**
 * Autocomplete row a configurator RPC returns. Local so server code can import configurator types
 * without pulling `@gadgets/configurator-ui`'s global `JSX`.
 */
export type ConfiguratorOption = {
  value: string;
  title: string;
  subtitle?: string;
  meta?: string;
};

export type TelegramChatConfiguratorValues = {
  chatId?: string | null;
};

export interface TelegramChatConfiguratorRpc {
  /** Lists the user's linked chats whose title matches `query`. */
  listChats(query: string): Promise<ConfiguratorOption[]>;
  /** Returns the resource URL of one of those chats. */
  chatResourceUrl(chatId: string): Promise<string>;
  /** The URL of the resource for all the user's chats. */
  botResourceUrl(): Promise<string>;
}
