#if canImport(SwiftUI)
import Foundation
import Testing
@testable import OpenClawChatUI

@MainActor
struct ChatScheduledArchiveConfirmationTests {
    @Test func `decoded automation binding requires an explicit archive decision`() throws {
        let row = try JSONDecoder().decode(
            OpenClawChatSessionEntry.self,
            from: Data(
                #"{"key":"agent:main:review","sessionId":"review-id","label":"Scheduled review","hasAutomation":true}"#
                    .utf8))
        let confirmation = OpenClawChatScheduledArchiveConfirmation()
        var archives = 0
        confirmation.request(sessions: [row]) { archives += 1 }
        #expect(archives == 0)
        #expect(confirmation.isPresented)
        #expect(confirmation.message.contains("Scheduled review"))
        confirmation.cancel()
        #expect(archives == 0)
        #expect(!confirmation.isPresented)
        confirmation.request(sessions: [row]) { archives += 1 }
        confirmation.confirm()
        confirmation.confirm()
        #expect(archives == 1)
        #expect(!confirmation.isPresented)
    }

    @Test func `ordinary and restored threads do not warn`() {
        let confirmation = OpenClawChatScheduledArchiveConfirmation()
        var archives = 0
        confirmation.request(sessions: [.init(key: "ordinary")]) { archives += 1 }
        confirmation.request(sessions: [.init(key: "restored", archived: true, hasAutomation: true)]) { archives += 1 }
        #expect(archives == 2)
        #expect(!confirmation.isPresented)
    }
}
#endif
