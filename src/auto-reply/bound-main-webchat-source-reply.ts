import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { buildAgentMainSessionKey } from "@openclaw/session-url-contract";
import { parseAgentSessionKey } from "@openclaw/session-url-contract/session-key-normalization";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeMessageChannel } from "../utils/message-channel-core.js";
import type { MsgContext } from "./templating.js";

export function canUseBoundMainWebChatSourceReply(params: {
  provider?: string;
  sessionKey?: string;
  sessionId?: string;
  mainKey?: string;
}): boolean {
  if (
    normalizeMessageChannel(params.provider) !== "webchat" ||
    !normalizeOptionalString(params.sessionId)
  ) {
    return false;
  }
  const key = normalizeOptionalString(params.sessionKey);
  const parsed = parseAgentSessionKey(key);
  return Boolean(
    parsed &&
    key === buildAgentMainSessionKey({ agentId: parsed.agentId, mainKey: params.mainKey }),
  );
}

export function mainWebChatHeartbeatContext(params: {
  cfg: Pick<OpenClawConfig, "session">;
  prepared: {
    conversationEntry?: Pick<
      SessionEntry,
      "sessionId" | "delivery" | "createdVia" | "lastReadAt" | "chatType"
    >;
    run: { kind: string };
    sessionKey: string;
    delivery: { channel: string; reason?: string };
  };
  suppressOriginatingContext: boolean;
  runSessionKey: string;
}): Pick<MsgContext, "Provider" | "Surface" | "ChatType"> {
  const { cfg, prepared, suppressOriginatingContext, runSessionKey } = params;
  const entry = prepared.conversationEntry;
  if (
    suppressOriginatingContext ||
    prepared.run.kind === "isolated" ||
    runSessionKey !== prepared.sessionKey ||
    prepared.delivery.channel !== "none" ||
    prepared.delivery.reason === "target-none" ||
    entry?.delivery?.kind !== "internal" ||
    entry.createdVia === "internal" ||
    !(entry.createdVia === "operator" || entry.lastReadAt !== undefined) ||
    !canUseBoundMainWebChatSourceReply({
      provider: "webchat",
      sessionKey: runSessionKey,
      sessionId: entry.sessionId,
      mainKey: cfg.session?.mainKey,
    })
  ) {
    return {};
  }
  // Descriptive identity only; live tool authority and transcript writers still own delivery.
  return { Provider: "webchat", Surface: "webchat", ChatType: entry.chatType ?? "direct" };
}

export function isUnroutedSourceReplySend(
  params: Record<string, unknown>,
  action: string,
  allowed: boolean | undefined,
): boolean {
  return (
    allowed === true &&
    action === "send" &&
    [
      "channel",
      "target",
      "targets",
      "to",
      "channelId",
      "provider",
      "accountId",
      "threadId",
      "replyTo",
      "gatewayUrl",
      "gatewayToken",
    ].every((key) => params[key] === undefined || params[key] === null)
  );
}
