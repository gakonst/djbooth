import CoreMedia
import Testing
@testable import DJBoothKit

struct PlaybackMediaClockTests {
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
