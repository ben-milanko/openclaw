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
const { replyMock, sendMock, upsertPairingRequestMock } = getSignalToolResultTestMocks();

function configure(extra: Record<string, unknown> = {}) {
  setSignalToolResultTestConfig(
    createSignalToolResultConfig({
      autoStart: false,
      assistantRequestPrefixes: ["Helper:"],
      ...extra,
    }),
  );
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
  it.each(["NO_REPLY", "generic failure", "provider guidance"])(
    "does not send %s via final or block delivery",
    async (text) => {
      configure({ streaming: { block: { enabled: true } } });
      replyMock.mockImplementation(async (_ctx, options: GetReplyOptions) => {
        const payload = { text, ...(text === "NO_REPLY" ? {} : { isError: true }) };
        await options.onBlockReply?.(payload);
        return payload;
      });
      await receive();
      expect(replyMock).toHaveBeenCalledTimes(1);
      expect(sendMock).not.toHaveBeenCalled();
    },
  );

  it("keeps resolver failures local", async () => {
    configure();
    replyMock.mockRejectedValue(new Error("synthetic provider unavailable"));
    await receive();
    expect(replyMock).toHaveBeenCalledTimes(1);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("delivers successful requested answers through the same final path", async () => {
    configure();
    sendMock.mockResolvedValue({ messageId: "1700000000002" });
    replyMock.mockResolvedValue({ text: "Here is the explanation." });
    await receive("  helper: explain this");
    expect(replyMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0]?.[1]).toBe("PFX Here is the explanation.");
  });

  it("does not pair or run an unapproved explicit DM", async () => {
    configure({ dmPolicy: "pairing", allowFrom: [] });
    await receive();
    expect(replyMock).not.toHaveBeenCalled();
    expect(upsertPairingRequestMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
  });
});
