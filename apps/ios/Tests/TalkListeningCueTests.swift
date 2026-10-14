import AVFAudio
import Foundation
import Testing
@testable import OpenClaw

@MainActor
struct TalkListeningCueTests {
    @Test func `direct ready cue waits for audio and control connections`() {
        for iceConnectsFirst in [true, false] {
            let manager = TalkModeManager(allowSimulatorCapture: true)
            var cues = 0
            manager._test_setListeningCueHandler { cues += 1 }
            let session = manager._test_prepareDirectRealtimeSessionForListening()

            // The transport's optimistic post-SDP status cannot invite speech yet.
            manager.realtimeSession(session, didChangeStatus: "Listening")
            #expect(manager.phase == .connecting)
            #expect(!manager.isListening)
            #expect(manager.canKeepContinuousTalkActiveInBackground)
            #expect(cues == 0)

            session._test_observeReadiness(
                iceConnected: iceConnectsFirst,
                dataChannelOpen: !iceConnectsFirst)
            manager.realtimeSession(session, didChangeStatus: "Listening")
            #expect(manager.phase == .connecting)
            #expect(!manager.isListening)
            #expect(cues == 0)

            session._test_observeReadiness(iceConnected: true, dataChannelOpen: true)
            manager.realtimeSession(session, didChangeStatus: "Listening")
            #expect(manager.phase == .listening)
            #expect(manager.isListening)
            #expect(cues == 1)
            manager.realtimeSession(session, didChangeStatus: "Listening")
            #expect(cues == 1)
            manager.stop()
        }
    }

    @Test func `stopping before direct readiness cannot play a late cue`() {
        let manager = TalkModeManager(allowSimulatorCapture: true)
        var cues = 0
        manager._test_setListeningCueHandler { cues += 1 }
        let session = manager._test_prepareDirectRealtimeSessionForListening()

        manager.stop()
        session._test_observeReadiness(iceConnected: true, dataChannelOpen: true)
        manager.realtimeSession(session, didChangeStatus: "Listening")
        #expect(!session.isReady)
        #expect(manager.phase == .idle)
        #expect(!manager.isListening)
        #expect(cues == 0)
    }

    @Test func `continuous ready cue fires once per listening transition`() {
        let manager = TalkModeManager(allowSimulatorCapture: true)
        var cues = 0
        manager._test_setListeningCueHandler { cues += 1 }
        manager._test_prepareEnabledRealtimeSessionForClose()

        manager._test_handleRealtimeRelayStatus("Connecting")
        #expect(cues == 0)
        manager._test_handleRealtimeRelayStatus("Listening (Realtime)")
        #expect(cues == 1)
        manager._test_handleRealtimeRelayStatus("Listening (Realtime)")
        manager._test_handleRealtimeRelayStatus("Listening")
        #expect(cues == 1)
        manager._test_handleRealtimeRelayStatus("Speaking")
        manager._test_handleRealtimeRelayStatus("Listening")
        #expect(cues == 2)

        manager.stop()
        manager._test_handleRealtimeRelayStatus("Listening (Realtime)")
        #expect(cues == 2)
    }

    @Test func `push to talk does not play the continuous ready cue`() {
        let manager = TalkModeManager(allowSimulatorCapture: true)
        var cues = 0
        manager._test_setListeningCueHandler { cues += 1 }
        manager._test_prepareEnabledRealtimeSessionForClose()

        #expect(manager._test_realtimeStatusPreservesPushToTalkCapture())
        #expect(cues == 0)
    }

    @Test func `bundled ready cue is a short decodable audio clip`() throws {
        let url = try #require(Bundle.main.url(
            forResource: "talk-listening", withExtension: "wav", subdirectory: "Audio"))
        let player = try AVAudioPlayer(contentsOf: url)
        #expect(player.duration > 0.1)
        #expect(player.duration < 0.3)
        #expect(player.numberOfChannels == 1)
    }
}
