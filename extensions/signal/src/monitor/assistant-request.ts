import { isSilentReplyText, type ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";

/** Match authored text only, never quotes, attachment text, or native human mentions. */
export function isSignalAssistantRequest(text: string, prefixes: readonly string[]): boolean {
  const body = text.trimStart().toLowerCase();
  return prefixes.some((prefix) => {
    const address = prefix.trim().toLowerCase();
    return (
      address.length > 1 &&
      /[:,]$/u.test(address) &&
      body.startsWith(address) &&
      body.slice(address.length).trim().length > 0
    );
  });
}

/** Runs before response prefixing and again at direct/durable delivery admission. */
export function filterSignalAssistantReply(payload: ReplyPayload): ReplyPayload | null {
  return payload.isError || isSilentReplyText(payload.text) ? null : payload;
}
