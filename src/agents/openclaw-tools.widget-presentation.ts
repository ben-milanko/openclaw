import { resolveCurrentChannelWidgetPresenter } from "../canvas/widget-tool.js";
import { resolveWidgetPresenters } from "../plugins/widget-presenters.js";
import { isCronRunSessionKey } from "../sessions/session-key-utils.js";
import { normalizeDeliveryContext } from "../utils/delivery-context.shared.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../utils/message-channel-constants.js";
import {
  isToolExplicitlyAllowedByFactoryPolicy,
  mergeFactoryPolicyList,
} from "./openclaw-tools.media-factory-plan.js";
import type { OpenClawToolsOptions } from "./openclaw-tools.types.js";

type WidgetPresentationRunOptions = Pick<
  OpenClawToolsOptions,
  | "agentSessionKey"
  | "runSessionKey"
  | "agentChannel"
  | "agentAccountId"
  | "agentTo"
  | "agentThreadId"
  | "nativeChannelId"
  | "currentChannelId"
  | "currentMessagingTarget"
  | "clientCaps"
  | "pinnedWidgetAuthoring"
  | "gatewayCallerScheduled"
  | "runtimeToolAllowlist"
  | "pluginToolDenylist"
  | "config"
>;

/** Resolves widget presenters against the trusted delivery facts prepared for this run. */
export function resolveWidgetPresentationForRun(options?: WidgetPresentationRunOptions) {
  const deliveryContext = normalizeDeliveryContext({
    channel: options?.agentChannel,
    to: options?.agentTo ?? options?.currentMessagingTarget ?? options?.currentChannelId,
    accountId: options?.agentAccountId,
    threadId: options?.agentThreadId,
  });
  const sessionKey = options?.runSessionKey ?? options?.agentSessionKey;
  const context = {
    messageChannel: options?.agentChannel,
    accountId: options?.agentAccountId,
    deliveryContext,
    nativeChannelId: options?.nativeChannelId,
    currentChannelId: options?.currentChannelId,
    currentMessagingTarget: options?.currentMessagingTarget,
    sessionKey,
  };
  const presenters = resolveWidgetPresenters().map((registration) => registration.presenter);
  const currentChannelPresenter = resolveCurrentChannelWidgetPresenter(presenters, context);
  const inlineClientAvailable = options?.clientCaps?.includes("inline-widgets") === true;
  const scheduledWidgetExplicitlyAllowed = isToolExplicitlyAllowedByFactoryPolicy({
    toolName: "show_widget",
    allowlist: options?.runtimeToolAllowlist,
    denylist: mergeFactoryPolicyList(options?.config?.tools?.deny, options?.pluginToolDenylist),
  });
  // Durable WebChat follow-ups can author their own board without inheriting
  // a browser's renderer. Scheduled turns still need an explicit tool cap.
  const durableSessionKey = sessionKey?.trim();
  const pinnedOnly =
    (options?.pinnedWidgetAuthoring === true ||
      (options?.agentChannel === INTERNAL_MESSAGE_CHANNEL &&
        options?.gatewayCallerScheduled !== true) ||
      (options?.gatewayCallerScheduled === true && scheduledWidgetExplicitlyAllowed)) &&
    !inlineClientAvailable &&
    !currentChannelPresenter &&
    Boolean(durableSessionKey) &&
    !isCronRunSessionKey(durableSessionKey);
  return {
    context,
    deliveryContext,
    presenters,
    currentChannelPresenter,
    inlineClientAvailable,
    pinnedOnly,
  };
}
