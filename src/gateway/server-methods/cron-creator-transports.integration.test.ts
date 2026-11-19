import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
  withTestTimeout,
} from "../../../test/helpers/promise.js";
import { getAdmittedRunDelegatedAuthority } from "../../agents/admitted-run-context.js";
import { persistAuthProfileBatch } from "../../agents/auth-profiles/upsert-with-lock.js";
import { withPreparedEmbeddedGatewayTools } from "../../agents/embedded-agent-runner/run/attempt-gateway-tools.js";
import { projectEffectiveExecPolicy } from "../../agents/session-permission-exec-mode.js";
import { AUTOMATIONS_TOOL_NAME } from "../../agents/tools/automations-tool-name.js";
import { createCronTool } from "../../agents/tools/cron-tool.js";
import { setRuntimeConfigSnapshot } from "../../config/config.js";
import {
  loadSessionEntry,
  replaceSessionEntrySync,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  bindGatewayContextResolver,
  clearGatewayContextResolver,
} from "../../plugins/runtime/gateway-request-scope.js";
import {
  captureGatewayDeviceRevocation,
  invalidateGatewayDeviceRevocation,
} from "../device-revocation.js";
import {
  deactivateMcpLoopbackClientGrantCapture,
  revokeMcpLoopbackClientGrant,
} from "../mcp-grant-store.js";
import { closeMcpLoopbackServer, ensureMcpLoopbackServer } from "../mcp-http.js";
import { hasGatewayAdminScope } from "../operator-scopes.js";
import { createSyntheticPluginRuntimeClient } from "../server-plugin-runtime-client.js";
import { resolveGatewayChatCronCreatorAuthorityAdmission } from "./cron-creator-authority-admission.js";
import {
  SESSION,
  SESSION_ID,
  CREATOR,
  cfg as baseCfg,
  stateDir,
  admission,
  inRun,
  createCronFixture,
  type CreatorTransportTools,
  createCreatorTransportTools,
  installRequesterCronAuthorityTestHooks,
  type RequesterRun,
} from "./requester-cron-authority.test-support.js";

// Attached-node inventory is unrelated to these original-caller and Cron commit boundaries.
vi.mock("../../agents/node-exec-availability.js", () => ({
  loadNodeExecAvailability: async () => ({ cacheKey: "no-nodes", isAvailable: () => false }),
}));

let config: OpenClawConfig;
let fixture: ReturnType<typeof heldCron>;
const timedPayload = { kind: "agentTurn", message: "Check status", timeoutSeconds: 0 };

const ownedJob = {
  createdActor: CREATOR,
  owner: { agentId: "main", sessionKey: SESSION, accountId: "default" },
  scheduledToolPolicy: {
    mode: "account",
    ownerSessionKey: SESSION,
    ownerAccountId: "default",
  },
};

function boundTo(contextFixture: ReturnType<typeof createCronFixture>, run: RequesterRun<void>) {
  return (async (...args) => {
    const admitted = args[1];
    bindGatewayContextResolver(admitted, () => contextFixture.context);
    try {
      await run(...args);
    } finally {
      clearGatewayContextResolver(admitted);
    }
  }) satisfies RequesterRun<void>;
}

function heldCron(testConfig: OpenClawConfig) {
  const entered = createDeferred();
  const release = createDeferred();
  let hold = false;
  const cron = createCronFixture(async () => {
    if (hold) {
      entered.resolve();
      await release.promise;
    }
    return [];
  }, testConfig);
  return {
    ...cron,
    release,
    async rejectMutation(
      start: () => Promise<unknown>,
      pattern: RegExp,
      revoke: () => void | Promise<void>,
      signal?: AbortSignal,
    ) {
      const before = await cron.read();
      hold = true;
      const pending = start();
      const rejected = expect(pending).rejects.toThrow(pattern);
      void rejected.catch(() => undefined);
      try {
        const gate = awaitGateBeforeSettlement(
          entered.promise,
          pending,
          "Mutation settled before Cron validation",
        );
        await (signal
          ? withinTest(gate, signal)
          : withTestTimeout(gate, 10_000, "Cron validation not reached"));
        expect(await cron.read()).toEqual(before);
        await revoke();
      } finally {
        release.resolve();
        await pending.catch(() => undefined);
      }
      await rejected;
      expect(await cron.read()).toEqual(before);
    },
  };
}

installRequesterCronAuthorityTestHooks();
beforeEach(async () => {
  config = {
    ...baseCfg,
    agents: {
      ...baseCfg.agents,
      defaults: { model: "openai/gpt-4.1", workspace: stateDir },
    },
    tools: { allow: [AUTOMATIONS_TOOL_NAME] },
  };
  setRuntimeConfigSnapshot(config);
  fixture = heldCron(config);
  vi.stubEnv("OPENAI_API_KEY", undefined);
  vi.stubEnv("OPENAI_OAUTH_TOKEN", undefined);
  await persistAuthProfileBatch({
    stateDir,
    profiles: [
      {
        profileId: "openai:automation-test",
        credential: { type: "api_key", provider: "openai", key: "synthetic-automation-test-key" },
      },
    ],
  });
});

function addJob(
  tools: CreatorTransportTools,
  name: string,
  overrides: Record<string, unknown> = {},
) {
  return tools.invoke(AUTOMATIONS_TOOL_NAME, {
    action: "add",
    job: {
      name,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "current",
      payload: { kind: "agentTurn", message: "Check status" },
      delivery: { mode: "none" },
      ...overrides,
    },
  });
}

it("retains a remote requester's finite native script cap and rejects a revoked write", async ({
  signal,
}) => {
  const caller = captureGatewayDeviceRevocation(
    fixture.context,
    { deviceId: "remote-script-creator", role: "operator" },
    () => true,
  );
  const client = createSyntheticPluginRuntimeClient({ scopes: ["operator.admin"] });
  client.internal = { controlUiAdmin: true };
  const runId = "remote-finite-script";
  const creator = expectDefined(admission(runId, client, undefined, caller.isCurrent), "admin");
  try {
    await inRun(
      runId,
      creator,
      boundTo(fixture, async (_identity, admitted, capability) => {
        const tool = createCronTool({
          agentSessionKey: SESSION,
          agentAccountId: "default",
          runId,
          creatorToolAllowlist: [
            { name: "exec", execOrigin: "native", execTarget: { host: "gateway", ask: "always" } },
          ],
          creatorToolAllowlistCaptureRef: {},
        });
        const create = (name: string, toolsAllow = ["exec"]) =>
          withPreparedEmbeddedGatewayTools(
            {
              admittedRunContext: admitted,
              cronCreatorAuthorityCapability: capability,
              agentId: "main",
              sessionKey: SESSION,
              sessionId: SESSION_ID,
              agentHarnessId: "openclaw",
              agentAccountId: "default",
            },
            () =>
              tool.execute(name, {
                action: "add",
                job: {
                  name,
                  enabled: false,
                  schedule: { kind: "every", everyMs: 900_000 },
                  sessionTarget: "isolated",
                  payload: { kind: "script", script: "json({state:{checked:true}})", toolsAllow },
                  delivery: { mode: "none" },
                },
              }),
          );
        await create("Finite remote script");
        const before = await fixture.read();
        expect(before).toMatchObject([
          {
            name: "Finite remote script",
            enabled: false,
            ...ownedJob,
            payload: { toolsAllow: ["exec"] },
          },
        ]);
        const stored = expectDefined(before[0], "stored script");
        expect(stored.runtimeAuthority).toBeUndefined();
        expect(stored.toolsAllowProvenance).toBeUndefined();
        expect(stored.toolsAllowExecTarget).toEqual({ version: 1, host: "gateway", ask: "always" });
        expect(
          projectEffectiveExecPolicy({
            base: { host: "auto", ask: "off", security: "full" },
            scheduledExecTarget: stored.toolsAllowExecTarget,
          }),
        ).toMatchObject({ host: "gateway", ask: "always", bypassHostApprovalFloors: false });
        await expect(create("Unavailable tool", ["not_visible"])).rejects.toThrow(
          "Configured MCP authority is unavailable",
        );
        expect(await fixture.read()).toEqual(before);
        await fixture.rejectMutation(
          () => create("Revoked remote script"),
          /authority.*no longer active/i,
          () =>
            invalidateGatewayDeviceRevocation(fixture.context, "remote-script-creator", "operator"),
          signal,
        );
      }),
    );
  } finally {
    caller.release();
  }
});

it("preserves ordinary restricted caller creation without management admission", async () => {
  const client = createSyntheticPluginRuntimeClient({ scopes: ["operator.write"] });
  client.internal = {};
  expect(admission("restricted-creator", client)).toBeUndefined();
  await inRun(
    "restricted-creator",
    undefined,
    boundTo(fixture, async (_identity, admitted) => {
      const tools = await createCreatorTransportTools({
        transport: "embedded",
        config,
        admitted,
        senderIsOwner: true,
      });
      await addJob(tools, "Restricted caller job", {
        payload: { ...timedPayload },
      });
      const jobs = await fixture.read();
      expect(jobs).toMatchObject([
        {
          ...ownedJob,
          payload: { toolsAllow: ["*"], timeoutSeconds: 0 },
        },
      ]);
      expect(jobs[0]?.payload).not.toHaveProperty("toolsAllowIsDefault");
    }),
  );
});
it.each([
  ["cli", "local", "device"],
  ["embedded", "local", "device"],
  ["embedded", "remote", "device"],
  ["embedded", "remote-chat", "device"],
  ["embedded", "local", "skill selection"],
] as const)(
  "fences a real %s %s creator mutation on %s change while its run remains admitted",
  { timeout: 30_000 },
  async (transport, origin, reason) => {
    const { release } = fixture;
    const caller = captureGatewayDeviceRevocation(
      fixture.context,
      { deviceId: "creator-device", role: "operator" },
      () => true,
    );
    const client = createSyntheticPluginRuntimeClient({ scopes: ["operator.admin"] });
    client.internal = origin === "local" ? { isLocalClient: true } : { controlUiAdmin: true };
    const runId = `original-${transport}-creator`;
    const creatorAdmission = expectDefined(
      origin === "remote-chat"
        ? resolveGatewayChatCronCreatorAuthorityAdmission({
            runId,
            resolvedSessionKey: SESSION,
            client,
            isCurrent: caller.isCurrent,
            hasExplicitOrigin: false,
            hasRestoredCronContinuation: false,
            isIncognito: false,
            isReconnectResume: false,
            isSystemGenerated: false,
            turnKind: "main",
            isDirectExternalUser: true,
          })
        : admission(runId, client, undefined, caller.isCurrent),
      "fresh operator admission",
    );
    let transportTools: CreatorTransportTools | undefined;
    try {
      if (transport === "cli") {
        await ensureMcpLoopbackServer();
      }
      await inRun(
        runId,
        creatorAdmission,
        boundTo(fixture, async (_identity, admitted, capability) => {
          const creator = expectDefined(capability, "creator capability");
          const delegated = expectDefined(
            getAdmittedRunDelegatedAuthority(admitted),
            "admitted run",
          );
          const tools = await createCreatorTransportTools({
            transport,
            config,
            admitted,
            creator,
            senderIsOwner: hasGatewayAdminScope(client),
          });
          transportTools = tools;
          const invoke = (name: string) =>
            addJob(tools, name, {
              wakeMode: "next-heartbeat",
              payload: { ...timedPayload },
            });

          await invoke("Live creator");
          const before = await fixture.read();
          expect(before).toMatchObject([
            {
              name: "Live creator",
              ...ownedJob,
              sessionKey: SESSION,
              sessionTarget: "current",
              payload: {
                kind: "agentTurn",
                timeoutSeconds: 0,
                toolsAllow: ["*"],
              },
              toolsAllowProvenance: {
                source: "final-executable-surface",
                callerOrigin: { kind: origin === "local" ? "local" : "unknown" },
              },
            },
          ]);
          expect(before[0]?.payload).not.toHaveProperty("toolsAllowIsDefault");
          expect(before[0]?.runtimeAuthority).toBeUndefined();
          await fixture.rejectMutation(
            () => invoke("Revoked creator"),
            reason === "skill selection"
              ? /Creator session changed before scheduling/
              : /authority.*no longer active/i,
            () => {
              if (reason === "skill selection") {
                const session = expectDefined(
                  loadSessionEntry({ sessionKey: SESSION }),
                  "creator session",
                );
                const updated = {
                  ...session,
                  skillLibrarySelections: [
                    {
                      skillId: "00000000-0000-4000-8000-000000000001",
                      revision: "b".repeat(64),
                      name: "Selected skill",
                      ownerProfileId: CREATOR.id,
                    },
                  ],
                };
                replaceSessionEntrySync({ sessionKey: SESSION }, updated);
                expect(loadSessionEntry({ sessionKey: SESSION })).toEqual(updated);
                expect(caller.isCurrent()).toBe(true);
              } else {
                invalidateGatewayDeviceRevocation(fixture.context, "creator-device", "operator");
              }
            },
          );
          expect(getAdmittedRunDelegatedAuthority(admitted)).toBe(delegated);
          expect(creator).toMatchObject({ active: true, signal: { aborted: false } });
          if (tools.mcpCapture) {
            expect(deactivateMcpLoopbackClientGrantCapture(tools.mcpCapture)).toBe(true);
          }
        }),
      );
    } finally {
      release.resolve();
      if (transportTools?.mcpCapture) {
        revokeMcpLoopbackClientGrant(transportTools.mcpCapture.token);
      }
      try {
        if (transport === "cli") {
          await closeMcpLoopbackServer();
        }
      } finally {
        caller.release();
      }
    }
  },
);
