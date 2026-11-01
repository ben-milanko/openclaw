import Foundation
import OpenClawKit
import XCTest
@preconcurrency import WebRTC
@testable import OpenClaw

@MainActor
final class TalkRealtimeVoiceSessionCleanupTests: XCTestCase {
    func testLogicalCloseDrainsThenUsesItsOriginalRoute() async throws {
        try await self.checkCleanup(orphan: false, replacement: nil)
    }

    func testOrphanCloseDrainsThenUsesItsOriginalRoute() async throws {
        try await self.checkCleanup(orphan: true, replacement: nil)
    }

    func testLogicalCloseCannotReachAReplacementGateway() async throws {
        try await self.checkCleanup(orphan: false, replacement: "gateway")
    }

    func testOrphanCloseCannotReachAReplacementGateway() async throws {
        try await self.checkCleanup(orphan: true, replacement: "gateway")
    }

    func testLogicalCloseCannotReachANewAccountAtTheSameHost() async throws {
        try await self.checkCleanup(orphan: false, replacement: "account")
    }

    func testOrphanCloseCannotReachANewAccountAtTheSameHost() async throws {
        try await self.checkCleanup(orphan: true, replacement: "account")
    }

    func testSuspendingBeforeManagerAdoptionCannotReachANewAccount() async throws {
        try await self.checkCleanup(orphan: false, replacement: "account", suspendBeforeAdoption: true)
    }

    func testStopCueRetainsRealtimeActivationOnlyUntilCompletionOrInterruption() async throws {
        // The audio session is process-global; exercise its exit paths sequentially.
        for exit in ["finished", "failed", "suspended", "restarted"] {
            let soundCues = RecordingTalkSoundCues()
            let manager = TalkModeManager(allowSimulatorCapture: true, soundCues: soundCues)
            defer { manager.stop() }
            try await self.activateDirectAudio(manager: manager)

            soundCues.playbackSucceeds = exit != "failed"
            manager.stop()
            XCTAssertFalse(manager.isListening)
            XCTAssertEqual(soundCues.played.last, .stopped)
            XCTAssertEqual(RTCAudioSession.sharedInstance().isActive, exit != "failed")
            switch exit {
            case "suspended":
                manager.suspendForBackground()
                XCTAssertNil(soundCues.currentCue)
            case "restarted":
                let oldCompletion = soundCues.onFinished
                manager._test_prepareEnabledRealtimeSessionForClose()
                await manager.start()
                XCTAssertTrue(manager.isListening)
                oldCompletion?()
                XCTAssertTrue(manager._test_audioSessionIsActive())
            default:
                soundCues.finish()
            }
            XCTAssertFalse(RTCAudioSession.sharedInstance().isActive)
        }
    }

    private func activateDirectAudio(manager: TalkModeManager) async throws {
        let session = manager._test_prepareDirectRealtimeSessionForListening()
        do {
            try await session.start(
                provider: "openai", model: "gpt-realtime-2", voice: "marin",
                supportsVoiceSelection: false,
                prefetchedSession: TalkRealtimeClientSession(
                    provider: "openai", transport: "webrtc", voiceSessionId: "synthetic-voice-session",
                    clientSecret: "synthetic-client-secret", offerUrl: "http://[", offerHeaders: nil,
                    model: "gpt-realtime-2", voice: "marin", expiresAt: nil, clientControl: nil))
            XCTFail("The invalid offer URL must stop before any provider request")
        } catch {
            let error = error as NSError
            XCTAssertEqual(error.domain, "TalkRealtimeWebRTC")
            XCTAssertEqual(error.code, 4)
        }
        // Exercise the production WebRTC activation, not just the manager's flag.
        XCTAssertTrue(RTCAudioSession.sharedInstance().isActive)
    }

    private func checkCleanup(
        orphan: Bool,
        replacement: String?,
        suspendBeforeAdoption: Bool = false) async throws
    {
        let gateway = GatewayNodeSession()
        let manager = TalkModeManager(allowSimulatorCapture: true)
        let originalRequests = VoiceCleanupRequests()
        let replacementRequests = VoiceCleanupRequests()
        let gate = VoiceCleanupFlushGate()
        let flushing = XCTestExpectation(description: "original transcript persistence is held")
        var cleanup: Task<Void, Never>?
        do {
            let originalRoute = try await connectTalkCleanupTestGateway(
                gateway, socket: Self.socket(recording: originalRequests))
            manager.attachGateway(gateway)
            manager.updateGatewayConnected(true)
            if suspendBeforeAdoption {
                manager._test_prepareLiveRealtimeVoiceSession(
                    gateway: gateway, route: originalRoute,
                    voiceSessionId: "voice-old", prefetchedVoiceSessionId: "voice-old",
                    adoptInManager: false)
                XCTAssertNil(manager._test_activeRealtimeVoiceSessionId())
                manager.isEnabled = true
            } else if !orphan {
                manager._test_preparePrefetchedRealtimeVoiceSession(
                    "voice-old", gateway: gateway, route: originalRoute)
            }
            manager._test_enqueueRealtimeTranscript(voiceSessionId: "voice-old") { _ in
                flushing.fulfill()
                await gate.wait()
            }
            let held = await XCTWaiter.fulfillment(of: [flushing], timeout: 5)
            XCTAssertEqual(held, .completed)
            if suspendBeforeAdoption {
                manager.suspendForBackground()
                XCTAssertEqual(manager._test_activeRealtimeVoiceSessionId(), "voice-old")
                // Keep capture disabled when the replacement route connects.
                manager.isEnabled = false
            }
            cleanup = orphan
                ? manager._test_closeOrphanedRealtimeVoiceSession(
                    gateway: gateway, route: originalRoute, voiceSessionId: "voice-old")
                : manager._test_closeLogicalRealtimeVoiceSessions()
            XCTAssertNotNil(cleanup)
            let earlyCloses = await originalRequests.snapshot()
            XCTAssertTrue(earlyCloses.isEmpty, "Close must wait for transcript persistence")

            if let replacement {
                manager.updateGatewayConnected(false)
                await gateway.disconnect()
                let newRoute = try await connectTalkCleanupTestGateway(
                    gateway,
                    socket: Self.socket(recording: replacementRequests),
                    host: replacement == "gateway" ? "replacement.invalid" : "talk-test.invalid",
                    token: "synthetic-replacement-account")
                XCTAssertNotEqual(newRoute, originalRoute)
                manager.updateGatewayConnected(true)
                manager._test_preparePrefetchedRealtimeVoiceSession(
                    "voice-new", gateway: gateway, route: newRoute)
            }
            let status = manager.statusText
            gate.release()
            await cleanup?.value
            cleanup = nil
            let originalCloses = await originalRequests.snapshot()
            let replacementCloses = await replacementRequests.snapshot()
            if replacement == nil {
                XCTAssertEqual(originalCloses, [["sessionKey": "main", "voiceSessionId": "voice-old"]])
                XCTAssertNil(manager._test_activeRealtimeVoiceSessionId())
            } else {
                XCTAssertTrue(originalCloses.isEmpty, "Retired routes cannot dispatch")
                XCTAssertTrue(replacementCloses.isEmpty, "Old cleanup cannot use the replacement account")
                XCTAssertEqual(manager._test_activeRealtimeVoiceSessionId(), "voice-new")
                XCTAssertTrue(manager._test_hasPrefetchedRealtimeSession())
            }
            XCTAssertEqual(manager.statusText, status)
            await manager._test_closeLogicalRealtimeVoiceSessions()?.value
            await gateway.disconnect()
        } catch {
            gate.release()
            await cleanup?.value
            await manager._test_closeLogicalRealtimeVoiceSessions()?.value
            await gateway.disconnect()
            throw error
        }
    }

    private static func socket(recording requests: VoiceCleanupRequests) -> GatewayTestWebSocketTask {
        GatewayTestWebSocketTask(sendHook: { socket, message, _ in
            guard GatewayWebSocketTestSupport.requestMethod(from: message) == "talk.client.close" else { return }
            let data: Data
            switch message {
            case let .data(value): data = value
            case let .string(value): data = Data(value.utf8)
            @unknown default: return
            }
            let frame = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
            try await requests.append(XCTUnwrap(frame["params"] as? [String: String]))
            let id = try XCTUnwrap(frame["id"] as? String)
            socket.emitReceiveSuccess(.data(GatewayWebSocketTestSupport.okResponseData(id: id)))
        })
    }
}

@MainActor
func connectTalkCleanupTestGateway(
    _ gateway: GatewayNodeSession,
    socket: GatewayTestWebSocketTask = GatewayTestWebSocketTask(),
    host: String = "talk-test.invalid",
    token: String = "synthetic-original-account") async throws -> GatewayNodeSessionRoute
{
    try await gateway.connect(
        url: XCTUnwrap(URL(string: "ws://\(host)")),
        credentials: .init(token: token),
        connectOptions: GatewayWebSocketTestSupport.identityFreeOperatorConnectOptions,
        sessionBox: WebSocketSessionBox(session: GatewayTestWebSocketSession(taskFactory: { socket })),
        onConnected: {}, onDisconnected: { _ in },
        onInvoke: { BridgeInvokeResponse(id: $0.id, ok: true) })
    let route = await gateway.currentRoute()
    return try XCTUnwrap(route)
}

@MainActor
private final class VoiceCleanupFlushGate {
    private var continuation: CheckedContinuation<Void, Never>?
    private var released = false

    func wait() async {
        guard !self.released else { return }
        await withCheckedContinuation { self.continuation = $0 }
    }

    func release() {
        self.released = true
        self.continuation?.resume()
        self.continuation = nil
    }
}

private actor VoiceCleanupRequests {
    private var requests: [[String: String]] = []
    func append(_ params: [String: String]) {
        self.requests.append(params)
    }

    func snapshot() -> [[String: String]] {
        self.requests
    }
}
