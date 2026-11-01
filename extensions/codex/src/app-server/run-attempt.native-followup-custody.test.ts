import assert from "node:assert/strict";
import path from "node:path";
import {
  invokeNativeHookRelay,
  nativeHookRelayTesting,
  onAgentEvent,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { initializeGlobalHookRunner } from "openclaw/plugin-sdk/hook-runtime";
import { loadNodeExecAvailability } from "openclaw/plugin-sdk/node-selection-runtime";
import {
  createAdmittedHostCapabilityTestFixture,
  createMockPluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { expect, it, vi } from "vitest";
import { readAttemptTerminal } from "./attempt-terminal.test-helper.js";
import {
  isCodexAppServerLiveThreadClaimed,
  isCodexAppServerLiveThreadProtected,
} from "./client-runtime.js";
import { CODEX_INFERENCE_GENERATION_KEY } from "./inference-context.js";
import { getCodexInferenceThread, ownCodexInferenceClient } from "./inference-routing.js";
import { nativeHookRelayUnregisterQueue } from "./native-hook-relay-state.js";
import { CodexNativeSubagentCompletionDelivery } from "./native-subagent-completion-delivery.js";
import { defaultNativeSubagentMonitorRuntime } from "./native-subagent-monitor-runtime.js";
import { isJsonObject, type CodexServerNotification, type JsonObject } from "./protocol.js";
import {
  createTestParams,
  createCodexRuntimePlanFixture,
  createStartedThreadHarness,
  extractRelayIdFromThreadRequest,
  runCodexAppServerAttempt,
  setCodexTestModelSupportsTools,
  setupRunAttemptTestHooks,
  tempDir,
  threadStartResult,
  turnStartResult,
} from "./run-attempt-test-harness.js";
import { attachSqliteSessionTarget } from "./sqlite-session.test-helpers.js";

setupRunAttemptTestHooks();
vi.mock("openclaw/plugin-sdk/node-selection-runtime", { spy: true });

it.each(["delayed-success", "opaque-steer", "wait-before-admission", "yield-receipt"] as const)(
  "preserves accepted follow-up through sessions_yield (%s)",
  async (scenario) => {
    // Keep discovery off ambient Gateway I/O while using the real admitted host and monitor.
    vi.mocked(loadNodeExecAvailability).mockResolvedValue({
      cacheKey: "[]",
      isAvailable: () => false,
    });
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const childThreadId = `custody-${scenario}`;
    const waiterThreadId = `${childThreadId}-waiter`;
    const turnB = `${childThreadId}-turn-b`;
    const runB = `codex-thread:${childThreadId}:turn:${turnB}`;
    const accepted = scenario !== "opaque-steer";
    const executionEvents: Array<Parameters<Parameters<typeof onAgentEvent>[0]>[0]> = [];
    const unsubscribe = onAgentEvent((event) => {
      if (event.runId === `codex-thread:${waiterThreadId}` && event.stream === "execution") {
        executionEvents.push(event);
      }
    });
    let waitAfterAdmission: unknown;
    let claimedAfterStart: boolean | undefined;
    const harness = createStartedThreadHarness();
    const lifetime = new AbortController();
    const params = createTestParams();
    params.abortSignal = lifetime.signal;
    await attachSqliteSessionTarget(params, path.join(tempDir, "sessions.json"), "custody-session");
    params.runtimePlan = createCodexRuntimePlanFixture();
    setCodexTestModelSupportsTools(params, true);
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_tool_call", handler: async () => undefined }]),
    );
    const host = await createAdmittedHostCapabilityTestFixture(params, {
      nativeModelPolicySupport: "exact",
    });
    assert(host.agentHarnessCompletionScope, "Expected an admitted completion scope");
    params.hostCapabilities = host.hostCapabilities;
    params.agentHarnessCompletionScope = host.agentHarnessCompletionScope;
    const delivery = vi
      .spyOn(defaultNativeSubagentMonitorRuntime, "deliverAgentHarnessCompletion")
      .mockResolvedValue({ delivered: true, path: "direct" });
    const attempts = new Set<Promise<void>>();
    // Invoked with .call(this, ...) to preserve the observed instance as receiver.
    // oxlint-disable-next-line typescript/unbound-method
    const originalDelivery = CodexNativeSubagentCompletionDelivery.prototype.deliverPending;
    const observeAttempt = vi.spyOn(
      CodexNativeSubagentCompletionDelivery.prototype,
      "deliverPending",
    );
    observeAttempt.mockImplementation(function (
      this: CodexNativeSubagentCompletionDelivery,
      state,
      child,
    ) {
      const attempt = originalDelivery.call(this, state, child);
      attempts.add(attempt);
      return attempt;
    });
    const settleCompletionAttempts = async () => {
      // Receipts settle independently of notification dispatch; join their owner before assertions.
      while (attempts.size > 0) {
        const pending = [...attempts];
        attempts.clear();
        await Promise.all(pending);
      }
    };
    const notify = (method: string, notificationParams: JsonObject) =>
      harness.notify({ method, params: notificationParams } as CodexServerNotification);
    const parentItem = (item: JsonObject, method = "item/completed") =>
      notify(method, { threadId: "thread-1", turnId: "turn-1", item });
    const collab = (id: string, tool: string, threadId: string, extra: JsonObject = {}) =>
      parentItem({
        id,
        type: "collabAgentToolCall",
        tool,
        status: "completed",
        senderThreadId: "thread-1",
        receiverThreadIds: [threadId],
        ...extra,
      });
    const spawn = async (threadId: string) => {
      await notify("thread/started", {
        thread: {
          id: threadId,
          parentThreadId: "thread-1",
          source: { subAgent: { thread_spawn: { parent_thread_id: "thread-1", depth: 1 } } },
        },
      });
      await collab(`spawn-${threadId}`, "spawnAgent", threadId);
    };
    const turn = (threadId: string, id: string, result?: string) =>
      notify(result === undefined ? "turn/started" : "turn/completed", {
        threadId,
        turn: {
          id,
          status: result === undefined ? "inProgress" : "completed",
          error: null,
          items:
            result === undefined
              ? []
              : [{ type: "agentMessage", id: `result-${id}`, phase: "final_answer", text: result }],
        },
      });
    const run = runCodexAppServerAttempt(params, {
      nativeHookRelay: { enabled: true, events: ["pre_tool_use"] },
    });
    try {
      await run.waitForTurnAccepted();
      const relayId = extractRelayIdFromThreadRequest(
        harness.requests.find((request) => request.method === "thread/start")?.params,
      );
      await spawn(childThreadId);
      await turn(childThreadId, "turn-a");
      await turn(childThreadId, "turn-a", "A result");
      await collab("wait-a", "wait", childThreadId, {
        agentsStates: { [childThreadId]: { status: "completed", message: "A result" } },
      });
      await settleCompletionAttempts();
      // A is complete and B is not admitted yet; a running sibling authorizes sessions_yield.
      await spawn(waiterThreadId);
      await turn(waiterThreadId, "waiter-turn");
      if (scenario === "wait-before-admission") {
        await turn(childThreadId, turnB);
        await notify("item/started", {
          threadId: waiterThreadId,
          turnId: "waiter-turn",
          item: {
            id: "wait-b",
            type: "collabAgentToolCall",
            tool: "wait",
            status: "inProgress",
            senderThreadId: waiterThreadId,
            receiverThreadIds: [childThreadId],
          },
        });
      }
      await collab("submit-b", "sendInput", childThreadId);
      await parentItem(
        {
          type: "function_call_output",
          call_id: "submit-b",
          output: JSON.stringify({ submission_id: accepted ? turnB : `opaque-${turnB}` }),
        },
        "rawResponseItem/completed",
      );
      if (scenario === "wait-before-admission") {
        waitAfterAdmission = structuredClone(executionEvents.at(-1)?.data);
      }
      const yieldResponse = await harness.handleServerRequest({
        id: "yield-parent",
        method: "item/tool/call",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          callId: "yield-parent",
          namespace: null,
          tool: "sessions_yield",
          arguments: { message: "Waiting for follow-up B" },
        },
      });
      expect(yieldResponse).toMatchObject({ success: true });
      if (scenario === "yield-receipt") {
        // The native receipt queues input without starting another parent turn.
        // Keep teardown open after the real yield has been accepted.
        await turn(childThreadId, turnB);
        claimedAfterStart = isCodexAppServerLiveThreadClaimed(harness.client, childThreadId);
        await parentItem(
          {
            type: "agent_message",
            author: childThreadId,
            recipient: "/root",
            content: [
              {
                type: "input_text",
                text: `Message Type: FINAL_ANSWER\nTask name: /root\nSender: ${childThreadId}\nPayload:\nB result`,
              },
            ],
          },
          "rawResponseItem/completed",
        );
        await turn(childThreadId, turnB, "B result");
      }
      await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
      expect(readAttemptTerminal(await run)).toMatchObject({ aborted: false, promptError: null });
      await nativeHookRelayUnregisterQueue.flush();
      host.closeHost();
      host.closeAdmission();
      if (scenario !== "wait-before-admission" && scenario !== "yield-receipt") {
        await turn(childThreadId, turnB);
      }
      if (scenario !== "yield-receipt") {
        claimedAfterStart = isCodexAppServerLiveThreadClaimed(harness.client, childThreadId);
      }
      if (accepted) {
        await turn(childThreadId, turnB, "B result");
        await turn(childThreadId, turnB, "B result");
      } else {
        await expect(
          invokeNativeHookRelay(
            {
              provider: "codex",
              relayId,
              event: "pre_tool_use",
              rawPayload: {
                agent_id: childThreadId,
                tool_name: "Bash",
                tool_input: { command: "unaccepted-followup" },
              },
            },
            AbortSignal.timeout(1_000),
          ),
        ).rejects.toThrow(/retained|inactive|not found|admission/);
      }
      await turn(waiterThreadId, "waiter-turn", "Waiter result");
      await nativeHookRelayUnregisterQueue.flush();
      await settleCompletionAttempts();
      const followupDeliveries = delivery.mock.calls.filter(
        ([call]) => call.childSessionKey === runB,
      );
      if (accepted) {
        expect
          .soft(followupDeliveries)
          .toEqual([[expect.objectContaining({ childSessionKey: runB, result: "B result" })]]);
      } else {
        expect.soft(followupDeliveries).toHaveLength(0);
      }
      expect.soft(claimedAfterStart).toBe(accepted);
      if (scenario === "wait-before-admission") {
        expect.soft(waitAfterAdmission).toMatchObject({
          state: "waiting",
          wait: { kind: "children", dependencies: [{ runId: runB }], pendingCount: 1 },
        });
      }
      expect.soft(isCodexAppServerLiveThreadClaimed(harness.client, childThreadId)).toBe(false);
      expect
        .soft(Boolean(nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(relayId)))
        .toBe(false);
    } finally {
      unsubscribe();
      lifetime.abort("test_cleanup");
      try {
        harness.close();
        // Join cleanup before flushing relay retirement or releasing the admitted host.
        await Promise.allSettled([run]);
        await settleCompletionAttempts();
        await nativeHookRelayUnregisterQueue.flush();
      } finally {
        observeAttempt.mockRestore();
        try {
          host.closeHost();
        } finally {
          host.closeAdmission();
        }
      }
    }
  },
);

it("continues a yielded parent across turn context changes and delivers its child once", async () => {
  vi.mocked(loadNodeExecAvailability).mockResolvedValue({
    cacheKey: "[]",
    isAvailable: () => false,
  });
  initializeGlobalHookRunner(
    createMockPluginRegistry([{ hookName: "before_tool_call", handler: async () => undefined }]),
  );
  const turnContexts = {
    "run-1": "Synthetic Talk context: reply to the current speaker.",
    "run-2": "Synthetic direct chat context: reply to the current user message.",
    "run-heartbeat": "Synthetic heartbeat context: check the standing commitments.",
    "run-completion": "Synthetic completion context: deliver the waiting child's result.",
  };
  const persistentPolicy = "Synthetic configured policy: preserve native child instructions.";
  let currentRunId: keyof typeof turnContexts = "run-1";
  const receivedContexts: string[] = [];
  const completionTurnStarted = createDeferred<{
    run: ReturnType<typeof runCodexAppServerAttempt>;
  }>();
  const interrupts = new Map<string, ReturnType<typeof createDeferred<void>>>();
  const delivery = vi
    .spyOn(defaultNativeSubagentMonitorRuntime, "deliverAgentHarnessCompletion")
    .mockImplementation(async (event) => {
      if (event.childSessionKey === "codex-thread:child-running") {
        try {
          completionTurnStarted.resolve(await startTurn("run-completion"));
        } catch (error) {
          completionTurnStarted.reject(error);
          throw error;
        }
      }
      return { delivered: true, path: "direct" };
    });
  const turns: string[] = [];
  const harness = createStartedThreadHarness(
    async (method, request) => {
      if (method === "turn/interrupt" && isJsonObject(request)) {
        assert(typeof request.turnId === "string");
        interrupts.get(request.turnId)?.resolve();
        return {};
      }
      if (method === "account/read") {
        return { account: { type: "apiKey" } };
      }
      if (method === "thread/resume") {
        return threadStartResult();
      }
      if (method === "turn/start") {
        const route = getCodexInferenceThread(harness.client, "thread-1");
        assert(route && isJsonObject(request) && isJsonObject(request.responsesapiClientMetadata));
        const generation = request.responsesapiClientMetadata[CODEX_INFERENCE_GENERATION_KEY];
        assert(typeof generation === "string");
        const threadRequest = harness.requests.find(
          ({ method: requestMethod }) => requestMethod === "thread/start",
        );
        assert(isJsonObject(threadRequest?.params));
        assert(typeof threadRequest.params.developerInstructions === "string");
        const nativeBody = { instructions: threadRequest.params.developerInstructions, input: [] };
        expect(nativeBody.instructions).toContain(persistentPolicy);
        for (const context of Object.values(turnContexts)) {
          expect(nativeBody.instructions).not.toContain(context);
        }
        const metadata = { requestKind: "turn" as const, threadId: "thread-1", generation };
        const prepared = route.context.prepare(nativeBody, metadata);
        prepared.assertCurrent();
        assert(typeof prepared.body.instructions === "string");
        receivedContexts.push(prepared.body.instructions);
        expect(prepared.body.instructions).toContain(turnContexts[currentRunId]);
        for (const [runId, context] of Object.entries(turnContexts)) {
          if (runId !== currentRunId) {
            expect(prepared.body.instructions).not.toContain(context);
          }
        }
        // Per-message routing and heartbeat context must not enter child inference.
        expect(
          route.context.prepare(nativeBody, {
            ...metadata,
            threadId: "child-running",
            parentThreadId: "thread-1",
          }).body,
        ).toBe(nativeBody);
        turns.push(`turn-${turns.length + 1}`);
        return turnStartResult(turns.at(-1));
      }
      return undefined;
    },
    { persistedThreads: [] },
  );
  ownCodexInferenceClient(harness.client);
  const notify = (method: string, params: JsonObject) =>
    harness.notify({ method, params } as CodexServerNotification);
  const childTurn = (threadId: string, result?: string) =>
    notify(result === undefined ? "turn/started" : "turn/completed", {
      threadId,
      turn: {
        id: `${threadId}-turn`,
        status: result === undefined ? "inProgress" : "completed",
        error: null,
        items:
          result === undefined
            ? []
            : [
                {
                  type: "agentMessage",
                  id: `${threadId}-result`,
                  phase: "final_answer",
                  text: result,
                },
              ],
      },
    });
  const spawn = async (threadId: string) => {
    await notify("thread/started", {
      thread: {
        id: threadId,
        parentThreadId: "thread-1",
        source: { subAgent: { thread_spawn: { parent_thread_id: "thread-1", depth: 1 } } },
      },
    });
    await notify("item/completed", {
      threadId: "thread-1",
      turnId: turns.at(-1)!,
      item: {
        id: `spawn-${threadId}`,
        type: "collabAgentToolCall",
        tool: "spawnAgent",
        status: "completed",
        senderThreadId: "thread-1",
        receiverThreadIds: [threadId],
      },
    });
    await childTurn(threadId);
  };
  const hosts: Array<Awaited<ReturnType<typeof createAdmittedHostCapabilityTestFixture>>> = [];
  const startTurn = async (runId: keyof typeof turnContexts) => {
    currentRunId = runId;
    const params = createTestParams();
    params.runId = runId;
    params.trigger =
      runId === "run-heartbeat" ? "heartbeat" : runId === "run-completion" ? "event" : "user";
    params.extraSystemPrompt = `${turnContexts[runId]}\n\n${persistentPolicy}`;
    params.extraSystemPromptTurnContext = { start: 0, text: turnContexts[runId] };
    // First managed-route preparation includes the real native-policy workers.
    params.timeoutMs = 60_000;
    await attachSqliteSessionTarget(params, path.join(tempDir, "sessions.json"), "yield-session");
    params.runtimePlan = createCodexRuntimePlanFixture();
    setCodexTestModelSupportsTools(params, true);
    const host = await createAdmittedHostCapabilityTestFixture(params, {
      nativeModelPolicySupport: "exact",
    });
    hosts.push(host);
    assert(host.agentHarnessCompletionScope, "Expected an admitted completion scope");
    params.hostCapabilities = host.hostCapabilities;
    params.agentHarnessCompletionScope = host.agentHarnessCompletionScope;
    const run = runCodexAppServerAttempt(params, {
      nativeHookRelay: { enabled: true, events: ["pre_tool_use"] },
    });
    await run.waitForTurnAccepted();
    // Wrapped so awaiting the accepted turn does not also await the attempt.
    return { run };
  };
  const completeTurn = async (
    { run }: Awaited<ReturnType<typeof startTurn>>,
    interrupted = false,
  ) => {
    await notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: turns.at(-1)!, status: interrupted ? "interrupted" : "completed", items: [] },
    });
    expect(readAttemptTerminal(await run)).toMatchObject({ aborted: false, promptError: null });
    await nativeHookRelayUnregisterQueue.flush();
  };
  const yieldTurn = async () => {
    const interrupted = createDeferred<void>();
    interrupts.set(turns.at(-1)!, interrupted);
    const callId = `yield-${turns.at(-1)}`;
    const response = (await harness.handleServerRequest({
      id: callId,
      method: "item/tool/call",
      params: {
        threadId: "thread-1",
        turnId: turns.at(-1)!,
        callId,
        namespace: null,
        tool: "sessions_yield",
        arguments: { message: "Waiting for children" },
      },
    })) as { success: boolean; contentItems: Array<{ text: string }> };
    assert(
      response.success,
      response.contentItems[0]?.text ?? "Expected sessions_yield to succeed",
    );
    const result = JSON.parse(response.contentItems[0]!.text) as Record<string, unknown>;
    if (result.status === "yielded") {
      await interrupted.promise;
    }
    return result;
  };

  try {
    // The first turn spawns two native children, one finishes, and the turn yields.
    const first = await startTurn("run-1");
    await spawn("child-settled");
    await childTurn("child-settled", "Settled result");
    await spawn("child-running");
    expect(await yieldTurn()).toMatchObject({ status: "yielded" });
    await completeTurn(first, true);
    // The finished child's detached delivery settles it once its parent turn ends.
    await vi.waitFor(() =>
      expect(delivery).toHaveBeenCalledWith(
        expect.objectContaining({ childSessionKey: "codex-thread:child-settled" }),
      ),
    );
    expect(isCodexAppServerLiveThreadProtected(harness.client, "thread-1")).toBe(true);
    expect(isCodexAppServerLiveThreadClaimed(harness.client, "thread-1")).toBe(false);

    // A later turn owns no new claim, yet the still-running child will resume the session.
    const second = await startTurn("run-2");
    const result = await yieldTurn();
    expect(result).toMatchObject({
      status: "already_pending",
      pendingChildren: [
        {
          runId: "codex-thread:child-running",
          childSessionKey: "codex-thread:child-running",
          state: "running",
          wakeArmed: false,
        },
      ],
    });
    expect(result.pendingChildren).toHaveLength(1);
    await completeTurn(second);

    await completeTurn(await startTurn("run-heartbeat"));
    expect(isCodexAppServerLiveThreadProtected(harness.client, "thread-1")).toBe(true);
    await childTurn("child-running", "Running child's final result");
    await completeTurn(await completionTurnStarted.promise);
    await childTurn("child-running", "Running child's final result");
    expect(
      delivery.mock.calls.filter(
        ([event]) => event.childSessionKey === "codex-thread:child-running",
      ),
    ).toHaveLength(1);
    expect(receivedContexts).toHaveLength(4);
    const nativeStart = harness.requests.find(({ method }) => method === "thread/start");
    for (const context of Object.values(turnContexts)) {
      expect(JSON.stringify(nativeStart?.params)).not.toContain(context);
    }
    // Context changes reuse the exact protected parent, never resubscribe or replace it.
    expect(
      harness.requests.filter(({ method }) =>
        ["thread/start", "thread/resume", "thread/unsubscribe"].includes(method),
      ),
    ).toEqual([{ method: "thread/start", params: expect.anything() }]);
  } finally {
    harness.close();
    for (const host of hosts) {
      host.closeHost();
      host.closeAdmission();
    }
  }
});
