import Foundation
import Testing
@testable import OpenClawChatUI

@MainActor
@Suite(.serialized)
struct ChatMediaAudioPlayerTests {
    @Test func `a recording outlives its row and returns at its listening position`() throws {
        let coordinator = ChatMediaPlaybackCoordinator.shared
        let key = Self.key()
        var rowPlayer: ChatMediaAudioPlayer? = try Self.player(key)
        weak var recording = rowPlayer
        coordinator.activate(try #require(rowPlayer))
        rowPlayer?.seek(to: 3.25)
        rowPlayer = nil
        defer { coordinator.pauseAudio(ownerID: key.scope.ownerID) }

        #expect(recording != nil)
        #expect(coordinator.audioPlayer(for: key) === recording)
        #expect(recording?.currentTime == 3.25)

        coordinator.pauseAudio(ownerID: UUID())
        #expect(recording != nil)
        coordinator.pauseAudio(ownerID: key.scope.ownerID)
        #expect(recording == nil)

        let reloaded = try Self.player(key)
        #expect(reloaded.currentTime == 3.25)
    }

    @Test func `remote timestamp seeking clamps and preserves paused playback`() throws {
        let coordinator = ChatMediaPlaybackCoordinator.shared
        let key = Self.key()
        let player = try Self.player(key)
        coordinator.activate(player)
        defer { coordinator.pauseAudio(ownerID: key.scope.ownerID) }

        player.handleRemoteCommand(.seek(7.5))
        #expect(player.currentTime == 7.5)
        #expect(!player.isPlaying)
        #expect(player.nowPlayingMetadata.elapsed == 7.5)
        player.handleRemoteCommand(.seek(.infinity))
        #expect(player.currentTime == 7.5)
        player.handleRemoteCommand(.seek(-10))
        #expect(player.currentTime == 0)
        player.handleRemoteCommand(.seek(60))
        #expect(player.currentTime == 10)
        player.handleRemoteCommand(.seek(4))
        player.pause()

        #expect(try Self.player(key).currentTime == 4)
    }

    @Test func `identical artifact IDs do not share positions across conversations or owners`() throws {
        let firstKey = Self.key()
        let player = try Self.player(firstKey)
        player.seek(to: 6)

        let otherSession = ChatMediaAudioPlaybackKey(
            scope: ChatMediaAudioPlaybackScope(
                ownerID: firstKey.scope.ownerID,
                sessionTarget: OpenClawChatSessionTarget(sessionKey: "other", agentID: nil)),
            artifactID: firstKey.artifactID)
        let otherOwner = ChatMediaAudioPlaybackKey(
            scope: ChatMediaAudioPlaybackScope(
                ownerID: UUID(),
                sessionTarget: firstKey.scope.sessionTarget),
            artifactID: firstKey.artifactID)

        #expect(try Self.player(otherSession).currentTime == 0)
        #expect(try Self.player(otherOwner).currentTime == 0)
        #expect(try Self.player(firstKey).currentTime == 6)
    }

    private static func key() -> ChatMediaAudioPlaybackKey {
        ChatMediaAudioPlaybackKey(
            scope: ChatMediaAudioPlaybackScope(
                ownerID: UUID(),
                sessionTarget: OpenClawChatSessionTarget(sessionKey: "briefing", agentID: nil)),
            artifactID: "synthetic-briefing")
    }

    private static func player(_ key: ChatMediaAudioPlaybackKey) throws -> ChatMediaAudioPlayer {
        // Ten seconds of mono 16-bit PCM silence at 8 kHz. This exercises the
        // real decoder and timestamp owner without emitting sound.
        var wav = Data("RIFF".utf8)
        wav.appendLittleEndian(UInt32(160_036))
        wav.append(Data("WAVEfmt ".utf8))
        wav.appendLittleEndian(UInt32(16))
        wav.appendLittleEndian(UInt16(1))
        wav.appendLittleEndian(UInt16(1))
        wav.appendLittleEndian(UInt32(8000))
        wav.appendLittleEndian(UInt32(16000))
        wav.appendLittleEndian(UInt16(2))
        wav.appendLittleEndian(UInt16(16))
        wav.append(Data("data".utf8))
        wav.appendLittleEndian(UInt32(160_000))
        wav.append(Data(repeating: 0, count: 160_000))
        return try ChatMediaAudioPlayer(
            media: OpenClawChatMediaData(data: wav, mimeType: "audio/wav"),
            playbackKey: key,
            title: "Synthetic briefing",
            fallbackDuration: nil,
            playbackAllowed: { true })
    }
}

extension Data {
    fileprivate mutating func appendLittleEndian<T: FixedWidthInteger>(_ value: T) {
        var littleEndian = value.littleEndian
        Swift.withUnsafeBytes(of: &littleEndian) { self.append(contentsOf: $0) }
    }
}
