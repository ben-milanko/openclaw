import AVFAudio
import Foundation
import Testing
@testable import OpenClaw

@MainActor
struct TalkListeningCueTests {
    @Test func `direct ready cue waits for audio and control connections`() {
        for iceConnectsFirst in [true, false] {
            let soundCues = RecordingTalkSoundCues()
            let manager = TalkModeManager(allowSimulatorCapture: true, soundCues: soundCues)
            let session = manager._test_prepareDirectRealtimeSessionForListening()

            // The transport's optimistic post-SDP status cannot invite speech yet.
            manager.realtimeSession(session, didChangeStatus: "Listening")
            #expect(manager.phase == .connecting)
            #expect(!manager.isListening)
            #expect(manager.canKeepContinuousTalkActiveInBackground)
            #expect(soundCues.listeningCount == 0)

            session._test_observeReadiness(
                iceConnected: iceConnectsFirst,
                dataChannelOpen: !iceConnectsFirst)
            manager.realtimeSession(session, didChangeStatus: "Listening")
            #expect(manager.phase == .connecting)
            #expect(!manager.isListening)
            #expect(soundCues.listeningCount == 0)

            session._test_observeReadiness(iceConnected: true, dataChannelOpen: true)
            manager.realtimeSession(session, didChangeStatus: "Listening")
            #expect(manager.phase == .listening)
            #expect(manager.isListening)
            #expect(soundCues.listeningCount == 1)
            manager.realtimeSession(session, didChangeStatus: "Listening")
            #expect(soundCues.listeningCount == 1)
            manager.stop()
        }
    }

    @Test func `stopping before direct readiness cannot play a late cue`() {
        let soundCues = RecordingTalkSoundCues()
        let manager = TalkModeManager(allowSimulatorCapture: true, soundCues: soundCues)
        let session = manager._test_prepareDirectRealtimeSessionForListening()

        manager.stop()
        session._test_observeReadiness(iceConnected: true, dataChannelOpen: true)
        manager.realtimeSession(session, didChangeStatus: "Listening")
        #expect(!session.isReady)
        #expect(manager.phase == .idle)
        #expect(!manager.isListening)
        #expect(soundCues.listeningCount == 0)
    }

    @Test func `continuous ready cue fires once per listening transition`() {
        let soundCues = RecordingTalkSoundCues()
        let manager = TalkModeManager(allowSimulatorCapture: true, soundCues: soundCues)
        manager._test_prepareEnabledRealtimeSessionForClose()

        manager._test_handleRealtimeRelayStatus("Connecting")
        #expect(soundCues.listeningCount == 0)
        manager._test_handleRealtimeRelayStatus("Listening (Realtime)")
        #expect(soundCues.listeningCount == 1)
        manager._test_handleRealtimeRelayStatus("Listening (Realtime)")
        manager._test_handleRealtimeRelayStatus("Listening")
        #expect(soundCues.listeningCount == 1)
        manager._test_handleRealtimeRelayStatus("Speaking")
        manager._test_handleRealtimeRelayStatus("Listening")
        #expect(soundCues.listeningCount == 2)

        manager.stop()
        manager._test_handleRealtimeRelayStatus("Listening (Realtime)")
        #expect(soundCues.listeningCount == 2)
    }

    @Test func `push to talk does not play the continuous ready cue`() {
        let soundCues = RecordingTalkSoundCues()
        let manager = TalkModeManager(allowSimulatorCapture: true, soundCues: soundCues)
        manager._test_prepareEnabledRealtimeSessionForClose()

        #expect(manager._test_realtimeStatusPreservesPushToTalkCapture())
        #expect(soundCues.listeningCount == 0)
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

@MainActor
final class RecordingTalkSoundCues: TalkSoundCuePlaying {
    private(set) var played: [TalkSoundCue] = []
    private(set) var currentCue: TalkSoundCue?
    var onFinished: (@MainActor () -> Void)?
    var playbackSucceeds = true

    var listeningCount: Int {
        self.played.filter { $0 == .listening }.count
    }

    @discardableResult
    func play(_ cue: TalkSoundCue, onFinished: (@MainActor () -> Void)?) -> Bool {
        self.played.append(cue)
        self.currentCue = cue
        self.onFinished = onFinished
        return self.playbackSucceeds
    }

    func stop() {
        self.currentCue = nil
        self.onFinished = nil
    }

    func finish() {
        let completion = self.onFinished
        self.stop()
        completion?()
    }
}
