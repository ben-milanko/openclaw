import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdmittedRunContext } from "../../agents/admitted-run-context.js";
import { bindCronManagementGrant } from "../../agents/cron-creator-authority-context.js";
import { createCronTool } from "../../agents/tools/cron-tool.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  getGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../../agents/tools/gateway-caller-context.js";
import { callGatewayTool } from "../../agents/tools/gateway.js";
import { cronRunLogEntryToDetail, cronRunStorageStatus } from "../../cron/run-history-detail.js";
import type { CronRunLogEntry } from "../../cron/run-log-types.js";
import { cronStoreKey } from "../../cron/store/key.js";
import * as historyStore from "../../cron/store/read-only.js";
import { recordCronRunInDatabase } from "../../cron/store/run-history.kernel.js";
import {
  bindGatewayContextResolver,
  clearGatewayContextResolver,
} from "../../plugins/runtime/gateway-request-scope.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import { revokeCronCreatorAuthorityRunScope } from "../cron-creator-authority-grant.js";
import {
  SESSION,
  cron,
  inRun,
  createCronFixture,
  installRequesterCronAuthorityTestHooks,
} from "./requester-cron-authority.test-support.js";
import type { GatewayRequestContext } from "./types.js";

installRequesterCronAuthorityTestHooks();
afterEach(() => vi.restoreAllMocks());

async function createHistoryFixture() {
  const { context } = createCronFixture();
  const job = await cron.add({
    name: "Foreign maintenance",
    enabled: false,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "Synthetic maintenance" },
    delivery: { mode: "none" },
    owner: { agentId: "main", sessionKey: "agent:main:foreign", accountId: "foreign" },
  });
  const entry: CronRunLogEntry = {
    action: "finished",
    ts: 1_000,
    jobId: job.id,
    runId: "foreign-run",
    status: "error",
    error: "Synthetic execution failure",
    summary: "Synthetic maintenance result",
    deliveryStatus: "not-delivered",
  };
  const storeKey = cronStoreKey(context.cronStorePath);
  runOpenClawStateWriteTransaction(({ db }) => {
    for (const run of [
      entry,
      { ...entry, ts: 2_000, runId: "different-run", summary: "Different result" },
    ]) {
      recordCronRunInDatabase(db, {
        storeKey,
        jobId: job.id,
        runId: `cron:${run.runId}`,
        agentId: "main",
        startedAt: run.ts,
        endedAt: run.ts,
        status: cronRunStorageStatus(run),
        error: run.error,
        summary: run.summary,
        detail: cronRunLogEntryToDetail(run, { storeKey }),
      });
    }
  });
  return { context, job };
}

async function withHistoryGateway<T>(
  admitted: AdmittedRunContext,
  context: GatewayRequestContext,
  run: () => Promise<T>,
) {
  bindGatewayContextResolver(admitted, () => context);
  try {
    return await withGatewayToolCallerIdentity(
      createAdmittedGatewayToolCallerIdentity({
        admittedRunContext: admitted,
        agentId: "main",
        sessionKey: SESSION,
      }),
      run,
    );
  } finally {
    clearGatewayContextResolver(admitted);
  }
}

describe("automation management history through the agent tool and Gateway router", () => {
  it.each(["control-ui-admin", "channel-owner"] as const)(
    "lets an admitted %s inspect a foreign run without granting aggregate or transcript history",
    async (source) => {
      const { context, job } = await createHistoryFixture();
      const runId = `history-${source}`;
      await inRun(
        runId,
        {
          runId,
          callerOrigin: { kind: "unknown" },
          managementEntitlement:
            source === "channel-owner" ? { source, isCurrent: () => true } : { source },
        },
        async (_identity, admitted) =>
          withHistoryGateway(admitted, context, async () => {
            const tool = createCronTool({ runId, agentSessionKey: SESSION });
            await expect(
              tool.execute("history", { action: "runs", jobId: job.id, runId: "foreign-run" }),
            ).resolves.toMatchObject({
              details: {
                total: 1,
                entries: [
                  {
                    runId: "foreign-run",
                    status: "error",
                    error: "Synthetic execution failure",
                    summary: "Synthetic maintenance result",
                  },
                ],
              },
            });
            expect(tool.parameters).toHaveProperty(
              "properties.action.enum",
              expect.arrayContaining(["runs"]),
            );
            expect(tool.parameters).toHaveProperty("properties.runId");
            expect(tool.description).toContain("runs jobId");
            const management = expectDefined(bindCronManagementGrant(runId), "management binding");
            const grant = expectDefined(management.mint("cron.runs"), "history grant");
            await withGatewayToolCallerIdentity(
              {
                ...expectDefined(getGatewayToolCallerIdentity(), "admitted caller"),
                cronManagementGrant: grant,
              },
              async () => {
                await expect(callGatewayTool("cron.runs", {}, { scope: "all" })).rejects.toThrow(
                  "scope all is not allowed by caller scope",
                );
                await expect(callGatewayTool("cron.runs", {}, { id: job.id })).rejects.toThrow(
                  "already used",
                );
              },
            );
            expect(() => management.mint("cron.history")).toThrow("management-only");
            const self = createCronTool({
              runId,
              agentSessionKey: SESSION,
              selfRemoveOnlyJobId: "current-job",
            });
            expect(self.parameters).toHaveProperty("properties.runId");
            await expect(
              self.execute("foreign-history", { action: "runs", jobId: job.id }),
            ).rejects.toThrow("restricted to the current automation");
          }),
      );
    },
  );

  it("keeps an ordinary admitted turn caller-scoped", async () => {
    const { context, job } = await createHistoryFixture();
    await inRun("ordinary-history", undefined, async (_identity, admitted) =>
      withHistoryGateway(admitted, context, () =>
        expect(
          createCronTool({ runId: "ordinary-history", agentSessionKey: SESSION }).execute(
            "history",
            { action: "runs", jobId: job.id },
          ),
        ).rejects.toThrow("Automation not found"),
      ),
    );
  });

  it.each(["revocation", "expiry"] as const)(
    "withholds history after %s while awaiting the history worker",
    async (invalidation) => {
      const { context, job } = await createHistoryFixture();
      const runId = "late-history-authority";
      await inRun(
        runId,
        {
          runId,
          callerOrigin: { kind: "unknown" },
          managementEntitlement: { source: "control-ui-admin" },
        },
        async (_identity, admitted, scope) =>
          withHistoryGateway(admitted, context, async () => {
            const readRecords = historyStore.readCronRunRecords;
            vi.spyOn(historyStore, "readCronRunRecords").mockImplementationOnce(async (...args) => {
              const records = await readRecords(...args);
              if (invalidation === "revocation") {
                revokeCronCreatorAuthorityRunScope(expectDefined(scope, "management scope"));
              } else {
                vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
              }
              return records;
            });
            await expect(
              createCronTool({ runId, agentSessionKey: SESSION }).execute("history", {
                action: "runs",
                jobId: job.id,
              }),
            ).rejects.toThrow("expired");
          }),
      );
    },
  );
});
