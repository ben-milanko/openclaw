import { readSessionTranscriptEvents } from "openclaw/plugin-sdk/session-transcript-runtime";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  castAgentMessage,
  makeAgentAssistantMessage,
  makeAgentUserMessage,
} from "openclaw/plugin-sdk/test-fixtures";
import { expect, it } from "vitest";
import { fingerprintCodexMirrorSourceMessage } from "./transcript-mirror-attestation.js";
import { mirror } from "./transcript-mirror-write.js";
import { createTranscriptMirrorTestHarness } from "./transcript-mirror.test-harness.js";
import { attachCodexMirrorIdentity } from "./upstream-prompt-provenance.js";

const { createSqliteMirrorTarget } = createTranscriptMirrorTestHarness();

function assistant(identity: string, text = "A synthetic terminal reply.") {
  return attachCodexMirrorIdentity(
    makeAgentAssistantMessage({ content: [{ type: "text", text }], timestamp: 4 }),
    identity,
  );
}

async function storedMessages(target: Parameters<typeof readSessionTranscriptEvents>[0]) {
  return (await readSessionTranscriptEvents(target)).flatMap((event) => {
    const message = asOptionalRecord(asOptionalRecord(event)?.message);
    return message ? [message] : [];
  });
}

it("persists a caller-correlated terminal answer without changing other mirror identities", async () => {
  const target = await createSqliteMirrorTarget("codex-native-talk-correlation-");
  const runId = "caller-run";
  const terminal = assistant("turn-1:assistant");
  const messages = [
    attachCodexMirrorIdentity(
      Object.assign(makeAgentUserMessage({ content: "Synthetic prompt", timestamp: 0 }), {
        idempotencyKey: `${runId}:user`,
      }),
      "turn-1:prompt",
    ),
    assistant("history:assistant", "A previously imported reply."),
    assistant("turn-1:commentary", "An intermediate update."),
    attachCodexMirrorIdentity(
      castAgentMessage({
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "read",
        content: [{ type: "toolResult", toolCallId: "call-1", content: "Synthetic result" }],
        timestamp: 3,
        __openclaw: { resultContentSource: "network" },
      }),
      "turn-1:tool-result:call-1",
    ),
    terminal,
  ];
  const params = {
    ...target,
    messages,
    idempotencyScope: "codex-app-server:thread-1",
    runId,
    runMirrorIdentityPrefix: "turn-1:",
    terminalAssistantOwner: { mirrorIdentity: "turn-1:assistant", runId },
  };

  await mirror(params);
  const persisted = await storedMessages(target);
  expect(persisted.map((message) => message.idempotencyKey)).toEqual([
    "caller-run:user",
    "codex-app-server:thread-1:history:assistant",
    "codex-app-server:thread-1:turn-1:commentary",
    "codex-app-server:thread-1:turn-1:tool-result:call-1",
    runId,
  ]);
  // This is the native Talk history predicate, which rejected provider-scoped keys.
  expect(
    persisted
      .filter((message) => message.role === "assistant" && message.idempotencyKey === runId)
      .map((message) => message.content),
  ).toEqual([[{ type: "text", text: "A synthetic terminal reply." }]]);
  expect(persisted.at(-1)).toMatchObject({
    __openclaw: {
      mirrorIdentity: "turn-1:assistant",
      mirrorOrigin: "codex-app-server",
      mirrorSourceFingerprint: fingerprintCodexMirrorSourceMessage(terminal),
      runId,
      runTerminal: true,
      turnTainted: true,
    },
  });
  expect(
    persisted.slice(0, -1).some((message) => asOptionalRecord(message["__openclaw"])?.runTerminal),
  ).toBe(false);

  await mirror(params);
  expect(await storedMessages(target)).toEqual(persisted);

  await mirror({
    ...params,
    messages: [assistant("turn-2:assistant", "The next caller's reply.")],
    runId: "second-caller-run",
    runMirrorIdentityPrefix: "turn-2:",
    terminalAssistantOwner: { mirrorIdentity: "turn-2:assistant", runId: "second-caller-run" },
  });
  expect((await storedMessages(target)).map((message) => message.idempotencyKey)).toEqual([
    ...persisted.map((message) => message.idempotencyKey),
    "second-caller-run",
  ]);
});

it("keeps provider keys when terminal caller ownership is absent or mismatched", async () => {
  const target = await createSqliteMirrorTarget("codex-native-talk-unowned-");
  type Ownership = Pick<
    Parameters<typeof mirror>[0],
    "runId" | "runMirrorIdentityPrefix" | "terminalAssistantOwner"
  >;
  const cases: Ownership[] = [
    { runId: "run-0", runMirrorIdentityPrefix: "turn-0:" },
    {
      runId: "run-1",
      terminalAssistantOwner: { mirrorIdentity: "turn-1:assistant", runId: "another-run" },
    },
    {
      runId: "run-2",
      terminalAssistantOwner: { mirrorIdentity: "turn-2:other", runId: "run-2" },
    },
    {
      runId: "run-3",
      runMirrorIdentityPrefix: "another-turn:",
      terminalAssistantOwner: { mirrorIdentity: "turn-3:assistant", runId: "run-3" },
    },
    { terminalAssistantOwner: { mirrorIdentity: "turn-4:assistant", runId: "run-4" } },
  ];
  for (const [index, ownership] of cases.entries()) {
    await mirror({
      ...target,
      ...ownership,
      messages: [assistant(`turn-${index}:assistant`)],
      idempotencyScope: "codex-app-server:thread-1",
    });
  }
  expect((await storedMessages(target)).map((message) => message.idempotencyKey)).toEqual(
    cases.map((_, index) => `codex-app-server:thread-1:turn-${index}:assistant`),
  );
});
