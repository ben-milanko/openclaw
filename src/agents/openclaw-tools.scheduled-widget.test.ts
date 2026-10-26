// Scheduled show_widget registration and allowlist coverage.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/io.js";
import { createOpenClawCodingTools } from "./agent-tools.js";
import { resolveEmbeddedAttemptToolConstructionPlan } from "./embedded-agent-runner/run/attempt-tool-construction-plan.js";
import { createOpenClawTools } from "./openclaw-tools.js";
import * as inProcessGateway from "./tools/in-process-gateway.js";

vi.mock("./openclaw-plugin-tools.js", () => ({
  resolveOpenClawPluginToolsForOptions: () => [],
}));
beforeEach(() => setRuntimeConfigSnapshot({}));
afterEach(() => {
  vi.restoreAllMocks();
  clearRuntimeConfigSnapshot();
});

function expectWidget(tools: ReturnType<typeof createOpenClawTools>) {
  const tool = tools.find((candidate) => candidate.name === "show_widget");
  if (!tool) {
    throw new Error("Expected show_widget to be registered");
  }
  return tool;
}

function expectPinnedOnlySchema(tool: ReturnType<typeof expectWidget>): void {
  const schema = tool.parameters as {
    properties?: { pin?: { const?: boolean } };
    required?: string[];
  };
  expect(tool.requiredClientCaps).toBeUndefined();
  expect(schema.required).toContain("pin");
  expect(schema.properties?.pin?.const).toBe(true);
}

describe("pinned show_widget registration", () => {
  it("keeps durable WebChat follow-ups pinned-only without borrowing client capabilities", async () => {
    const gatewayCall = vi.spyOn(inProcessGateway, "callInProcessGatewayTool").mockResolvedValue({
      resolvedWidgetName: "followup-status",
      widgets: [{ name: "followup-status", tabId: "main", grantState: "none" }],
    });
    const tools = createOpenClawCodingTools({
      sessionKey: "agent:main:dashboard:owner",
      messageProvider: "webchat",
      inputProvenance: {
        kind: "inter_session",
        sourceSessionKey: "agent:main:dashboard:requester",
        sourceTool: "sessions_send",
      },
      toolConstructionPlan: {
        includeBaseCodingTools: false,
        includeShellTools: false,
        includeChannelTools: false,
        includeOpenClawTools: true,
        includePluginTools: false,
      },
    });
    const tool = expectWidget(tools);
    expectPinnedOnlySchema(tool);
    await expect(
      tool.execute("followup-inline", {
        title: "Status",
        widget_code: "<p>ready</p>",
      }),
    ).rejects.toThrow("pin=true is required for this pinned-only widget surface");
    const result = await tool.execute("followup-pinned", {
      title: "Status",
      widget_code: "<p>ready</p>",
      name: "followup-status",
      pin: true,
    });
    expect(gatewayCall).toHaveBeenCalledExactlyOnceWith(
      "board.widget.put",
      expect.objectContaining({
        sessionKey: "agent:main:dashboard:owner",
        name: "followup-status",
        content: { kind: "html", html: "<p>ready</p>" },
      }),
    );
    expect(result.details).toMatchObject({ status: "pinned", boardWidgetName: "followup-status" });
  });

  it.each([undefined, "agent:main:cron:job:run:detached"])(
    "does not offer capless WebChat authoring without a durable owner (%s)",
    (agentSessionKey) => {
      const tools = createOpenClawTools({ agentSessionKey, agentChannel: "webchat" });
      expect(tools.some((tool) => tool.name === "show_widget")).toBe(false);
    },
  );

  it.each([undefined, "agent:main:cron:job:run:detached"])(
    "requires a persistent session for recovered authoring (%s)",
    (agentSessionKey) => {
      const tools = createOpenClawTools({ agentSessionKey, pinnedWidgetAuthoring: true });
      expect(tools.some((tool) => tool.name === "show_widget")).toBe(false);
    },
  );

  it.each([{ pinnedWidgetAuthoring: true }, { messageProvider: "webchat" }])(
    "applies tool policy to pinned dashboard authoring (%j)",
    (surface) => {
      const options = {
        sessionKey: "agent:main:dashboard:recovered",
        ...surface,
        toolConstructionPlan: {
          includeBaseCodingTools: false,
          includeShellTools: false,
          includeChannelTools: false,
          includeOpenClawTools: true,
          includePluginTools: false,
        },
      };
      expectPinnedOnlySchema(expectWidget(createOpenClawCodingTools(options)));
      const deniedTools = createOpenClawCodingTools({
        ...options,
        config: { tools: { deny: ["show_widget"] } },
      });
      expect(deniedTools.some((tool) => tool.name === "show_widget")).toBe(false);
    },
  );

  it("does not let scheduled provenance replace an explicit widget cap", () => {
    const tools = createOpenClawTools({
      agentSessionKey: "agent:main:dashboard:scheduled",
      agentChannel: "webchat",
      gatewayCallerScheduled: true,
    });

    expect(tools.some((tool) => tool.name === "show_widget")).toBe(false);
  });

  it("honors an explicit widget deny on the scheduled surface", () => {
    const tools = createOpenClawTools({
      agentSessionKey: "agent:main:dashboard:scheduled",
      agentChannel: "webchat",
      gatewayCallerScheduled: true,
      runtimeToolAllowlist: ["show_widget"],
      config: { tools: { deny: ["show_widget"] } },
    });

    expect(tools.some((tool) => tool.name === "show_widget")).toBe(false);
  });

  it.each(["canvas"])(
    "lets a server-authorized %s cap select pinned widget authoring",
    (toolName) => {
      const toolsAllow = [toolName];
      const plan = resolveEmbeddedAttemptToolConstructionPlan({ toolsAllow });
      const tools = createOpenClawCodingTools({
        sessionKey: "agent:main:dashboard:scheduled",
        scheduledToolPolicy: { version: 1, mode: "trusted" },
        runtimeToolAllowlist: plan.runtimeToolAllowlist,
        includeCoreTools: plan.includeCoreTools,
        config: { tools: { allow: toolsAllow } },
        toolConstructionPlan: plan.codingToolConstructionPlan,
      });

      expectPinnedOnlySchema(expectWidget(tools));
    },
  );

  it("keeps scheduled turns with a real inline client on the normal widget surface", () => {
    const tool = expectWidget(
      createOpenClawTools({
        agentSessionKey: "agent:main:dashboard:scheduled",
        gatewayCallerScheduled: true,
        runtimeToolAllowlist: ["show_widget"],
        clientCaps: ["inline-widgets"],
      }),
    );
    const schema = tool.parameters as { required?: string[] };

    expect(tool.requiredClientCaps).toEqual(["inline-widgets"]);
    expect(schema.required).not.toContain("pin");
  });
});
