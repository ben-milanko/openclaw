import AVFAudio
import Foundation
import OSLog

enum TalkSoundCue: Hashable {
    case listening
    case thinking
    case generatingVoice
    case stopped

    var repeats: Bool {
        self == .thinking || self == .generatingVoice
    }

    /// Short, faded tones followed by silence; looping never needs a timer.
    var audioData: Data? {
        let frequencies: [Double]
        let duration: Double
        switch self {
        case .listening:
            return nil // Preserve the existing bundled listening chime.
        case .thinking:
            frequencies = [520, 660]
            duration = 2
        case .generatingVoice:
            frequencies = [780, 980, 780]
            duration = 1.4
        case .stopped:
            frequencies = [620, 420, 280]
            duration = 0.28
        }
        let sampleRate = 16000
        let sampleCount = Int(duration * Double(sampleRate))
        let byteCount = UInt32(sampleCount * 2)
        var data = Data("RIFF".utf8)
        func append(_ value: some FixedWidthInteger) {
            var littleEndian = value.littleEndian
            withUnsafeBytes(of: &littleEndian) { data.append(contentsOf: $0) }
        }
        append(UInt32(36) + byteCount)
        data.append(contentsOf: "WAVEfmt ".utf8)
        append(UInt32(16))
        append(UInt16(1)) // PCM
        append(UInt16(1)) // mono
        append(UInt32(sampleRate))
        append(UInt32(sampleRate * 2))
        append(UInt16(2))
        append(UInt16(16))
        data.append(contentsOf: "data".utf8)
        append(byteCount)
        for sample in 0..<sampleCount {
            let time = Double(sample) / Double(sampleRate)
            let note = Int(time / 0.09)
            let noteTime = time - Double(note) * 0.09
            var amplitude = 0.0
            if note < frequencies.count, noteTime < 0.07 {
                let envelope = pow(sin(.pi * noteTime / 0.07), 2)
                amplitude = 0.22 * envelope * sin(2 * .pi * frequencies[note] * noteTime)
            }
            append(Int16(amplitude * Double(Int16.max)))
        }
        return data
    }
}

@MainActor
protocol TalkSoundCuePlaying: AnyObject {
    @discardableResult
    func play(_ cue: TalkSoundCue, onFinished: (@MainActor () -> Void)?) -> Bool
    func stop()
}

/// Shares Talk's existing audio route without changing microphone/session configuration.
@MainActor
final class TalkSoundCuePlayer: NSObject, TalkSoundCuePlaying {
    private let logger = Logger(subsystem: "ai.openclaw", category: "TalkSoundCuePlayer")
    private var audioData: [TalkSoundCue: Data] = [:]
    private var player: AVAudioPlayer?
    private var currentCue: TalkSoundCue?
    private var onFinished: (@MainActor () -> Void)?
    private var completionWatchdog: Task<Void, Never>?

    @discardableResult
    func play(_ cue: TalkSoundCue, onFinished: (@MainActor () -> Void)? = nil) -> Bool {
        if self.currentCue == cue, cue.repeats, self.player?.isPlaying == true { return true }
        self.stop()
        do {
            let data: Data
            if let cached = self.audioData[cue] {
                data = cached
            } else if let generated = cue.audioData {
                data = generated
            } else if let url = Bundle.main.url(
                forResource: "talk-listening", withExtension: "wav", subdirectory: "Audio")
            {
                data = try Data(contentsOf: url)
            } else {
                self.logger.warning("listening cue missing from app bundle")
                return false
            }
            self.audioData[cue] = data
            let player = try AVAudioPlayer(data: data)
            self.player = player
            player.delegate = self
            player.volume = cue == .listening ? 0.5 : 0.35
            player.numberOfLoops = cue.repeats ? -1 : 0
            player.currentTime = 0
            self.currentCue = cue
            self.onFinished = onFinished
            guard player.play() else {
                self.stop()
                self.logger.warning("Talk cue playback could not start")
                return false
            }
            if onFinished != nil {
                // Interruption can suppress the delegate callback. Never retain Talk's
                // audio session indefinitely for the 280 ms stop chime.
                self.completionWatchdog = Task { @MainActor [weak self] in
                    try? await Task.sleep(for: .seconds(1))
                    guard !Task.isCancelled else { return }
                    self?.finish(player)
                }
            }
            return true
        } catch {
            self.logger.warning("Talk cue failed: \(error.localizedDescription, privacy: .public)")
            return false
        }
    }

    func stop() {
        self.completionWatchdog?.cancel()
        self.completionWatchdog = nil
        self.player?.stop()
        self.player = nil
        self.currentCue = nil
        self.onFinished = nil
    }

    private func finish(_ player: AVAudioPlayer) {
        guard self.player === player else { return }
        let completion = self.onFinished
        self.stop()
        completion?()
    }
}

extension TalkSoundCuePlayer: @preconcurrency AVAudioPlayerDelegate {
    func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully _: Bool) {
        self.finish(player)
    }

    func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error _: (any Error)?) {
        self.finish(player)
    }
}
