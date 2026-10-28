import { describe, expect, it } from "vitest";
import { resolveSourceReplyExpectation } from "./source-reply-delivery-mode.js";

describe("channel-owned reply expectation", () => {
  it.each(["direct", "group"])("allows silence for addressed %s requests", (ChatType) => {
    expect(
      resolveSourceReplyExpectation({
        ctx: {
          Provider: "signal",
          ChatType,
          WasMentioned: true,
          SourceReplyExpectation: "optional",
        },
        cfg: {},
      }),
    ).toBe("optional");
  });
  it.each(["direct", "group"])("preserves required addressed %s replies by default", (ChatType) => {
    expect(
      resolveSourceReplyExpectation({
        ctx: { Provider: "signal", ChatType, WasMentioned: true },
        cfg: {},
      }),
    ).toBe("required");
  });
});
