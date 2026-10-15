import AVFAudio
import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw

@MainActor
struct TalkActivityCueTests {
    @Test(arguments: [false, true])
    func `gateway generation cue ends on playback or cancellation`(cancelSynthesis: Bool) async {
        let soundCues = RecordingTalkSoundCues()
        let synthesizer = CueCheckingSynthesizer(soundCues: soundCues, cancelSynthesis: cancelSynthesis)
        let player = CueCheckingSpeechPlayer(soundCues: soundCues)
        let manager = TalkModeManager(
            allowSimulatorCapture: true,
            gatewaySpeechSynthesizer: synthesizer,
            soundCues: soundCues)
        manager.bufferedPlayer = player
        manager._test_prepareEnabledRealtimeSessionForClose()
        manager._test_applyLoadedTalkConfig(TalkModeGatewayConfigParser.parse(
            config: ["talk": [
                "provider": "openai",
                "resolved": ["provider": "openai", "config": [:]],
                "interruptOnSpeech": false,
            ]],
            defaultProvider: "elevenlabs",
            defaultModelIdFallback: "eleven_v3",
            defaultRealtimeModelIdFallback: "gpt-realtime-2",
            defaultSilenceTimeoutMs: 900))
        await manager._test_playAssistant(text: "A synthetic reply")
        #expect(synthesizer.requested)
        #expect(player.played == !cancelSynthesis)
        #expect(soundCues.currentCue == nil)
        manager.stop()
    }

    @Test func `realtime thinking sounds stop for speech listening disconnect and suspension`() {
        let soundCues = RecordingTalkSoundCues()
        let manager = TalkModeManager(allowSimulatorCapture: true, soundCues: soundCues)
        manager._test_prepareEnabledRealtimeSessionForClose()
        defer { manager.stop() }

        manager._test_handleRealtimeRelayStatus("Thinking")
        #expect(soundCues.currentCue == .thinking)
        manager._test_handleRealtimeRelayStatus("Speaking")
        #expect(soundCues.currentCue == nil)
        manager._test_handleRealtimeRelayStatus("Listening")
        #expect(soundCues.currentCue == .listening)
        manager._test_handleRealtimeRelayStatus("Thinking")
        manager.updateGatewayConnected(false)
        #expect(soundCues.currentCue == nil)
        manager._test_prepareEnabledRealtimeSessionForClose()
        manager._test_handleRealtimeRelayStatus("Thinking")
        manager.suspendForBackground()
        #expect(soundCues.currentCue == nil)
    }

    @Test func `disabled Talk has no activity sounds`() {
        let soundCues = RecordingTalkSoundCues()
        let manager = TalkModeManager(allowSimulatorCapture: true, soundCues: soundCues)
        manager._test_handleRealtimeRelayStatus("Thinking")
        #expect(soundCues.played.isEmpty)
        manager.stop()
        #expect(soundCues.played.isEmpty)
    }

    @Test func `stop cue finishes before audio session release and stop is idempotent`() async throws {
        let soundCues = RecordingTalkSoundCues()
        var deactivations = 0
        let manager = TalkModeManager(
            allowSimulatorCapture: true,
            audioSessionDeactivationAction: { deactivations += 1 },
            soundCues: soundCues)
        manager._test_prepareEnabledRealtimeSessionForClose()
        await manager.start()
        #expect(manager.isListening)
        manager.setEnabled(false)
        #expect(soundCues.currentCue == .stopped)
        #expect(deactivations == 0)
        soundCues.finish()
        #expect(deactivations == 1)
        #expect(!manager._test_audioSessionIsActive())
        manager.stop()
        #expect(soundCues.played.filter { $0 == .stopped }.count == 1)
    }

    @Test func `failed stop sound releases audio immediately`() async throws {
        let soundCues = RecordingTalkSoundCues()
        var deactivations = 0
        let manager = TalkModeManager(
            allowSimulatorCapture: true,
            audioSessionDeactivationAction: { deactivations += 1 },
            soundCues: soundCues)
        manager._test_prepareEnabledRealtimeSessionForClose()
        await manager.start()
        soundCues.playbackSucceeds = false
        manager.stop()
        #expect(deactivations == 1)
        #expect(!manager._test_audioSessionIsActive())
    }

    @Test func `old stop completion cannot release restarted Talk audio`() async throws {
        let soundCues = RecordingTalkSoundCues()
        var deactivations = 0
        let manager = TalkModeManager(
            allowSimulatorCapture: true,
            audioSessionDeactivationAction: { deactivations += 1 },
            soundCues: soundCues)
        manager._test_prepareEnabledRealtimeSessionForClose()
        await manager.start()
        manager.stop()
        let oldCompletion = try #require(soundCues.onFinished)
        manager._test_prepareEnabledRealtimeSessionForClose()
        await manager.start()
        oldCompletion()
        #expect(deactivations == 0)
        manager.suspendForBackground()
        #expect(deactivations == 1)
        manager.stop()
    }

    @Test func `activity sounds decode as distinct cycles and stop is a short one shot`() throws {
        var clips = Set<Data>()
        for (cue, expectedDuration, repeats) in [
            (TalkSoundCue.thinking, 2.0, true),
            (.generatingVoice, 1.4, true),
            (.stopped, 0.28, false),
        ] {
            let data = try #require(cue.audioData)
            let player = try AVAudioPlayer(data: data)
            #expect(abs(player.duration - expectedDuration) < 0.001)
            #expect(player.numberOfChannels == 1)
            #expect(cue.repeats == repeats)
            clips.insert(data)
        }
        #expect(clips.count == 3)
    }
}

@MainActor
private final class CueCheckingSynthesizer: TalkGatewaySpeechSynthesizing {
    let soundCues: RecordingTalkSoundCues
    let cancelSynthesis: Bool
    var requested = false

    init(soundCues: RecordingTalkSoundCues, cancelSynthesis: Bool) {
        self.soundCues = soundCues
        self.cancelSynthesis = cancelSynthesis
    }

    func synthesize(_: TalkGatewaySpeechRequest) async throws -> TalkGatewaySpeechAudio {
        #expect(self.soundCues.currentCue == .generatingVoice)
        self.requested = true
        if self.cancelSynthesis { throw CancellationError() }
        return TalkGatewaySpeechAudio(data: Data([1, 2, 3]), provider: "openai", outputFormat: "mp3")
    }
}

@MainActor
private final class CueCheckingSpeechPlayer: TalkBufferedAudioPlaying {
    let soundCues: RecordingTalkSoundCues
    var played = false

    init(soundCues: RecordingTalkSoundCues) { self.soundCues = soundCues }

    func play(data _: Data) async -> StreamingPlaybackResult {
        #expect(self.soundCues.currentCue == nil)
        self.played = true
        return StreamingPlaybackResult(finished: true, interruptedAt: nil)
    }

    func stop() -> Double? { nil }
}
