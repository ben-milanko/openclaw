import { describe, expect, it } from "vitest";
import { createSourceReplyDeliveryRuntime } from "./source-reply-delivery-runtime.js";

describe("source-reply context projection", () => {
  it("keeps the producer annotation current when prepared delivery guidance changes", () => {
    const projection = {
      extraSystemPrompt: "Metadata\n\nAutomatic delivery\n\nConfigured policy\n\nLater addition",
      extraSystemPromptTurnContext: { start: 0, text: "Metadata\n\nAutomatic delivery" },
    };
    const runtime = createSourceReplyDeliveryRuntime({
      origin: "runtime_default",
      initialMode: "automatic",
      projections: [projection],
      promptComponentByMode: {
        automatic: "Automatic delivery",
        message_tool_only: "Message-tool delivery",
      },
      promptComponentOffset: 10,
    });
    runtime.applyPreparedMode(projection, "message_tool_only");
    expect(projection.extraSystemPrompt).toBe(
      "Metadata\n\nMessage-tool delivery\n\nConfigured policy\n\nLater addition",
    );
    expect(projection.extraSystemPromptTurnContext).toEqual({
      start: 0,
      text: "Metadata\n\nMessage-tool delivery",
    });
  });

  it("does not repair a stale producer annotation into authority to remove policy", () => {
    const projection = {
      extraSystemPrompt: "Metadata\n\nAutomatic delivery\n\nConfigured policy",
      extraSystemPromptTurnContext: { start: 0, text: "Outdated metadata" },
    };
    const runtime = createSourceReplyDeliveryRuntime({
      origin: "runtime_default",
      initialMode: "automatic",
      projections: [projection],
      promptComponentByMode: {
        automatic: "Automatic delivery",
        message_tool_only: "Message-tool delivery",
      },
      promptComponentOffset: 10,
    });
    runtime.applyPreparedMode(projection, "message_tool_only");
    expect(projection.extraSystemPromptTurnContext).toBeUndefined();
    expect(projection.extraSystemPrompt).toBe(
      "Metadata\n\nMessage-tool delivery\n\nConfigured policy",
    );
  });
});
