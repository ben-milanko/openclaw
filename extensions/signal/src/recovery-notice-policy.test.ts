import { beforeEach, describe, expect, it, vi } from "vitest";
import { signalPlugin } from "./channel.js";

const { sendTypingSignal } = vi.hoisted(() => ({
  sendTypingSignal: vi.fn<typeof import("./send.js").sendTypingSignal>(),
}));

vi.mock("./send.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./send.js")>()),
  sendTypingSignal,
}));

describe("Signal recovery notice policy", () => {
  beforeEach(() => {
    sendTypingSignal.mockReset().mockResolvedValue(true);
  });

  it("suppresses recovery typing for the selected personal account", async () => {
    const params = {
      cfg: {
        channels: {
          signal: {
            defaultAccount: "personal",
            accounts: { personal: { assistantRequestPrefixes: [] } },
          },
        },
      },
      to: "signal:+15555550123",
    };
    const heartbeat = signalPlugin.heartbeat;
    if (!heartbeat?.sendTyping || !heartbeat.clearTyping) {
      throw new Error("Signal recovery typing capability is unavailable");
    }
    await heartbeat.sendTyping(params);
    await heartbeat.clearTyping(params);
    expect(sendTypingSignal).not.toHaveBeenCalled();
  });

  it("preserves ordinary bot notices and recovery typing", async () => {
    expect(signalPlugin.messaging?.allowRecoveryNotice?.({ cfg: {} })).toBe(true);
    const heartbeat = signalPlugin.heartbeat;
    if (!heartbeat?.sendTyping || !heartbeat.clearTyping) {
      throw new Error("Signal recovery typing capability is unavailable");
    }
    const params = { cfg: {}, to: "signal:+15555550123" };
    await heartbeat.sendTyping(params);
    await heartbeat.clearTyping(params);
    expect(sendTypingSignal).toHaveBeenCalledTimes(2);
    expect(sendTypingSignal).toHaveBeenNthCalledWith(1, params.to, { cfg: params.cfg });
    expect(sendTypingSignal).toHaveBeenNthCalledWith(2, params.to, {
      cfg: params.cfg,
      stop: true,
    });
  });
  it("suppresses notices for the selected default personal account", () => {
    expect(
      signalPlugin.messaging?.allowRecoveryNotice?.({
        cfg: {
          channels: {
            signal: {
              defaultAccount: "personal",
              accounts: { personal: { assistantRequestPrefixes: [] } },
            },
          },
        },
      }),
    ).toBe(false);
  });
  it("inherits root policy on a named account", () => {
    expect(
      signalPlugin.messaging?.allowRecoveryNotice?.({
        cfg: {
          channels: {
            signal: {
              assistantRequestPrefixes: ["Helper:"],
              accounts: { personal: {} },
            },
          },
        },
        accountId: "personal",
      }),
    ).toBe(false);
  });
});
