import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { prepareExecutionIdentityContextAtAdmission } from "../audit/execution-identity.test-support.js";
import { insertOperatorApproval } from "../gateway/operator-approval-store.js";
import { createProcessSupervisor } from "../process/supervisor/supervisor.js";
import { listAgentProvenance } from "../state/agent-provenance.js";
import * as state from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { executeOpenClawStateWorker } from "../state/openclaw-state-worker-store.js";
import { listProfiles } from "../state/user-profile-reads.js";
import { commitExecAuthorizationLocked } from "./exec-approvals-authorization.js";
import { currentPolicyExec } from "./exec-approvals-current-policy.test-support.js";
import { writeExecApprovalsConfigRow } from "./exec-approvals-sqlite.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await state.closeOpenClawStateDatabaseAsync();
    state.closeOpenClawStateDatabaseForTest();
    vi.unstubAllEnvs();
    cleanup();
  }),
);
const token = {
  tokenVersion: 1 as const,
  createdAt: Date.now(),
  runId: "integrity-run",
  contextId: "integrity-context",
  executionId: "integrity-execution",
};

type Surface = "roster" | "profiles" | "approval binding" | "message progress" | "message binding";
async function useFeature(surface: Surface, env: NodeJS.ProcessEnv, id: string) {
  if (surface === "roster") {
    expect(await listAgentProvenance({ env })).toEqual([]);
  } else if (surface === "profiles") {
    expect(await listProfiles({ env })).toEqual([]);
  } else if (surface === "approval binding") {
    const result = await insertOperatorApproval({
      databaseOptions: { env },
      approval: {
        id,
        kind: "exec",
        presentation: {
          kind: "exec",
          commandText: "printf synthetic",
          allowedDecisions: ["allow-once", "allow-always", "deny"],
        },
        source: { runId: token.runId },
        runtimeEpoch: "integrity-runtime",
        createdAtMs: 1_000,
        expiresAtMs: 10_000,
        executionIdentityToken: token,
      },
    });
    expect(result).toMatchObject({ outcome: "inserted" });
  } else {
    const binding = surface === "message binding";
    const result = await executeOpenClawStateWorker(captureOpenClawStateWorkerContext({ env }), {
      type: "audit.writer.process",
      input: [
        {
          type: "record-event",
          eventId: `admission-${surface}`,
          input: {
            sourceId: id,
            sourceSequence: 1,
            occurredAt: token.createdAt + 1,
            kind: "message",
            actorType: "agent",
            actorId: "main",
            runId: token.runId,
            direction: "outbound",
            channel: "qa-channel",
            conversationKind: "direct",
            ...(binding
              ? {
                  action: "message.outbound.finished",
                  status: "succeeded",
                  outcome: "sent",
                  resultCount: 1,
                  executionIdentityToken: token,
                }
              : {
                  action: "message.outbound.queued",
                  status: "started",
                  outcome: "queued",
                  resultCount: 0,
                }),
          },
        },
      ],
    });
    expect(result).toEqual([{ status: "settled" }]);
  }
}

it.each<Surface>(["roster", "profiles", "approval binding", "message progress", "message binding"])(
  "keeps prepared exec authority through the first %s operation after reopen",
  async (surface) => {
    const root = tempDirs.make("openclaw-exec-schema-admission-");
    const env = { OPENCLAW_STATE_DIR: root };
    vi.stubEnv("OPENCLAW_STATE_DIR", root);
    writeExecApprovalsConfigRow({
      db: state.openOpenClawStateDatabase({ env }).db,
      file: { version: 1, defaults: { security: "allowlist", ask: "on-miss" } },
    });
    if (surface === "message binding") {
      prepareExecutionIdentityContextAtAdmission(
        {
          runId: token.runId,
          agentId: "main",
          ingress: { kind: "local-cli", boundary: "agent-command.local", state: "present" },
          runtime: { kind: "embedded" },
        },
        {
          env,
          contextId: token.contextId,
          executionId: token.executionId,
          runtimeInstanceId: "integrity-runtime",
          now: token.createdAt,
        },
      );
    }
    await useFeature(surface, env, "prime");
    await state.closeOpenClawStateDatabaseAsync();
    const source = state.openOpenClawStateDatabase({ env });
    const before = source.db.prepare("PRAGMA schema_version").get();
    const assertCurrent = await commitExecAuthorizationLocked(
      currentPolicyExec("printf synthetic"),
    );
    expect(assertCurrent).not.toThrow();
    await useFeature(surface, env, "after-authorization");
    expect(source.db.prepare("PRAGMA schema_version").get()).toEqual(before);
    expect(assertCurrent).not.toThrow();
  },
);

it.skipIf(process.platform === "win32")(
  "launches once and joins cleanup after concurrent feature admission",
  async () => {
    const root = tempDirs.make("openclaw-exec-concurrent-feature-");
    const env = { OPENCLAW_STATE_DIR: root };
    vi.stubEnv("OPENCLAW_STATE_DIR", root);
    writeExecApprovalsConfigRow({
      db: state.openOpenClawStateDatabase({ env }).db,
      file: { version: 1, defaults: { security: "allowlist", ask: "on-miss" } },
    });
    const assertCurrent = await commitExecAuthorizationLocked(currentPolicyExec("printf synthetic"));
    // A different workflow uses this shared store while the command is prepared.
    await useFeature("profiles", env, "concurrent-launch-preparation");
    const marker = path.join(root, "executed.txt");
    const supervisor = createProcessSupervisor();
    const scopeKey = `integrity-${path.basename(root)}`;
    const closeScope = supervisor.acquireScopeCleanup(scopeKey, { processTree: "required-all" });
    let initiations = 0;
    try {
      const run = await supervisor.spawn({
        mode: "child",
        scopeKey,
        argv: [
          process.execPath,
          "-e",
          "require('node:fs').appendFileSync(process.argv[1], 'once\\n')",
          marker,
        ],
        cwd: root,
        stdinMode: "pipe-closed",
        timeoutMs: 10_000,
        initiateSpawn(launch) {
          assertCurrent();
          initiations += 1;
          return launch();
        },
      });
      expect(await run.wait()).toMatchObject({ reason: "exit", exitCode: 0 });
      await closeScope();
      expect(initiations).toBe(1);
      expect(fs.readFileSync(marker, "utf8")).toBe("once\n");
    } finally {
      supervisor.cancelScope(scopeKey);
      await closeScope();
      await supervisor.shutdown();
    }
  },
);
