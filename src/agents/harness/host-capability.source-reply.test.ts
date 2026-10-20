import { afterEach, describe, expect, it } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import {
  buildHarnessVisibleReplyGuidance,
  buildMessageToolTargetGuidance,
} from "../../auto-reply/source-reply-delivery-mode.js";
import { resetAgentRunRegistryForTest } from "../../infra/agent-run-registry.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
  type PreparedAgentRunAdmission,
} from "../admitted-run-context.js";
import { createAgentHarnessHostCapabilities } from "./host-capability.js";

type HostAttempt = Parameters<typeof createAgentHarnessHostCapabilities>[0]["attempt"];
type Host = ReturnType<typeof createAgentHarnessHostCapabilities>;
const admissions: PreparedAgentRunAdmission[] = [];
const hosts: Host[] = [];

async function sourceHost(
  overrides: Omit<Partial<HostAttempt>, "admittedRunContext" | "runId"> = {},
) {
  const runId = `source-guidance-${admissions.length}`;
  const admission = prepareAgentRunAdmission({
    cfg: {},
    facts: {
      runId,
      agentId: "main",
      ingress: { kind: "system", boundary: "source-guidance-test", state: "present" },
    },
    operationalRunInstance: createOperationalRunInstanceRef(runId),
  });
  admissions.push(admission);
  const attempt: HostAttempt = {
    agentId: "main",
    runId,
    sessionId: `session-${runId}`,
    sessionKey: "agent:main:main",
    messageChannel: "webchat",
    ...overrides,
    admittedRunContext: await admission.admit("plugin-harness", `harness-${runId}`),
  };
  const host = createAgentHarnessHostCapabilities({ attempt, pluginId: "codex" });
  hosts.push(host);
  return { admission, attempt, host };
}

// This is the shipped official Codex plugin's call shape: no sourceReplyContext field.
const legacyOfficialGuidance = () =>
  buildHarnessVisibleReplyGuidance({
    sourceReplyDeliveryMode: "message_tool_only",
    messageToolAvailable: true,
    requireExplicitMessageTarget: true,
  });

afterEach(() => {
  for (const host of hosts.splice(0)) {
    host.close();
  }
  for (const admission of admissions.splice(0)) {
    admission.close();
  }
  resetAgentRunRegistryForTest();
});

describe("host-scoped source reply guidance for existing plugins", () => {
  it.each([
    { name: "main WebChat", allowed: true },
    {
      name: "configured main WebChat",
      sessionKey: "agent:main:home",
      config: { session: { mainKey: "home" } },
      allowed: true,
    },
    { name: "another session", sessionKey: "agent:main:subagent:child", allowed: false },
    { name: "another provider", messageChannel: "telegram", allowed: false },
    { name: "missing session identity", sessionId: undefined, allowed: false },
  ])("uses captured source facts for $name", async ({ name: _name, allowed, ...overrides }) => {
    const { host } = await sourceHost(overrides);
    await host.runWithScope(async () => {
      const guidance = legacyOfficialGuidance();
      expect(guidance.includes("bound main WebChat conversation only")).toBe(allowed);
      expect(guidance.includes("target required this turn")).toBe(!allowed);
      // The generic core prompt consumes the same descriptive scoped owner.
      expect(buildMessageToolTargetGuidance(true).includes("omit channel/target")).toBe(allowed);
    });
    expect(legacyOfficialGuidance()).toContain("target required this turn");
  });

  it("captures primitives before plugin handoff and honors explicit caller context", async () => {
    const config = { session: { mainKey: "main" } };
    const { attempt, host } = await sourceHost({ config });
    attempt.messageChannel = "telegram";
    attempt.sessionKey = "agent:main:other";
    attempt.sessionId = undefined;
    config.session.mainKey = "other";
    await host.runWithScope(async () => {
      expect(legacyOfficialGuidance()).toContain("omit channel/target");
      expect(
        buildHarnessVisibleReplyGuidance({
          messageToolAvailable: true,
          requireExplicitMessageTarget: true,
          sourceReplyContext: {
            provider: "telegram",
            sessionKey: "agent:main:main",
            sessionId: "other-session",
          },
        }),
      ).toContain("target required this turn");
      expect(buildMessageToolTargetGuidance(true, false)).toContain("target required this turn");
    });
  });

  it.each(["host close", "admission close"] as const)(
    "does not advertise the source sink after %s",
    async (revocation) => {
      const { host, admission } = await sourceHost();
      await host.runWithScope(async () => {
        expect(legacyOfficialGuidance()).toContain("omit channel/target");
        if (revocation === "host close") {
          host.close();
        } else {
          admission.close();
        }
        await Promise.resolve();
        expect(legacyOfficialGuidance()).toContain("target required this turn");
        expect(buildMessageToolTargetGuidance(true)).toContain("target required this turn");
      });
    },
  );

  it("isolates nested and concurrent attempts without losing the outer source", async ({
    signal,
  }) => {
    const { host: main } = await sourceHost();
    const { host: child } = await sourceHost({ sessionKey: "agent:main:subagent:child" });
    const entered = createDeferred();
    const resume = createDeferred();
    const concurrent = main.runWithScope(async () => {
      expect(legacyOfficialGuidance()).toContain("omit channel/target");
      await child.runWithScope(async () => {
        expect(legacyOfficialGuidance()).toContain("target required this turn");
      });
      expect(legacyOfficialGuidance()).toContain("omit channel/target");
      entered.resolve();
      await resume.promise;
      expect(legacyOfficialGuidance()).toContain("omit channel/target");
    });
    try {
      await withinTest(
        awaitGateBeforeSettlement(entered.promise, concurrent, "Main source scope not reached"),
        signal,
      );
      await child.runWithScope(async () => {
        await Promise.resolve();
        expect(legacyOfficialGuidance()).toContain("target required this turn");
      });
      expect(legacyOfficialGuidance()).toContain("target required this turn");
    } finally {
      resume.resolve();
      await concurrent;
    }
  });
});
