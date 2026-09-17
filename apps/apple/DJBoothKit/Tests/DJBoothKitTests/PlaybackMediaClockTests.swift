import CoreMedia
import Testing
@testable import DJBoothKit

struct PlaybackMediaClockTests {
    @Test func agreeingRemoteReportsKeepOneContinuousRenderClock() {
        let initial = PlaybackMediaClock.remoteReport(elapsed: 10, duration: 300, playing: true,
                                                      resolution: 1, previous: nil, at: 100)
        var clock = initial
        // Four UI snapshots per second must not replace a render clock that
        // already agrees with the speaker's quantized position.
        for tick in 1...240 {
            let age = Double(tick) / 4
            clock = .remoteReport(elapsed: floor(10 + age), duration: 300, playing: true,
                                  resolution: 1, previous: clock, at: 100 + age)
            #expect(clock == initial)
            #expect(clock.position(at: 100 + age) == 10 + age)
        }
    }

    @Test func cachedRemoteReportsDoNotRestartAnAgreedDriftCorrection() {
        let initial = PlaybackMediaClock.remoteReport(elapsed: 10, duration: 300, playing: true,
                                                      resolution: 1, previous: nil, at: 100)
        let correcting = PlaybackMediaClock.remoteReport(elapsed: 10, duration: 300, playing: true,
                                                         resolution: 1, previous: initial, at: 102)
        var clock = correcting
        for tick in 1...32 {
            let age = Double(tick) / 4
            clock = .remoteReport(elapsed: 10 + age, duration: 300, playing: true,
                                  resolution: 1, previous: clock, at: 102 + age)
            #expect(clock == correcting)
        }
        // The original five-second correction finishes once, without a new
        // one-second tail being scheduled on every cached snapshot.
        #expect(abs(clock.position(at: 107) - 16.25) < 0.000001)
        #expect(abs(clock.position(at: 108) - clock.position(at: 107) - 1) < 0.000001)
    }

    @Test func stableRemoteClockStillPublishesTransportAndDurationChanges() {
        let initial = PlaybackMediaClock.remoteReport(elapsed: 10, duration: 300, playing: true,
                                                      resolution: 1, previous: nil, at: 100)
        let paused = PlaybackMediaClock.remoteReport(elapsed: 11, duration: 300, playing: false,
                                                     resolution: 1, previous: initial, at: 101.5)
        #expect(paused != initial)
        #expect(paused.position(at: 200) == 11.5)
        let updatedDuration = PlaybackMediaClock.remoteReport(elapsed: 11, duration: 11.8, playing: true,
                                                              resolution: 1, previous: initial, at: 101.5)
        #expect(updatedDuration != initial)
        #expect(updatedDuration.position(at: 200) == 11.8)
    }

    @Test func wholeSecondRemoteReportsNeverRewindTheWaveform() {
        var clock = PlaybackMediaClock.remoteReport(elapsed: 10, duration: 300, playing: true,
                                                    resolution: 1, previous: nil, at: 100)
        var uptime = 100.0
        // Sonos status is integer seconds, polled after each network round trip.
        // Alternate timing and latency to exercise repeated and skipped seconds.
        for index in 0..<120 {
            uptime += [0.35, 1.12, 1.37, 0.73][index % 4]
            let reported = floor(10 + uptime - 100 - [0.02, 0.18, 0.07][index % 3])
            let before = clock.position(at: uptime)
            clock = .remoteReport(elapsed: reported, duration: 300, playing: true,
                                  resolution: 1, previous: clock, at: uptime)
            #expect(abs(clock.position(at: uptime) - before) < 0.000001)
            #expect(clock.position(at: uptime + 1.0 / 60) > before)
            #expect(abs(clock.position(at: uptime) - reported) < 1.5)
        }
    }

    @Test func remoteDriftCorrectionIsContinuousAndSeeksAreImmediate() {
        let initial = PlaybackMediaClock.remoteReport(elapsed: 10, duration: 100, playing: true,
                                                      resolution: 1, previous: nil, at: 100)
        let behind = PlaybackMediaClock.remoteReport(elapsed: 10, duration: 100, playing: true,
                                                     resolution: 1, previous: initial, at: 102)
        #expect(behind.position(at: 102) == 12)
        #expect(abs(behind.position(at: 103) - 12.85) < 0.000001)
        // A seek from another controller is a real discontinuity.
        let externalSeek = PlaybackMediaClock.remoteReport(elapsed: 40, duration: 100, playing: true,
                                                           resolution: 1, previous: behind, at: 103)
        #expect(externalSeek.position(at: 103) == 40)
        // Local seeks and track/queue changes discard the previous clock, even
        // when their target happens to fall inside the quantization window.
        let localSeek = PlaybackMediaClock.remoteReport(elapsed: 40.5, duration: 100, playing: true,
                                                        resolution: 1, previous: nil, at: 103)
        #expect(localSeek.position(at: 103) == 40.5)
        let exactStream = PlaybackMediaClock.remoteReport(elapsed: 12.25, duration: 100, playing: true,
                                                          resolution: 0, previous: initial, at: 102)
        #expect(exactStream.position(at: 102) == 12.25)
    }

    @Test func remotePauseHoldsFractionalPositionAndResumeContinues() {
        let initial = PlaybackMediaClock.remoteReport(elapsed: 10, duration: 100, playing: true,
                                                      resolution: 1, previous: nil, at: 100)
        let paused = PlaybackMediaClock.remoteReport(elapsed: 11, duration: 100, playing: false,
                                                     resolution: 1, previous: initial, at: 101.6)
        #expect(abs(paused.position(at: 200) - 11.6) < 0.000001)
        let resumed = PlaybackMediaClock.remoteReport(elapsed: 11, duration: 100, playing: true,
                                                      resolution: 1, previous: paused, at: 200)
        #expect(abs(resumed.position(at: 200) - 11.6) < 0.000001)
        #expect(abs(resumed.position(at: 201) - 12.6) < 0.000001)
    }

    @Test func firstPlayingObservationDoesNotGlideFromBufferedZero() {
        // Captured sequence: Swift first reads PLAYING at 48.542, 248ms after
        // Rust measured position 2. At 52.432 the old clock showed 4.473,
        // because it accelerated from the prior TRANSITIONING anchor of 0.
        let buffering = PlaybackMediaClock.remoteReport(elapsed: 0, duration: 300, playing: false,
                                                        resolution: 1, previous: nil, at: 47.541)
        let playing = PlaybackMediaClock.remoteReport(elapsed: 2.248, duration: 300, playing: true,
                                                      resolution: 1, previous: buffering, at: 48.542)
        #expect(abs(playing.position(at: 48.542) - 2.248) < 0.000001)
        #expect(abs(playing.position(at: 52.432) - 6.138) < 0.000001)
        let held = playing.paused(at: 52.432)
        let confirmed = PlaybackMediaClock.remoteReport(elapsed: 6, duration: 300, playing: false,
                                                        resolution: 1, previous: held, at: 52.644)
        #expect(abs(confirmed.position(at: 60) - 6.138) < 0.000001)
    }

    @Test func localPausePreservesFractionWhenSpeakerReportsWholeSeconds() {
        let initial = PlaybackMediaClock.remoteReport(elapsed: 10, duration: 100, playing: true,
                                                      resolution: 1, previous: nil, at: 100)
        let held = initial.paused(at: 101.6)
        #expect(abs(held.position(at: 200) - 11.6) < 0.000001)
        let confirmed = PlaybackMediaClock.remoteReport(elapsed: 11, duration: 100, playing: false,
                                                        resolution: 1, previous: held, at: 102)
        #expect(abs(confirmed.position(at: 200) - 11.6) < 0.000001)
        let resumed = PlaybackMediaClock.remoteReport(elapsed: 11.2, duration: 100, playing: true,
                                                      resolution: 1, previous: confirmed, at: 200)
        #expect(abs(resumed.position(at: 200) - 11.6) < 0.000001)
        #expect(abs(resumed.position(at: 201) - 12.6) < 0.000001)
    }

    @Test func correctingClockCannotRunBackwardsAtTrackEnd() {
        let initial = PlaybackMediaClock.remoteReport(elapsed: 97, duration: 100, playing: true,
                                                      resolution: 1, previous: nil, at: 100)
        let corrected = PlaybackMediaClock.remoteReport(elapsed: 97, duration: 100, playing: true,
                                                        resolution: 1, previous: initial, at: 102)
        var previous = corrected.position(at: 102)
        for frame in 1...600 {
            let position = corrected.position(at: 102 + Double(frame) / 60)
            #expect(position >= previous)
            #expect(position <= 100)
            previous = position
        }
        #expect(previous == 100)
    }

    @Test func remotePlaybackAdvancesBetweenReportsAndHoldsWhenPaused() {
        let playing = PlaybackMediaClock(elapsed: 10, duration: 20,
            timing: PlaybackTiming(elapsed: 10, duration: 20, playing: true, observedAt: 100))
        #expect(playing.position(at: 100.5) == 10.5)
        #expect(playing.position(at: 111) == 20)
        let paused = PlaybackMediaClock(elapsed: 12, duration: 20,
            timing: PlaybackTiming(elapsed: 12, duration: 20, playing: false, observedAt: 102))
        #expect(paused.position(at: 105) == 12)
        let scrubbing = PlaybackMediaClock(elapsed: 17, duration: 20)
        #expect(scrubbing.position(at: 105) == 17)
    }

    private func timebase() throws -> CMTimebase {
        var result: CMTimebase?
        #expect(CMTimebaseCreateWithSourceClock(allocator: kCFAllocatorDefault,
                                               sourceClock: CMClockGetHostTimeClock(), timebaseOut: &result) == noErr)
        return try #require(result)
    }

    @Test func startupUsesFrozenMediaTimeAndReadsLaterClockChangesWithoutReanchoring() throws {
        let timebase = try timebase()
        let clock = PlaybackMediaClock(timebase: timebase, elapsed: 42, duration: 100)
        #expect(clock.hasTimebase)
        #expect(clock.position() == 0)
        #expect(CMTimebaseSetTime(timebase, time: CMTime(seconds: 12.5, preferredTimescale: 600)) == noErr)
        #expect(clock.position() == 12.5)
        #expect(CMTimebaseSetTime(timebase, time: CMTime(seconds: 13.25, preferredTimescale: 600)) == noErr)
        #expect(clock.position() == 13.25)
    }

    @Test func pendingSeekHoldsTargetInsteadOfExposingOldMediaClock() throws {
        let timebase = try timebase()
        let pending = PlaybackMediaClock(elapsed: 45, duration: 100)
        #expect(!pending.hasTimebase && pending.position() == 45)
        #expect(CMTimebaseSetTime(timebase, time: CMTime(seconds: 5, preferredTimescale: 600)) == noErr)
        #expect(pending.position() == 45)
        #expect(CMTimebaseSetTime(timebase, time: CMTime(seconds: 45, preferredTimescale: 600)) == noErr)
        let completed = PlaybackMediaClock(timebase: timebase, elapsed: 45, duration: 100)
        #expect(completed.position() == pending.position())
    }

    @Test func clockBoundsAndFallbackAreAlwaysFinite() throws {
        let timebase = try timebase()
        #expect(CMTimebaseSetTime(timebase, time: CMTime(seconds: 110, preferredTimescale: 600)) == noErr)
        #expect(PlaybackMediaClock(timebase: timebase, duration: 100).position() == 100)
        #expect(PlaybackMediaClock(elapsed: .nan, duration: .infinity).position() == 0)
        #expect(PlaybackMediaClock(elapsed: -5, duration: 100).position() == 0)
        #expect(PlaybackMediaClock(elapsed: 110, duration: 100).position() == 100)
    }
}
