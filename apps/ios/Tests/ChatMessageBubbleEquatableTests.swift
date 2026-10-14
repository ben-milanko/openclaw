import SwiftUI
import Testing

@testable import OpenClawChatUI

@Suite("iOS completed chat bubble render gate")
@MainActor
struct ChatMessageBubbleEquatableTests {
    private static let sourceRevision = UUID(uuidString: "11111111-1111-1111-1111-111111111111")!

    @Test func `identical render inputs compare equal`() {
        let message = Self.message(text: "A completed answer with **reasoning**.")

        #expect(Self.bubble(message: message) == Self.bubble(message: message))
    }

    @Test func `message and presentation changes invalidate the gate`() {
        let original = Self.message(text: "Original answer")
        let changed = Self.message(text: "Changed answer", id: original.id)
        let baseline = Self.bubble(message: original)

        #expect(baseline != Self.bubble(message: changed))
        #expect(baseline != Self.bubble(message: original, displayOptions: .assistantTrace))
        #expect(baseline != Self.bubble(message: original, contextWindowTokens: 200_000))
        #expect(baseline != Self.bubble(message: original, resolverReady: false))
    }

    @Test func `completed footer and tool updates invalidate the gate`() {
        let message = Self.message(text: "Completed answer")
        let original = ChatMessageMetadata(timestamp: 1000, model: "model-a")
        let changed = ChatMessageMetadata(timestamp: 1000, model: "model-b")
        let baseline = Self.bubble(message: message, metadata: original)

        #expect(baseline != Self.bubble(message: message, metadata: changed))
        #expect(baseline != Self.bubble(message: message, metadata: nil))

        var tool = OpenClawChatPendingToolCall(
            toolCallId: "lookup", name: "web_search", args: nil, startedAt: 1000, isError: nil)
        tool.isComplete = true
        let withTool = Self.bubble(message: message, liveToolCalls: [tool])
        #expect(withTool.canUseIOSRenderGate)
        #expect(withTool != baseline)
        tool.runID = "new-run-owner"
        #expect(withTool != Self.bubble(message: message, liveToolCalls: [tool]))
    }

    @Test func `source cards invalidate for recorded preview or loading context changes`() throws {
        let message = Self.message(text: "See the [source](https://example.com/article).")
        let url = try #require(URL(string: "https://example.com/article"))
        let source = ChatSourcePreview(
            url: url, title: "Original title", domain: "example.com", excerpt: "Recorded excerpt", excerptKind: .page)
        let changed = ChatSourcePreview(
            url: url, title: "Updated title", domain: "example.com", excerpt: "Updated excerpt", excerptKind: .page)
        let baseline = Self.bubble(message: message, sourcePreviews: [source])

        #expect(baseline.canUseIOSRenderGate)
        #expect(baseline == Self.bubble(message: message, sourcePreviews: [source]))
        #expect(baseline != Self.bubble(message: message, sourcePreviews: [changed]))
        #expect(baseline != Self.bubble(message: message, sourcePreviews: [source], sourceContextRevision: UUID()))
        #expect(baseline != Self.bubble(message: message, sourcePreviews: [source], sourceFaviconsEnabled: true))
    }

    @Test func `render gate is limited to assistant bubbles without dynamic content`() {
        let assistant = Self.message(text: "Stable answer")
        let user = OpenClawChatMessage(
            role: "user",
            content: assistant.content,
            timestamp: 1)
        let audio = OpenClawChatMessage(
            role: "assistant",
            content: [OpenClawChatMessageContent(
                type: "audio",
                text: nil,
                mimeType: "audio/mpeg",
                fileName: "reply.mp3",
                content: nil)],
            timestamp: 1)
        let widget = OpenClawChatMessage(
            role: "assistant",
            content: assistant.content + [OpenClawChatMessageContent(type: "canvas", text: nil)],
            timestamp: 1)
        let commentary = OpenClawChatMessage(
            role: "assistant", content: assistant.content, timestamp: 1, phase: "commentary")
        let activeTool = OpenClawChatPendingToolCall(
            toolCallId: "active", name: "read", args: nil, startedAt: 1, isError: nil)

        #expect(Self.bubble(message: assistant).canUseIOSRenderGate)
        #expect(!Self.bubble(message: user).canUseIOSRenderGate)
        #expect(!Self.bubble(message: audio).canUseIOSRenderGate)
        #expect(!Self.bubble(message: widget).canUseIOSRenderGate)
        #expect(!Self.bubble(message: commentary).canUseIOSRenderGate)
        #expect(!Self.bubble(message: assistant, liveToolCalls: [activeTool]).canUseIOSRenderGate)
    }

    private static func message(text: String, id: UUID = UUID()) -> OpenClawChatMessage {
        OpenClawChatMessage(
            id: id,
            role: "assistant",
            content: [OpenClawChatMessageContent(
                type: "text",
                text: text,
                mimeType: nil,
                fileName: nil,
                content: nil)],
            timestamp: 1)
    }

    private static func bubble(
        message: OpenClawChatMessage,
        liveToolCalls: [OpenClawChatPendingToolCall] = [],
        metadata: ChatMessageMetadata? = nil,
        sourcePreviews: [ChatSourcePreview] = [],
        sourceContextRevision: UUID = sourceRevision,
        sourceFaviconsEnabled: Bool = false,
        displayOptions: OpenClawChatDisplayOptions = [],
        contextWindowTokens: Int? = nil,
        resolverReady: Bool = true) -> ChatMessageBubble
    {
        ChatMessageBubble(
            message: message,
            liveToolCalls: liveToolCalls,
            metadata: metadata,
            sourcePreviews: sourcePreviews,
            sourceContextRevision: sourceContextRevision,
            sourceFaviconsEnabled: sourceFaviconsEnabled,
            style: .standard,
            markdownVariant: .standard,
            userAccent: nil,
            displayOptions: displayOptions,
            assistantName: "OpenClaw",
            assistantAvatarText: "OC",
            assistantAvatarTint: nil,
            showsAssistantAvatar: false,
            isClean: true,
            contextWindowTokens: contextWindowTokens,
            userMessageExpanded: false,
            onToggleUserMessageExpanded: {},
            inlineWidgetResolverReady: resolverReady,
            inlineWidgetResourceResolver: { _, _ in nil },
            mediaArtifactResolverReady: resolverReady,
            mediaPlaybackAllowed: { true },
            loadMediaArtifact: { _, _, _ in nil })
    }
}
