import type { GetReplyOptions } from "openclaw/plugin-sdk/reply-runtime";
import { describe, expect, it } from "vitest";
import {
  createSignalToolResultConfig,
  getSignalToolResultTestMocks,
  installSignalToolResultTestHooks,
  receiveSignalPayloads,
  setSignalToolResultTestConfig,
} from "./monitor.tool-result.test-harness.js";

installSignalToolResultTestHooks();
const {
  replyMock,
  sendMock,
  sendTypingMock,
  sendReadReceiptMock,
  signalRpcRequestMock,
  upsertPairingRequestMock,
} = getSignalToolResultTestMocks();

function configure(extra: Record<string, unknown> = {}) {
  setSignalToolResultTestConfig({
    ...createSignalToolResultConfig({
      autoStart: false,
      assistantRequestPrefixes: ["Helper:"],
      sendReadReceipts: true,
      reactionLevel: "extensive",
      ...extra,
    }),
    messages: {
      responsePrefix: "PFX",
      visibleReplies: "automatic",
      ackReaction: "👀",
      ackReactionScope: "all",
      statusReactions: { enabled: true },
    },
  });
}

function expectNoAutomaticSignals() {
  expect(sendTypingMock).not.toHaveBeenCalled();
  expect(sendReadReceiptMock).not.toHaveBeenCalled();
  // Status reactions use the real Signal reaction adapter and its mocked RPC boundary.
  expect(signalRpcRequestMock).not.toHaveBeenCalled();
}

async function receive(message = "Helper: explain this") {
  await receiveSignalPayloads({
    payloads: [
      {
        envelope: {
          sourceNumber: "+15550001111",
          sourceName: "Ada",
          timestamp: 1700000000001,
          dataMessage: { message },
        },
      },
    ],
  });
}

describe("personal Signal request delivery", () => {
  it.each([false, true])(
    "ignores human chatter, human mentions and unaddressed opt-outs without visible effects (group=%s)",
    async (group) => {
      configure({ accountUuid: "human-account", groupPolicy: "open" });
      replyMock.mockRejectedValue(new Error("a human message must not reach model admission"));
      await receiveSignalPayloads({
        payloads: ["Anyone know the answer?", "￼ please help", "No AI on this topic, please."].map(
          (message, index) => ({
            envelope: {
              sourceNumber: "+15550001111",
              sourceName: "Ada",
              timestamp: 1700000000001 + index,
              dataMessage: {
                message,
                ...(index === 1
                  ? { mentions: [{ uuid: "human-account", start: 0, length: 1 }] }
                  : {}),
                ...(group ? { groupInfo: { groupId: "test-group" } } : {}),
              },
            },
          }),
        ),
      });
      expect(replyMock).not.toHaveBeenCalled();
      expect(upsertPairingRequestMock).not.toHaveBeenCalled();
      expect(sendMock).not.toHaveBeenCalled();
      expectNoAutomaticSignals();
    },
  );

  it.each(["NO_REPLY", "generic failure", "provider guidance"])(
    "does not send %s via final or block delivery",
    async (text) => {
      configure({ streaming: { block: { enabled: true } } });
      replyMock.mockImplementation(async (_ctx, options: GetReplyOptions) => {
        await options.onReplyStart?.();
        const payload = { text, ...(text === "NO_REPLY" ? {} : { isError: true }) };
        await options.onBlockReply?.(payload);
        return payload;
      });
      await receive();
      expect(replyMock).toHaveBeenCalledTimes(1);
      expect(sendMock).not.toHaveBeenCalled();
      expectNoAutomaticSignals();
    },
  );

  it("keeps resolver failures local", async () => {
    configure();
    replyMock.mockImplementation(async (_ctx, options: GetReplyOptions) => {
      await options.onReplyStart?.();
      throw new Error("synthetic provider unavailable");
    });
    await receive();
    expect(replyMock).toHaveBeenCalledTimes(1);
    expect(sendMock).not.toHaveBeenCalled();
    expectNoAutomaticSignals();
  });

  it("delivers successful requested answers through the same final path", async () => {
    configure();
    sendMock.mockResolvedValue({ messageId: "1700000000002" });
    replyMock.mockImplementation(async (_ctx, options: GetReplyOptions) => {
      await options.onReplyStart?.();
      return { text: "Here is the explanation." };
    });
    await receive("  helper: explain this");
    expect(replyMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0]?.[1]).toBe("PFX Here is the explanation.");
    expectNoAutomaticSignals();
  });

  it("does not pair or run an unapproved explicit DM", async () => {
    configure({ dmPolicy: "pairing", allowFrom: [] });
    await receive();
    expect(replyMock).not.toHaveBeenCalled();
    expect(upsertPairingRequestMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
    expectNoAutomaticSignals();
  });
});
