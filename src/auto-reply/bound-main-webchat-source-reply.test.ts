import { describe, expect, it } from "vitest";
import {
  canUseBoundMainWebChatSourceReply,
  isUnroutedSourceReplySend,
  mainWebChatHeartbeatContext,
} from "./bound-main-webchat-source-reply.js";
import { buildHarnessVisibleReplyGuidance } from "./source-reply-delivery-mode.js";

const source = {
  provider: "webchat",
  sessionKey: "agent:main:main",
  sessionId: "source-session",
};
const heartbeat: Parameters<typeof mainWebChatHeartbeatContext>[0] = {
  cfg: {},
  prepared: {
    run: { kind: "shared" },
    sessionKey: source.sessionKey,
    conversationEntry: {
      sessionId: source.sessionId,
      delivery: { kind: "internal" },
      createdVia: "operator",
    },
    delivery: { channel: "none", reason: "no-route" },
  },
  suppressOriginatingContext: false,
  runSessionKey: source.sessionKey,
};

describe("bound main WebChat source reply", () => {
  it("requires canonical main identity and honors the configured main key", () => {
    expect(canUseBoundMainWebChatSourceReply(source)).toBe(true);
    expect(
      canUseBoundMainWebChatSourceReply({
        ...source,
        mainKey: "home",
        sessionKey: "agent:main:home",
      }),
    ).toBe(true);
    for (const override of [
      { provider: "whatsapp" },
      { provider: undefined },
      { sessionId: " " },
      { sessionKey: "agent:main:subagent:child" },
      { sessionKey: "agent:main:cron:job" },
      { sessionKey: "agent:main:dashboard:chat" },
      { sessionKey: "agent:main:whatsapp:direct:person" },
      { mainKey: "home" },
    ]) {
      expect(canUseBoundMainWebChatSourceReply({ ...source, ...override })).toBe(false);
    }
  });

  it("adds descriptive heartbeat identity only for its opened internal main conversation", () => {
    expect(mainWebChatHeartbeatContext(heartbeat)).toEqual({
      Provider: "webchat",
      Surface: "webchat",
      ChatType: "direct",
    });
    for (const override of [
      { suppressOriginatingContext: true },
      { runSessionKey: "agent:main:other" },
      { prepared: { ...heartbeat.prepared, run: { kind: "isolated" } } },
      { prepared: { ...heartbeat.prepared, delivery: { channel: "none", reason: "target-none" } } },
      { prepared: { ...heartbeat.prepared, delivery: { channel: "whatsapp" } } },
      { prepared: { ...heartbeat.prepared, conversationEntry: undefined } },
      {
        prepared: {
          ...heartbeat.prepared,
          conversationEntry: {
            sessionId: source.sessionId,
            createdVia: "internal" as const,
            delivery: { kind: "internal" as const },
            lastReadAt: 1,
          },
        },
      },
      {
        prepared: {
          ...heartbeat.prepared,
          conversationEntry: {
            sessionId: source.sessionId,
            createdVia: "spawn" as const,
            delivery: { kind: "internal" as const },
          },
        },
      },
    ]) {
      expect(mainWebChatHeartbeatContext({ ...heartbeat, ...override })).toEqual({});
    }
    expect(
      mainWebChatHeartbeatContext({
        ...heartbeat,
        prepared: {
          ...heartbeat.prepared,
          conversationEntry: {
            sessionId: source.sessionId,
            createdVia: "spawn",
            delivery: { kind: "internal" },
            lastReadAt: 1,
          },
        },
      }),
    ).toHaveProperty("Provider", "webchat");
  });

  it("accepts only an allowed send with no route overrides, including empty overrides", () => {
    expect(isUnroutedSourceReplySend({ media: "/tmp/proof.mp3" }, "send", true)).toBe(true);
    expect(isUnroutedSourceReplySend({ target: null }, "send", true)).toBe(true);
    expect(isUnroutedSourceReplySend({}, "send", false)).toBe(false);
    for (const action of ["broadcast", "reply", "delete"]) {
      expect(isUnroutedSourceReplySend({}, action, true)).toBe(false);
    }
    for (const name of [
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
    ]) {
      expect(isUnroutedSourceReplySend({ [name]: "" }, "send", true)).toBe(false);
    }
    expect(isUnroutedSourceReplySend({ targets: [] }, "send", true)).toBe(false);
  });

  it("keeps source guidance consistent with strict and interactive messaging", () => {
    const guidance = (allow: boolean, available = true, strict = true) =>
      buildHarnessVisibleReplyGuidance({
        sourceReplyDeliveryMode: "message_tool_only",
        messageToolAvailable: available,
        requireExplicitMessageTarget: strict,
        allowBoundMainWebChatSourceReply: allow,
      });
    expect(guidance(true)).toContain("bound main WebChat conversation only, omit channel/target");
    expect(guidance(true)).toContain(
      "Other destinations and actions still require an explicit target",
    );
    expect(guidance(false)).toContain("target required this turn");
    expect(guidance(true, true, false)).toContain("current source is default target");
    expect(guidance(true, false)).not.toContain("omit channel/target");
  });
});
