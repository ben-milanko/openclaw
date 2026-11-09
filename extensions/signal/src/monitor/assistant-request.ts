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

/** Runs before core chooses either direct delivery or durable queue admission. */
export function filterSignalAssistantReply(payload: ReplyPayload): ReplyPayload | null {
  return payload.isError || isSilentReplyText(payload.text) ? null : payload;
}
