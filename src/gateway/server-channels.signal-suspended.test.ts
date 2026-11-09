import { describe, expect, it, vi } from "vitest";
import { signalPlugin } from "../../extensions/signal/channel-plugin-api.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { createTestChannelManager } from "./server-channels.test-support.js";

describe("suspended personal Signal startup", () => {
  it("does not start ingress even when an approved contact can address the assistant", async () => {
    if (!signalPlugin.gateway?.startAccount) {
      throw new Error("Signal startup capability is unavailable");
    }
    const startAccount = vi
      .spyOn(signalPlugin.gateway, "startAccount")
      .mockResolvedValue(undefined);
    const registry = createEmptyPluginRegistry();
    registry.channels.push({ pluginId: "signal", source: "test", plugin: signalPlugin });
    const cfg: OpenClawConfig = {
      channels: {
        signal: {
          enabled: false,
          transport: { kind: "external-native", url: "http://127.0.0.1:8080" },
          assistantRequestPrefixes: ["Helper:"],
          dmPolicy: "allowlist",
          allowFrom: ["+15550001111"],
          groupPolicy: "allowlist",
          groupAllowFrom: ["group:test-group"],
        },
      },
    };
    const scheduler = createTestGatewayScheduler();
    const manager = createTestChannelManager({
      channelIds: ["signal"],
      scheduler,
      getRuntimeConfig: () => cfg,
      getPluginRegistry: () => registry,
    });
    try {
      await manager.startChannels();
      await expect(manager.startChannel("signal", "default", { manual: true })).resolves.toEqual(
        new Map([["default", { status: "skipped", reason: "disabled" }]]),
      );
      expect(manager.getRuntimeSnapshot().channelAccounts.signal?.default).toMatchObject({
        enabled: false,
        running: false,
        stateReason: "disabled",
      });
      // Without ingress there is no message-classification or provider-failure path to reply.
      expect(startAccount).not.toHaveBeenCalled();
    } finally {
      await manager.stopChannel("signal");
      await scheduler.stop();
      startAccount.mockRestore();
    }
  });
});
