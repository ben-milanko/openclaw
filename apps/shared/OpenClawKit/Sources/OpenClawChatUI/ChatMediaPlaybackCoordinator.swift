import Foundation

#if os(iOS) || os(macOS)
import MediaPlayer
#endif

struct ChatMediaAudioPlaybackScope: Hashable, Sendable {
    let ownerID: UUID
    let sessionTarget: OpenClawChatSessionTarget
}

struct ChatMediaAudioPlaybackKey: Hashable, Sendable {
    let scope: ChatMediaAudioPlaybackScope
    let artifactID: String
}

@MainActor
protocol ChatMediaPlaybackOwner: AnyObject {
    func stopForMediaPlaybackInterruption()
}

struct ChatMediaNowPlayingMetadata: Equatable, Sendable {
    let title: String
    let duration: TimeInterval
    let elapsed: TimeInterval
    let playbackRate: Double
}

enum ChatMediaRemoteCommand: Equatable, Sendable {
    case play
    case pause
    case toggle
    case seek(TimeInterval)
}

@MainActor
protocol ChatMediaNowPlayingOwner: ChatMediaPlaybackOwner {
    var nowPlayingMetadata: ChatMediaNowPlayingMetadata { get }
    func handleRemoteCommand(_ command: ChatMediaRemoteCommand)
}

@MainActor
protocol ChatMediaPlayer: ChatMediaNowPlayingOwner {
    var isPlaying: Bool { get }
    func play()
    func pause()
    func seek(to time: TimeInterval)
}

extension ChatMediaPlayer {
    func toggle() {
        if self.isPlaying { self.pause() } else { self.play() }
    }

    func stopForMediaPlaybackInterruption() {
        self.pause()
    }

    func handleRemoteCommand(_ command: ChatMediaRemoteCommand) {
        switch command {
        case .play: self.play()
        case .pause: self.pause()
        case .toggle: self.toggle()
        case let .seek(time): self.seek(to: time)
        }
    }
}

@MainActor
protocol ChatMediaNowPlayingPublishing: AnyObject {
    func publish(_ metadata: ChatMediaNowPlayingMetadata)
    func setRemoteCommandHandler(
        _ handler: (@MainActor @Sendable (ChatMediaRemoteCommand) -> Void)?)
    func clear()
}

#if os(iOS) || os(macOS)
@MainActor
private final class SystemChatMediaNowPlayingCenter: ChatMediaNowPlayingPublishing {
    static let shared = SystemChatMediaNowPlayingCenter()

    private var commandTargets: [(command: MPRemoteCommand, token: Any)] = []

    func publish(_ metadata: ChatMediaNowPlayingMetadata) {
        MPNowPlayingInfoCenter.default().nowPlayingInfo = [
            MPMediaItemPropertyTitle: metadata.title,
            MPMediaItemPropertyPlaybackDuration: metadata.duration,
            MPNowPlayingInfoPropertyElapsedPlaybackTime: metadata.elapsed,
            MPNowPlayingInfoPropertyPlaybackRate: metadata.playbackRate,
        ]
    }

    func setRemoteCommandHandler(
        _ handler: (@MainActor @Sendable (ChatMediaRemoteCommand) -> Void)?)
    {
        for target in self.commandTargets {
            target.command.removeTarget(target.token)
        }
        self.commandTargets.removeAll()
        guard let handler else { return }

        let center = MPRemoteCommandCenter.shared()
        self.addTarget(to: center.playCommand, command: .play, handler: handler)
        self.addTarget(to: center.pauseCommand, command: .pause, handler: handler)
        self.addTarget(to: center.togglePlayPauseCommand, command: .toggle, handler: handler)
        let seekCommand = center.changePlaybackPositionCommand
        let token = seekCommand.addTarget { event in
            guard let event = event as? MPChangePlaybackPositionCommandEvent else {
                return .commandFailed
            }
            let position = event.positionTime
            Task { @MainActor in handler(.seek(position)) }
            return .success
        }
        self.commandTargets.append((seekCommand, token))
    }

    func clear() {
        self.setRemoteCommandHandler(nil)
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
    }

    private func addTarget(
        to remoteCommand: MPRemoteCommand,
        command: ChatMediaRemoteCommand,
        handler: @escaping @MainActor @Sendable (ChatMediaRemoteCommand) -> Void)
    {
        let token = remoteCommand.addTarget { _ in
            Task { @MainActor in
                handler(command)
            }
            return .success
        }
        self.commandTargets.append((remoteCommand, token))
    }
}
#else
@MainActor
private final class SystemChatMediaNowPlayingCenter: ChatMediaNowPlayingPublishing {
    static let shared = SystemChatMediaNowPlayingCenter()

    func publish(_: ChatMediaNowPlayingMetadata) {}
    func setRemoteCommandHandler(_: (@MainActor @Sendable (ChatMediaRemoteCommand) -> Void)?) {}
    func clear() {}
}
#endif

/// AVAudioSession and audible chat media are process-wide resources. Keeping the
/// active owner here prevents Listen, audio attachments, and videos from talking
/// over one another across separate chat views. This is also the sole Now Playing
/// publisher, so speech/Talk ownership clears attachment metadata instead of
/// competing with it.
@MainActor
final class ChatMediaPlaybackCoordinator {
    static let shared = ChatMediaPlaybackCoordinator()

    private weak var activeOwner: (any ChatMediaPlaybackOwner)?
    // A scrolling transcript does not own the lifetime of an explicitly played
    // recording. Retain only that recording; never cache every loaded clip.
    private var retainedAudioPlayer: ChatMediaAudioPlayer?
    private var audioPositions: [ChatMediaAudioPlaybackKey: TimeInterval] = [:]
    private var audioPositionOrder: [ChatMediaAudioPlaybackKey] = []
    private let nowPlayingCenter: any ChatMediaNowPlayingPublishing

    init(nowPlayingCenter: any ChatMediaNowPlayingPublishing = SystemChatMediaNowPlayingCenter.shared) {
        self.nowPlayingCenter = nowPlayingCenter
    }

    func activate(_ owner: any ChatMediaPlaybackOwner) {
        guard self.activeOwner !== owner else {
            self.updateNowPlaying(owner)
            return
        }
        let previous = self.activeOwner
        // Install the new owner before stopping the old one: its release callback
        // must not clear the replacement that already owns playback.
        self.activeOwner = owner
        previous?.stopForMediaPlaybackInterruption()
        self.retainedAudioPlayer = owner as? ChatMediaAudioPlayer
        self.configureNowPlaying(for: owner)
    }

    func release(_ owner: any ChatMediaPlaybackOwner) {
        guard self.activeOwner === owner else { return }
        self.activeOwner = nil
        self.retainedAudioPlayer = nil
        self.nowPlayingCenter.clear()
    }

    func audioPlayer(for key: ChatMediaAudioPlaybackKey) -> ChatMediaAudioPlayer? {
        guard let player = self.retainedAudioPlayer,
              player.playbackKey == key, !player.isUnavailable
        else { return nil }
        return player
    }

    func audioPosition(for key: ChatMediaAudioPlaybackKey) -> TimeInterval {
        self.audioPositions[key] ?? 0
    }

    func recordAudioPosition(_ time: TimeInterval, for key: ChatMediaAudioPlaybackKey) {
        guard time.isFinite, time >= 0 else { return }
        if time == 0 {
            self.audioPositions.removeValue(forKey: key)
            self.audioPositionOrder.removeAll { $0 == key }
            return
        }
        if self.audioPositions[key] == nil {
            if self.audioPositionOrder.count == 128 {
                self.audioPositions.removeValue(forKey: self.audioPositionOrder.removeFirst())
            }
            self.audioPositionOrder.append(key)
        }
        self.audioPositions[key] = time
    }

    func pauseAudio(ownerID: UUID) {
        guard let player = self.retainedAudioPlayer,
              player.playbackKey.scope.ownerID == ownerID
        else { return }
        player.pause()
        self.release(player)
    }

    func isActive(_ owner: any ChatMediaPlaybackOwner) -> Bool {
        self.activeOwner === owner
    }

    func updateNowPlaying(_ owner: any ChatMediaPlaybackOwner) {
        guard self.activeOwner === owner,
              let owner = owner as? any ChatMediaNowPlayingOwner
        else { return }
        self.nowPlayingCenter.publish(owner.nowPlayingMetadata)
    }

    private func configureNowPlaying(for owner: any ChatMediaPlaybackOwner) {
        guard let owner = owner as? any ChatMediaNowPlayingOwner else {
            self.nowPlayingCenter.clear()
            return
        }
        self.nowPlayingCenter.setRemoteCommandHandler { [weak self, weak owner] command in
            guard let self,
                  let owner,
                  self.activeOwner === owner
            else { return }
            owner.handleRemoteCommand(command)
            self.updateNowPlaying(owner)
        }
        self.nowPlayingCenter.publish(owner.nowPlayingMetadata)
    }
}
