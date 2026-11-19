import { afterEach, describe, expect, it } from "vitest";
import { buildHarnessVisibleReplyGuidance } from "../../auto-reply/source-reply-delivery-mode.js";
import { resetAgentRunRegistryForTest } from "../../infra/agent-run-registry.js";
import { createAgentHarnessHostCapabilities } from "./host-capability.js";
import { admissionFixture } from "./host-capability.shard.test-support.js";

const { admittedAttempt, closeAdmissions } = admissionFixture({}, "legacy-source-guidance");
const hosts: Array<ReturnType<typeof createAgentHarnessHostCapabilities>> = [];

// Exact call shape retained in the installed Codex2026.11.2 native bundle.
const legacyGuidance = () =>
  buildHarnessVisibleReplyGuidance({
    sourceReplyDeliveryMode: "message_tool_only",
    messageToolAvailable: true,
    requireExplicitMessageTarget: true,
  });

async function sourceHost(source = true) {
  const { attempt, admission } = await admittedAttempt(`legacy-source-${hosts.length}`, {
    messageChannel: source ? "telegram" : undefined,
    currentChannelId: source ? "123" : undefined,
  });
  const host = createAgentHarnessHostCapabilities({ attempt, pluginId: "codex" });
  hosts.push(host);
  return { host, attempt, admission };
}

afterEach(() => {
  for (const host of hosts.splice(0)) {
    host.close();
  }
  closeAdmissions();
  resetAgentRunRegistryForTest();
});

describe("released harness source-reply guidance", () => {
  it("captures source primitives and keeps explicit modern no-conversation context authoritative", async () => {
    const { host, attempt } = await sourceHost();
    attempt.messageChannel = "webchat";
    attempt.currentChannelId = undefined;
    await host.runWithScope(async () => {
      expect(legacyGuidance()).toContain("Visible source replies are not automatically delivered");
      expect(legacyGuidance()).toContain("target required this turn");
      expect(
        buildHarnessVisibleReplyGuidance({
          sourceReplyDeliveryMode: "message_tool_only",
          messageToolAvailable: true,
          currentConversation: {},
        }),
      ).toContain("OpenClaw delivers your final response automatically to the caller");
    });
    expect(legacyGuidance()).toContain(
      "OpenClaw delivers your final response automatically to the caller",
    );
  });

  it.each(["host", "admission"] as const)(
    "drops legacy source hints after %s retirement",
    async (retire) => {
      const { host, admission } = await sourceHost();
      await host.runWithScope(async () => {
        expect(legacyGuidance()).toContain(
          "Visible source replies are not automatically delivered",
        );
        if (retire === "host") {
          host.close();
        } else {
          admission.close();
        }
        await Promise.resolve();
        expect(legacyGuidance()).toContain(
          "OpenClaw delivers your final response automatically to the caller",
        );
      });
    },
  );

  it("isolates nested and concurrent native attempts", async () => {
    const { host: source } = await sourceHost();
    const { host: privateRun } = await sourceHost(false);
    await source.runWithScope(async () => {
      expect(legacyGuidance()).toContain("Visible source replies are not automatically delivered");
      await privateRun.runWithScope(async () => {
        expect(legacyGuidance()).toContain(
          "OpenClaw delivers your final response automatically to the caller",
        );
      });
      expect(legacyGuidance()).toContain("Visible source replies are not automatically delivered");
    });
    await Promise.all([
      source.runWithScope(async () => {
        await Promise.resolve();
        expect(legacyGuidance()).toContain(
          "Visible source replies are not automatically delivered",
        );
      }),
      privateRun.runWithScope(async () => {
        await Promise.resolve();
        expect(legacyGuidance()).toContain(
          "OpenClaw delivers your final response automatically to the caller",
        );
      }),
    ]);
  });
});
