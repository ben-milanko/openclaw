import Observation
import SwiftUI

/// Presentation-only decision shared by the native archive entry points. The
/// Gateway's enabled-automation fact owns whether the action pauses workers.
@MainActor @Observable
public final class OpenClawChatScheduledArchiveConfirmation {
    public private(set) var sessions: [OpenClawChatSessionEntry] = []
    @ObservationIgnored private var action: (() -> Void)?

    public init() {}

    public var isPresented: Bool {
        !self.sessions.isEmpty
    }

    public var message: String {
        let names = self.sessions.map { ChatSessionSidebarModel.displayName(for: $0) }.joined(separator: "\n")
        return String(
            localized: "Archiving pauses the scheduled workers attached to these threads. Restoring a thread does not resume its workers; re-enable them in Automations.") +
            "\n\n" + names
    }

    public func request(sessions: [OpenClawChatSessionEntry], action: @escaping () -> Void) {
        let scheduled = sessions.filter { !$0.isArchived && $0.hasAutomation == true }
        guard !scheduled.isEmpty else { action()
            return
        }
        // A second click cannot silently replace the action being confirmed.
        guard !self.isPresented else { return }
        self.sessions = scheduled
        self.action = action
    }

    public func cancel() {
        self.action = nil
        self.sessions = []
    }

    public func confirm() {
        let action = self.action
        self.cancel()
        action?()
    }
}

private struct ChatScheduledArchiveConfirmationModifier: ViewModifier {
    @Bindable var confirmation: OpenClawChatScheduledArchiveConfirmation

    func body(content: Content) -> some View {
        content.confirmationDialog(
            "Pause scheduled workers and archive?",
            isPresented: Binding(
                get: { self.confirmation.isPresented },
                set: { if !$0 { self.confirmation.cancel() } }),
            titleVisibility: .visible)
        {
            Button(role: .destructive) { self.confirmation.confirm() } label: {
                Text("Pause Workers and Archive")
                    .font(OpenClawChatTypography.body)
            }
            Button(role: .cancel) { self.confirmation.cancel() } label: {
                Text("Cancel")
                    .font(OpenClawChatTypography.body)
            }
        } message: {
            Text(self.confirmation.message)
                .font(OpenClawChatTypography.body)
        }
    }
}

extension View {
    public func scheduledArchiveConfirmation(_ confirmation: OpenClawChatScheduledArchiveConfirmation) -> some View {
        self.modifier(ChatScheduledArchiveConfirmationModifier(confirmation: confirmation))
    }
}
