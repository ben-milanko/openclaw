import { describe, expect, it } from "vitest";
import { signalPlugin } from "./channel.js";

describe("Signal recovery notice policy", () => {
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
