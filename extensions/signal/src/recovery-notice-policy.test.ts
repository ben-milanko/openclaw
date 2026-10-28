import { describe, expect, it, vi } from "vitest";
const { sendTypingSignal } = vi.hoisted(() => ({ sendTypingSignal: vi.fn() }));
vi.mock("./send.js", () => ({ sendTypingSignal }));
import { signalPlugin } from "./channel.js";

describe("Signal recovery notice policy", () => {
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
    await signalPlugin.heartbeat?.sendTyping?.(params);
    await signalPlugin.heartbeat?.clearTyping?.(params);
    expect(sendTypingSignal).not.toHaveBeenCalled();
  });
  it("preserves ordinary bot notices", () => {
    expect(signalPlugin.messaging?.allowRecoveryNotice?.({ cfg: {} })).toBe(true);
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
