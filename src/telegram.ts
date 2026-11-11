import { DurableObject, RpcStub, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import type {
  AccountDescription,
  ActionKind,
  ApprovalQueue,
  Gatekeeper,
  GatekeeperConnectCallback,
  GatekeeperUser,
  GatekeeperUserVerifier,
  GatekeeperVendor as GatekeeperVendorIface,
  HookController,
  HookInitiator,
  HookTargetMetadata,
  ObservationDescription,
  ResourceConfiguratorFrame,
  ResourceDescription,
  SupportedResource,
  VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { observerAccessVerifier } from "@gadgets/gatekeeper-kit/observers";
import { createLogger } from "@gadgets/observability/logger";
import {
  chatKind,
  deleteBlob,
  describeAction,
  familyOf,
  groupKind,
  pendingActionId,
  pendingId,
  pendingMessage,
  readBlob,
  RULE_FAMILIES,
  selfKind,
  sha256Hex,
  storeBlob,
  withPendingChanges,
  type NewAction,
  type PendingAction,
} from "./actions";
import { handleConnect, startConnect, TelegramConnect } from "./connect";
import { TelegramBotHub, type HubEnv, type TelegramHookTarget } from "./hub";
import {
  accountSubresource,
  BOT_RESOURCE,
  botResourceUrl,
  CHAT_RESOURCE,
  chatResourceUrl,
  chatSubresource,
  parseResourceUrl,
  parseSubresource,
  SUPPORTED_RESOURCES,
} from "./resource";
import {
  isChatId,
  isMessageId,
  TelegramError,
  validateButtons,
  validateCaption,
  validateOptions,
  normalizeReaction,
  validateSend,
  validateUpload,
  type SendOptions,
  type WireUpdate,
} from "./telegram-api";
import type {
  TelegramBot,
  TelegramBotInfo,
  TelegramButton,
  TelegramChat,
  TelegramChatInfo,
  TelegramFileContent,
  TelegramMessage,
  TelegramMessageHandle,
  TelegramMessagePage,
  TelegramSendOptions,
  TelegramUpload,
} from "./types";
import TYPES_CODE from "./types.txt";
import type {
  ConfiguratorOption,
  TelegramChatConfiguratorRpc,
} from "./configurator/telegram-chat-configurator-types";
import CHAT_CONFIGURATOR_HTML from "./generated/telegram-chat-configurator-ui.txt";
import BOT_CONFIGURATOR_HTML from "./generated/telegram-bot-configurator-ui.txt";

export { TelegramBotHub, TelegramConnect };
export { describeSend, groupSendKind } from "./actions";

const logger = createLogger<{ vendorId: string; code: string; actionId: number }>({
  component: "gatekeeper.telegram", vendorId: "telegram",
});

type Env = HubEnv;

function errorCode(error: unknown): string | undefined {
  return error instanceof TelegramError ? error.code : undefined;
}

function hub(exports: Cloudflare.Exports): DurableObjectStub<TelegramBotHub> {
  return exports.TelegramBotHub.getByName("bot");
}

// Telegram's paper plane on its blue disc, inlined so the gatekeeper needs no hosted asset.
const TELEGRAM_LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">\
<circle cx="12" cy="12" r="11" fill="#2aabee"/>\
<path d="M5.4 11.7l11.3-4.4c.5-.2 1 .1.8.9l-1.9 9c-.1.6-.5.8-1 .5l-2.9-2.1-1.4 1.3c-.2.2-.3.3-.6.3\
l.2-3 5.5-5c.2-.2 0-.3-.3-.1l-6.8 4.3-2.9-.9c-.6-.2-.6-.6.1-.9z" fill="#fff"/>\
</svg>`;
const TELEGRAM_LOGO = { url: `data:image/svg+xml;utf8,${encodeURIComponent(TELEGRAM_LOGO_SVG)}` };

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
/** Largest webhook body accepted; one update is a few kilobytes. */
const MAX_UPDATE_BYTES = 1024 * 1024;

// Every read authorizes through this, so none can omit what it disclosed (the shared type still
// makes `subresources` optional).
function authorize(
    queue: Pick<RpcStub<ApprovalQueue>, "authorizeObservation">,
    description: ObservationDescription & { subresources: string[] }): Promise<void> {
  return queue.authorizeObservation(description);
}

function baseUrl(env: Env): string {
  return (env.BASE_URL ?? "http://localhost:8787/gatekeeper/telegram").replace(/\/+$/, "");
}

// ---------------------------------------------------------------------------
// fetch handler: Telegram's webhook deliveries (under webhook/, which Access bypasses), and the
// connect page (behind Access, like the rest of Cloudflare OS).

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const basePath = new URL(baseUrl(env)).pathname.replace(/^\/$/, "");
    if (!url.pathname.startsWith(`${basePath}/`)) return new Response("Not Found", { status: 404 });
    const segments = url.pathname.slice(basePath.length + 1).split("/");
    if (segments[0] === "connect") return handleConnect(req, segments.slice(1), ctx.exports);
    if (segments.length !== 2 || segments[0] !== "webhook" || segments[1] !== "bot") {
      return new Response("Not Found", { status: 404 });
    }
    if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
    // Telegram proves a delivery with the secret it was given in setWebhook.
    const secret = req.headers.get("X-Telegram-Bot-Api-Secret-Token");
    if (!secret) return new Response("Unauthorized", { status: 401 });
    if (Number(req.headers.get("Content-Length") ?? "0") > MAX_UPDATE_BYTES) {
      return new Response("Payload Too Large", { status: 413 });
    }
    let update: WireUpdate;
    try {
      update = await req.json();
    } catch {
      return new Response("Bad Request", { status: 400 });
    }
    const { accepted, reply } = await hub(ctx.exports).receiveUpdate(secret, update);
    if (!accepted) return new Response("Unauthorized", { status: 401 });
    // Telegram performs a method call given as the response, which saves a round trip.
    if (reply && "answerPress" in reply) {
      return Response.json({ method: "answerCallbackQuery", callback_query_id: reply.answerPress });
    }
    if (reply) {
      return Response.json({
        method: "sendMessage",
        chat_id: reply.chatId,
        text: reply.text,
        ...(reply.button ? { reply_markup: { inline_keyboard: [[reply.button]] } } : {}),
      });
    }
    return new Response("OK");
  },
};

// ---------------------------------------------------------------------------
// Vendor -- each person connects their own Telegram to the family's one bot; a connection is an id
// the bot's hub keys that person's chats by.

@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Env> implements GatekeeperVendorIface {
  async describe(): Promise<VendorDescription> {
    return {
      displayName: "Telegram",
      url: "https://telegram.org",
      logo: TELEGRAM_LOGO,
      color: "#e3f4fd",
      tagline: "Message your agents through the family Telegram bot",
      description:
          "Connect your Telegram to the family bot, then choose which of your chats with it each " +
          "gadget may read, receive and send messages in: your private chat, or groups you add " +
          "the bot to.",
      providesAuth: false,
    };
  }

  async connectAccount(callback: Fetcher<GatekeeperConnectCallback>, _options?: object): Promise<{ url: string }> {
    return { url: await startConnect(this.ctx.exports, baseUrl(this.env), callback) };
  }

  async getSupportedResources(_options?: { userId?: string }): Promise<SupportedResource[]> {
    return SUPPORTED_RESOURCES;
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }
}

// ---------------------------------------------------------------------------
// Account -- one connected Telegram user. Its resources are that person's chats with the bot.

type AccountProps = { accountId: string };

@validateRpc()
export class TelegramAccount extends WorkerEntrypoint<Env, AccountProps> implements GatekeeperUser {
  async describe(): Promise<AccountDescription> {
    const person = await hub(this.ctx.exports).linkedPerson(this.ctx.props.accountId).catch(() => null);
    return {
      displayName: person?.title ?? "Telegram",
      ...(person?.username ? { uniqueName: `@${person.username}` } : {}),
      avatar: TELEGRAM_LOGO,
    };
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return SUPPORTED_RESOURCES;
  }

  async getGatekeeperClassFor(url: string): Promise<{
    class: DurableObjectClass<Gatekeeper<any>>;
    resource: SupportedResource;
  }> {
    const { chatId } = parseResourceUrl(url);
    const { accountId } = this.ctx.props;
    if (chatId === undefined) {
      const props: TelegramGatekeeperImplProps = { accountId };
      return { class: this.ctx.exports.TelegramGatekeeperImpl({ props }), resource: BOT_RESOURCE };
    }
    if (!await hub(this.ctx.exports).getChat(accountId, chatId)) {
      throw new TelegramError("BAD_REQUEST", "That Telegram chat isn't linked to you.");
    }
    const props: TelegramGatekeeperImplProps = { accountId, chatId };
    return { class: this.ctx.exports.TelegramGatekeeperImpl({ props }), resource: CHAT_RESOURCE };
  }

  async startResourceConfigurator(resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    const ui = new RpcStub(new TelegramChatConfiguratorUI(hub(this.ctx.exports), this.ctx.props.accountId));
    if (resourceUrlPattern === CHAT_RESOURCE.urlPattern) return { iframeHtml: CHAT_CONFIGURATOR_HTML, ui };
    if (resourceUrlPattern === BOT_RESOURCE.urlPattern) return { iframeHtml: BOT_CONFIGURATOR_HTML, ui };
    throw new Error(`Unsupported Telegram resource configurator type: ${resourceUrlPattern}`);
  }

  async ensureResources(_resourceUrlPatterns: string[]): Promise<{ url?: string }> {
    return {};
  }

  /** Forgets the user's links, chats and hooks. */
  async revoke(): Promise<void> {
    await hub(this.ctx.exports).forgetAccount(this.ctx.props.accountId);
  }

  reconnect(): Promise<{ url: string }> {
    throw new Error("Telegram has no connect flow.");
  }

  commitReconnect(_stageId: string): Promise<void> {
    throw new Error("Telegram has no connect flow.");
  }

  async getAuthenticatedEmail(): Promise<string | null> {
    return null;
  }

  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    return this.ctx.exports.TelegramVerifier({ props: { accountId: this.ctx.props.accountId } });
  }
}

// ---------------------------------------------------------------------------
// Verifier -- names the observer's account. A chat's messages are its owner's alone, so a
// collaborator passes only for chats linked to their own account.

/** The verifier's vendor-specific method, which TelegramGatekeeperImpl.verifyObserverAccess calls. */
export interface TelegramVerifierApi extends GatekeeperUserVerifier {
  accountId(): Promise<string>;
}

@validateRpc()
export class TelegramVerifier extends WorkerEntrypoint<Env, AccountProps> implements TelegramVerifierApi {
  async accountId(): Promise<string> {
    return this.ctx.props.accountId;
  }
}

// ---------------------------------------------------------------------------
// Chat configurator -- lists the user's own chats for a gadget binding

@validateRpc()
export class TelegramChatConfiguratorUI extends RpcTarget implements TelegramChatConfiguratorRpc {
  readonly #hub: DurableObjectStub<TelegramBotHub>;
  readonly #accountId: string;

  constructor(hubStub: DurableObjectStub<TelegramBotHub>, accountId: string) {
    super();
    this.#hub = hubStub;
    this.#accountId = accountId;
  }

  async listChats(query: string): Promise<ConfiguratorOption[]> {
    const chats = await this.#hub.listChats(this.#accountId, query.slice(0, 200));
    return chats.slice(0, 50).map(chat => ({
      value: chat.id,
      title: chat.title,
      subtitle: chat.username ? `@${chat.username}` : undefined,
      meta: chat.type === "private" ? "private chat" : chat.type,
    }));
  }

  async chatResourceUrl(chatId: string): Promise<string> {
    if (!isChatId(chatId) || !await this.#hub.getChat(this.#accountId, chatId)) {
      throw new Error("Choose one of your linked chats.");
    }
    return chatResourceUrl((await this.#hub.getBot()).username, chatId);
  }

  async botResourceUrl(): Promise<string> {
    return botResourceUrl((await this.#hub.getBot()).username);
  }
}

// ---------------------------------------------------------------------------
// Hook controller -- a loopback the overseer enables and disables; the hub holds enabled hooks.

type TelegramHookProps = { key: string; accountId: string; chatId?: string };

@validateRpc()
export class TelegramHookController extends WorkerEntrypoint<Env, TelegramHookProps>
    implements HookController<TelegramHookTarget> {
  async enable(initiator: Fetcher<HookInitiator<TelegramHookTarget>>,
               _target: HookTargetMetadata): Promise<void> {
    const { key, accountId, chatId } = this.ctx.props;
    await hub(this.ctx.exports).registerHook(
      key, { accountId, ...(chatId !== undefined ? { chatId } : {}) }, initiator);
  }

  async disable(): Promise<void> {
    await hub(this.ctx.exports).unregisterHook(this.ctx.props.key);
  }
}

// ---------------------------------------------------------------------------
// GatekeeperImpl DO -- the user's ambient bot, or one chat a gadget is bound to

type TelegramGatekeeperImplProps = {
  /** The Workshop account every read is scoped to. */
  accountId: string;
  /** Present for a one-chat binding. */
  chatId?: string;
};

/** Queued actions are kept under this prefix, which predates there being any but sends. */
const actionKey = (actionId: number) => `send:${actionId}`;
const ACTION_PREFIX = "send:";

/** Where the real id of a message is kept once its send was carried out. */
const sentKey = (actionId: number) => `sent:${actionId}`;
/** Sent-message ids remembered, so a handle from before approval keeps working for a while. */
const SENT_IDS_KEPT = 200;

/** What the sessions need of their binding, kept off the RPC surface. */
export type Binding = {
  props: TelegramGatekeeperImplProps;
  hub: DurableObjectStub<TelegramBotHub>;
  /**
   * Queues an action for approval and returns its id. `bytes` is the file of a `media` action,
   * kept here until the action is decided.
   */
  queue(action: NewAction, chatTitle: string, approvalQueue: RpcStub<ApprovalQueue>,
        bytes?: Uint8Array): Promise<number>;
  /** The chat's queued actions, oldest first. */
  pending(chatId: string): { actionId: number; action: PendingAction }[];
  /** The id of the message a carried-out send became, while it is remembered. */
  sentMessageId(actionId: number): string | undefined;
  hookController(chatId?: string): Fetcher<HookController<TelegramHookTarget>>;
};

@validateRpc()
export class TelegramGatekeeperImpl extends DurableObject<Env, TelegramGatekeeperImplProps>
    implements Gatekeeper<TelegramBot | TelegramChat> {
  async describe(): Promise<ResourceDescription> {
    const { accountId, chatId } = this.ctx.props;
    const bot = await hub(this.ctx.exports).getBot()
      .catch((): TelegramBotInfo => ({ id: "", username: "telegram", name: "Telegram bot" }));
    if (chatId === undefined) {
      return {
        url: botResourceUrl(bot.username),
        title: `Telegram (@${bot.username})`,
        snippet: "All your linked Telegram chats: read, receive and send messages.",
        suggestedBindingName: "TELEGRAM_BOT",
        tsType: "TelegramBot",
        hookTsType: "TelegramMessageHook",
      };
    }
    const chat = await hub(this.ctx.exports).getChat(accountId, chatId).catch(() => null);
    return {
      url: chatResourceUrl(bot.username, chatId),
      title: `${chat?.title ?? `Chat ${chatId}`} (Telegram)`,
      snippet: "One Telegram chat: read, receive and send messages.",
      suggestedBindingName: "TELEGRAM_CHAT",
      tsType: "TelegramChat",
      hookTsType: "TelegramMessageHook",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  /** A one-chat binding sends to its chat; the user's bot to them, and to each linked group. */
  async getAutoApprovableActions(): Promise<ActionKind[]> {
    const { accountId, chatId } = this.ctx.props;
    if (chatId !== undefined) return RULE_FAMILIES.map(chatKind);
    const groups = (await hub(this.ctx.exports).listChats(accountId)).filter(chat => chat.type !== "private");
    return [
      ...RULE_FAMILIES.map(selfKind),
      ...groups.flatMap(group => RULE_FAMILIES.map(family => groupKind(family, group))),
    ];
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<TelegramBot | TelegramChat> {
    const binding = this.#binding();
    const { chatId } = this.ctx.props;
    return chatId === undefined
      ? new TelegramBotSessionImpl(approvalQueue.dup(), binding)
      : new TelegramChatSessionImpl(approvalQueue.dup(), binding, chatId);
  }

  #binding(): Binding {
    const ctx = this.ctx;
    const props = ctx.props;
    const hubStub = hub(ctx.exports);
    return {
      props,
      hub: hubStub,
      async queue(action, chatTitle, approvalQueue, bytes) {
        const actionId = ctx.storage.kv.get<number>("nextActionId") ?? 1;
        ctx.storage.kv.put("nextActionId", actionId + 1);
        const stored = { ...action, submittedAt: Date.now() } as PendingAction;
        if (stored.type === "media") {
          if (!bytes) throw new Error("A picture or file needs its content.");
          stored.file = { ...stored.file, chunks: storeBlob(ctx.storage.kv, actionId, bytes) };
        }
        ctx.storage.kv.put<PendingAction>(actionKey(actionId), stored);
        try {
          const bot = await hubStub.getBot();
          const family = familyOf(action);
          // A one-chat binding acts in its own chat; the user's bot acts in their own private chat
          // under one rule, and in each group under that group's own.
          const kind = family === undefined
            ? undefined
            : props.chatId !== undefined || await hubStub.isOwnPrivateChat(props.accountId, action.chatId)
              ? chatKind(family)
              : groupKind(family, { id: action.chatId, title: chatTitle });
          const target = "messageId" in action
            ? await hubStub.getMessage(props.accountId, action.chatId, action.messageId) ?? undefined
            : undefined;
          await approvalQueue.submitAction(actionId, describeAction(stored, {
            chatTitle, botUsername: bot.username, kind, ...(target ? { target } : {}),
          }));
        } catch (error) {
          // Unless it was already carried out: an enabled rule can apply it before this returns.
          if (ctx.storage.kv.get(actionKey(actionId)) !== undefined) {
            ctx.storage.kv.delete(actionKey(actionId));
            if (stored.type === "media") deleteBlob(ctx.storage.kv, actionId, stored.file.chunks);
          }
          throw error;
        }
        return actionId;
      },
      pending(chatId) {
        const queued: { actionId: number; action: PendingAction }[] = [];
        for (const [key, action] of ctx.storage.kv.list<PendingAction>({ prefix: ACTION_PREFIX })) {
          if (action.chatId === chatId) queued.push({ actionId: Number(key.slice(ACTION_PREFIX.length)), action });
        }
        return queued.toSorted((a, b) => a.actionId - b.actionId);
      },
      sentMessageId(actionId) {
        return ctx.storage.kv.get<string>(sentKey(actionId));
      },
      hookController(chatId) {
        return ctx.exports.TelegramHookController({
          props: {
            key: crypto.randomUUID(),
            accountId: props.accountId,
            ...(chatId !== undefined ? { chatId } : {}),
          },
        });
      },
    };
  }

  async applyAction(actionId: number): Promise<void> {
    const kv = this.ctx.storage.kv;
    const action = kv.get<PendingAction>(actionKey(actionId));
    if (!action) throw new Error(`No Telegram action is waiting as action ${actionId}.`);
    const hubStub = hub(this.ctx.exports);
    const { accountId } = this.ctx.props;
    const { chatId } = action;
    try {
      switch (action.type) {
        case undefined:
        case "text": {
          const sent = await hubStub.send(accountId, chatId, action.text, action.options);
          this.#rememberSent(actionId, sent.id);
          break;
        }
        case "media": {
          const bytes = readBlob(kv, actionId, action.file);
          if (!bytes) throw new TelegramError("BAD_REQUEST", "The file kept for this send is gone; send it again.");
          const sent = await hubStub.sendMedia(accountId, chatId, action.media, {
            bytes, filename: action.file.filename, mediaType: action.file.mediaType,
          }, { ...action.options, ...(action.caption ? { caption: action.caption } : {}) });
          this.#rememberSent(actionId, sent.id);
          break;
        }
        case "edit":
          await hubStub.editMessage(accountId, chatId, action.messageId, action.text, action.options);
          break;
        case "buttons":
          await hubStub.setButtons(accountId, chatId, action.messageId, action.buttons);
          break;
        case "delete":
          await hubStub.deleteMessage(accountId, chatId, action.messageId);
          break;
        case "react":
          await hubStub.react(accountId, chatId, action.messageId, action.emoji);
          break;
      }
    } catch (error) {
      logger.warn("could not carry out a Telegram action", {
        event: "telegram.action.failed", code: errorCode(error), actionId, error,
      });
      throw error;
    }
    this.#forget(actionId, action);
  }

  /** Drops a decided action and the file kept for it. */
  #forget(actionId: number, action: PendingAction): void {
    this.ctx.storage.kv.delete(actionKey(actionId));
    if (action.type === "media") deleteBlob(this.ctx.storage.kv, actionId, action.file.chunks);
  }

  /** Keeps what a send became, so the handle its caller holds finds the real message. */
  #rememberSent(actionId: number, messageId: string): void {
    const kv = this.ctx.storage.kv;
    kv.put(sentKey(actionId), messageId);
    kv.delete(sentKey(actionId - SENT_IDS_KEPT));
  }

  async rejectAction(actionId: number): Promise<void> {
    const action = this.ctx.storage.kv.get<PendingAction>(actionKey(actionId));
    if (action) this.#forget(actionId, action);
  }

  async revertAction(_actionId: number): Promise<{ message: string; canRetry: boolean }> {
    return {
      message: "This can't be taken back from here. A message the bot sent can be edited or deleted instead.",
      canRetry: false,
    };
  }

  readonly #verifyObserverAccess = observerAccessVerifier({
    hasCollectionAccess: async (verifier: Fetcher<TelegramVerifierApi>, subresources) => {
      const observer = await verifier.accountId();
      const hubStub = hub(this.ctx.exports);
      return Promise.all(subresources.map(async id => {
        const reported = parseSubresource(id)!;
        return reported.kind === "account"
          ? reported.accountId === observer
          : await hubStub.chatOwner(reported.chatId) === observer;
      }));
    },
  });

  async verifyObserverAccess(
      observers: { id: string; verifier: Fetcher<GatekeeperUserVerifier> }[],
      subresources: string[]): Promise<{ allowedObserverIds: string[] }> {
    // Refuse an ID this binding never reports rather than guessing what it names.
    if (!subresources.every(id => isReportedBy(this.ctx.props, id))) {
      throw new Error("This Telegram connection was asked about a resource it never reported.");
    }
    return this.#verifyObserverAccess(observers, subresources);
  }

  // Required, though the current Gatekeeper interface does not declare it. A new gatekeeper
  // observed nothing under the legacy observer protocol, so the export is empty and reads no state.
  async getHistoricalSubresources(): Promise<string[]> {
    return [];
  }

  // Compatibility only: every read reports what it disclosed, checked in verifyObserverAccess().
  async addObserver(_id: string, _verifier: Fetcher<GatekeeperUserVerifier>): Promise<void> {}

  async removeObserver(_id: string): Promise<void> {}
}

/**
 * Whether a binding reports `id`: the user's bot reports their account (the chat list) and any of
 * their chats; a one-chat binding that chat alone.
 */
export function isReportedBy(props: TelegramGatekeeperImplProps, id: string): boolean {
  const reported = parseSubresource(id);
  if (!reported) return false;
  if (props.chatId !== undefined) return reported.kind === "chat" && reported.chatId === props.chatId;
  return reported.kind === "chat" || reported.accountId === props.accountId;
}

// ---------------------------------------------------------------------------
// Sessions -- the RPC interfaces exposed to agents and gadgets

@validateRpc()
export class TelegramBotSessionImpl extends RpcTarget implements TelegramBot {
  readonly #approvalQueue: RpcStub<ApprovalQueue>;
  readonly #binding: Binding;

  constructor(approvalQueue: RpcStub<ApprovalQueue>, binding: Binding) {
    super();
    this.#approvalQueue = approvalQueue;
    this.#binding = binding;
  }

  [Symbol.dispose]() {
    this.#approvalQueue[Symbol.dispose]();
  }

  async getInfo(): Promise<TelegramBotInfo> {
    const bot = await this.#binding.hub.getBot();
    // The bot's public identity: anyone can look it up in Telegram.
    await authorize(this.#approvalQueue, {
      title: "Read Telegram bot info",
      description: `Read the identity of @${bot.username}.`,
      subresources: [],
    });
    return bot;
  }

  async listChats(): Promise<TelegramChatInfo[]> {
    const chats = await this.#binding.hub.listChats(this.#binding.props.accountId);
    await authorize(this.#approvalQueue, {
      title: "Listed Telegram chats",
      description: `Listed your ${chats.length} linked Telegram chat(s).`,
      subresources: [accountSubresource(this.#binding.props.accountId)],
    });
    return chats;
  }

  getChat(chatId: string): TelegramChat {
    if (!isChatId(chatId)) throw new TelegramError("BAD_REQUEST", `"${chatId}" is not a Telegram chat id.`);
    return new TelegramChatSessionImpl(this.#approvalQueue.dup(), this.#binding, chatId);
  }

  async subscribe(callback: RpcStub<TelegramHookTarget>): Promise<void> {
    // @ts-expect-error Worker RPC's mapped types can't relate the controller's Fetcher to itself.
    await this.#approvalQueue.bindHook(this.#binding.hookController(), callback, {
      title: "Receive your Telegram messages",
      description: "Deliver every message the bot receives in your linked Telegram chats, every " +
        "press of a button under its messages there, and reactions to messages there.",
    });
  }
}

@validateRpc()
export class TelegramChatSessionImpl extends RpcTarget implements TelegramChat {
  readonly #approvalQueue: RpcStub<ApprovalQueue>;
  readonly #binding: Binding;
  readonly #chatId: string;

  constructor(approvalQueue: RpcStub<ApprovalQueue>, binding: Binding, chatId: string) {
    super();
    this.#approvalQueue = approvalQueue;
    this.#binding = binding;
    this.#chatId = chatId;
  }

  [Symbol.dispose]() {
    this.#approvalQueue[Symbol.dispose]();
  }

  async #chat(): Promise<TelegramChatInfo> {
    const chat = await this.#binding.hub.getChat(this.#binding.props.accountId, this.#chatId);
    if (!chat) {
      throw new TelegramError("BAD_REQUEST", `Telegram chat ${this.#chatId} isn't linked to you.`);
    }
    return chat;
  }

  #subresource(): string {
    return chatSubresource(this.#chatId);
  }

  async getInfo(): Promise<TelegramChatInfo> {
    const chat = await this.#chat();
    await authorize(this.#approvalQueue, {
      title: "Read Telegram chat info",
      description: `Read what ${chat.title} is.`,
      subresources: [this.#subresource()],
    });
    return chat;
  }

  async listMessages(options?: { limit?: number; cursor?: string }): Promise<TelegramMessagePage> {
    const limit = options?.limit ?? DEFAULT_PAGE_SIZE;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
      throw new TelegramError("BAD_REQUEST", `limit must be a whole number from 1 to ${MAX_PAGE_SIZE}.`);
    }
    let beforeId: number | null = null;
    if (options?.cursor !== undefined) {
      if (!/^[1-9]\d{0,15}$/.test(options.cursor)) {
        throw new TelegramError("BAD_REQUEST", "That cursor didn't come from listMessages().");
      }
      beforeId = Number(options.cursor);
    }
    const chat = await this.#chat();
    const page = await this.#binding.hub.listMessages(this.#binding.props.accountId, this.#chatId, beforeId, limit);
    const pending = this.#binding.pending(this.#chatId);
    // Messages waiting to be sent read as the newest ones, newest first; queued edits and
    // deletions already show.
    const waiting = beforeId === null
      ? pending.map(({ actionId, action }) => pendingMessage(actionId, action))
        .filter(message => message !== undefined).toReversed()
      : [];
    const messages = [...waiting, ...withPendingChanges(page.messages, pending.map(entry => entry.action))];
    await authorize(this.#approvalQueue, {
      title: "Read Telegram messages",
      description: `Read ${messages.length} message(s) from ${chat.title}.`,
      fields: [{ label: "Chat", kind: "inline", value: chat.title }],
      subresources: [this.#subresource()],
    });
    const last = page.messages.at(-1);
    return { messages, ...(page.more && last ? { nextCursor: last.id } : {}) };
  }

  #handle(messageId: string): TelegramMessageHandle {
    return new TelegramMessageHandleImpl(this.#approvalQueue.dup(), this.#binding, this.#chatId, messageId);
  }

  async sendMessage(text: string, options?: TelegramSendOptions): Promise<TelegramMessageHandle> {
    const sendOptions = sendOptionsOf(options);
    validateSend(text, sendOptions);
    const chat = await this.#chat();
    await requirePressListener(this.#binding, this.#chatId, sendOptions.buttons);
    const actionId = await this.#binding.queue(
      { type: "text", chatId: this.#chatId, text, options: sendOptions }, chat.title, this.#approvalQueue);
    return this.#handle(pendingId(actionId));
  }

  async sendPhoto(photo: TelegramUpload, options?: TelegramSendOptions & { caption?: string })
      : Promise<TelegramMessageHandle> {
    return this.#sendMedia("photo", photo, options);
  }

  async sendFile(file: TelegramUpload, options?: TelegramSendOptions & { caption?: string })
      : Promise<TelegramMessageHandle> {
    return this.#sendMedia("document", file, options);
  }

  async #sendMedia(
      media: "photo" | "document", upload: TelegramUpload,
      options?: TelegramSendOptions & { caption?: string }): Promise<TelegramMessageHandle> {
    const sendOptions = sendOptionsOf(options);
    validateOptions(sendOptions);
    validateCaption(options?.caption);
    const file = validateUpload(upload, media);
    const chat = await this.#chat();
    await requirePressListener(this.#binding, this.#chatId, sendOptions.buttons);
    const actionId = await this.#binding.queue({
      type: "media", chatId: this.#chatId, media,
      file: {
        filename: file.filename, mediaType: file.mediaType, size: file.bytes.byteLength,
        sha256: await sha256Hex(file.bytes), chunks: 0,
      },
      ...(options?.caption ? { caption: options.caption } : {}),
      options: sendOptions,
    }, chat.title, this.#approvalQueue, file.bytes);
    return this.#handle(pendingId(actionId));
  }

  getMessage(messageId: string): TelegramMessageHandle {
    if (!isMessageId(messageId) && pendingActionId(messageId) === undefined) {
      throw new TelegramError("BAD_REQUEST", `"${messageId}" is not a message id.`);
    }
    return this.#handle(messageId);
  }

  async subscribe(callback: RpcStub<TelegramHookTarget>): Promise<void> {
    const chat = await this.#chat();
    // @ts-expect-error Worker RPC's mapped types can't relate the controller's Fetcher to itself.
    await this.#approvalQueue.bindHook(this.#binding.hookController(this.#chatId), callback, {
      title: `Receive Telegram messages in ${chat.title}`,
      description: `Deliver every message the bot receives in ${chat.title}, every press of a ` +
        "button under its messages there, and reactions to messages there.",
    });
  }
}

/**
 * Refuses buttons that report presses when no enabled hook would hear them: such a button looks
 * like it works and does nothing, which the person pressing it cannot tell from a broken gadget.
 */
async function requirePressListener(binding: Binding, chatId: string, buttons?: TelegramButton[][]): Promise<void> {
  if (!buttons?.some(row => row.some(button => "data" in button))) return;
  if (await binding.hub.listensForPresses(binding.props.accountId, chatId)) return;
  throw new TelegramError("BAD_REQUEST",
    'Nothing is listening for button presses in this chat, so a "data" button would do nothing. ' +
    "First call subscribe() with a persistent callback that implements receiveButtonPress(), and " +
    "ask the user to enable that hook; then send the buttons. A \"url\" button needs no listener.");
}

/** The send options an agent gave, without keys it left undefined. */
function sendOptionsOf(options: TelegramSendOptions | undefined): SendOptions {
  return {
    ...(options?.replyTo !== undefined ? { replyTo: options.replyTo } : {}),
    ...(options?.format !== undefined ? { format: options.format } : {}),
    ...(options?.buttons?.length ? { buttons: options.buttons } : {}),
  };
}

@validateRpc()
export class TelegramMessageHandleImpl extends RpcTarget implements TelegramMessageHandle {
  readonly #approvalQueue: RpcStub<ApprovalQueue>;
  readonly #binding: Binding;
  readonly #chatId: string;
  /** A message id, or the pending id of a send this handle came from. */
  readonly #id: string;

  constructor(approvalQueue: RpcStub<ApprovalQueue>, binding: Binding, chatId: string, id: string) {
    super();
    this.#approvalQueue = approvalQueue;
    this.#binding = binding;
    this.#chatId = chatId;
    this.#id = id;
  }

  [Symbol.dispose]() {
    this.#approvalQueue[Symbol.dispose]();
  }

  async #chat(): Promise<TelegramChatInfo> {
    const chat = await this.#binding.hub.getChat(this.#binding.props.accountId, this.#chatId);
    if (!chat) throw new TelegramError("BAD_REQUEST", `Telegram chat ${this.#chatId} isn't linked to you.`);
    return chat;
  }

  /** The id Telegram knows the message by, or `undefined` while its send still waits. */
  #sentId(): string | undefined {
    const actionId = pendingActionId(this.#id);
    return actionId === undefined ? this.#id : this.#binding.sentMessageId(actionId);
  }

  /** As `#sentId()`, for what can only be done to a message Telegram has. */
  #requireSent(): string {
    const id = this.#sentId();
    if (id === undefined) throw new TelegramError("BAD_REQUEST", "That message has not been sent yet.");
    return id;
  }

  /** The message as it reads now, queued changes included; nothing is authorized here. */
  async #read(): Promise<TelegramMessage> {
    const pending = this.#binding.pending(this.#chatId);
    const sentId = this.#sentId();
    if (sentId === undefined) {
      const actionId = pendingActionId(this.#id)!;
      const queued = pending.find(entry => entry.actionId === actionId);
      const message = queued && pendingMessage(actionId, queued.action);
      if (!message) throw new TelegramError("BAD_REQUEST", "That message was not sent.");
      return message;
    }
    const message = await this.#binding.hub.getMessage(this.#binding.props.accountId, this.#chatId, sentId);
    const [shown] = message ? withPendingChanges([message], pending.map(entry => entry.action)) : [];
    if (!shown) throw new TelegramError("BAD_REQUEST", `Message ${sentId} is no longer kept for this chat.`);
    return shown;
  }

  /** One of the bot's own sent messages, which is all that can be changed or deleted. */
  async #ownSent(): Promise<string> {
    const id = this.#requireSent();
    const message = await this.#read();
    if (!message.fromBot) {
      throw new TelegramError("FORBIDDEN", "Only the bot's own messages can be changed or deleted.");
    }
    return id;
  }

  async get(): Promise<TelegramMessage> {
    const chat = await this.#chat();
    const message = await this.#read();
    await authorize(this.#approvalQueue, {
      title: "Read a Telegram message",
      description: `Read one message from ${chat.title}.`,
      fields: [{ label: "Chat", kind: "inline", value: chat.title }],
      subresources: [chatSubresource(this.#chatId)],
    });
    return message;
  }

  async readFile(): Promise<TelegramFileContent> {
    const chat = await this.#chat();
    const id = this.#requireSent();
    const file = await this.#binding.hub.readFile(this.#binding.props.accountId, this.#chatId, id);
    await authorize(this.#approvalQueue, {
      title: "Read a Telegram attachment",
      description: `Read the picture or file a message in ${chat.title} carries.`,
      fields: [
        { label: "Chat", kind: "inline", value: chat.title },
        { label: "File", kind: "inline", value: file.filename ?? file.mediaType ?? "unnamed" },
      ],
      subresources: [chatSubresource(this.#chatId)],
    });
    return file;
  }

  async edit(text: string, options?: { format?: "plain" | "markdown"; buttons?: TelegramButton[][] }): Promise<void> {
    const editOptions = {
      ...(options?.format !== undefined ? { format: options.format } : {}),
      ...(options?.buttons?.length ? { buttons: options.buttons } : {}),
    };
    validateOptions(editOptions);
    const chat = await this.#chat();
    const messageId = await this.#ownSent();
    const current = await this.#read();
    // A caption may be emptied and is shorter than a message; a message needs some text.
    if (current.attachment !== undefined) validateCaption(text);
    else validateSend(text, editOptions);
    await requirePressListener(this.#binding, this.#chatId, editOptions.buttons);
    await this.#binding.queue(
      { type: "edit", chatId: this.#chatId, messageId, text, options: editOptions }, chat.title, this.#approvalQueue);
  }

  async setButtons(buttons: TelegramButton[][]): Promise<void> {
    validateButtons(buttons);
    const chat = await this.#chat();
    const messageId = await this.#ownSent();
    await requirePressListener(this.#binding, this.#chatId, buttons);
    await this.#binding.queue(
      { type: "buttons", chatId: this.#chatId, messageId, buttons }, chat.title, this.#approvalQueue);
  }

  async delete(): Promise<void> {
    const chat = await this.#chat();
    const messageId = await this.#ownSent();
    await this.#binding.queue({ type: "delete", chatId: this.#chatId, messageId }, chat.title, this.#approvalQueue);
  }

  async react(emoji: string | null): Promise<void> {
    const reaction = normalizeReaction(emoji);
    const chat = await this.#chat();
    const messageId = this.#requireSent();
    await this.#binding.queue(
      { type: "react", chatId: this.#chatId, messageId, emoji: reaction }, chat.title, this.#approvalQueue);
  }
}
