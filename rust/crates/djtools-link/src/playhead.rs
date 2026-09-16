//! Shared beat-grid fallback for devices/transports without precise position packets.
//! This is an estimate within the reported beat, never sample-accurate timecode.
use std::time::{Duration, Instant};

#[derive(Debug, Clone)]
pub(crate) struct TrackTiming {
    pub duration_ms: u32,
    pub beats_ms: Vec<u32>,
}

#[derive(Debug, Clone)]
pub(crate) struct BeatPlayhead {
    beat: u32,
    position_ms: f64,
    lower_ms: u32,
    upper_ms: u32,
    rate: f64,
    anchored_at: Instant,
    observed_at: Instant,
}

impl BeatPlayhead {
    pub fn update(
        previous: Option<&Self>,
        timing: &TrackTiming,
        beat: Option<u32>,
        rate: f64,
        ended: bool,
        reset: bool,
        now: Instant,
    ) -> Option<Self> {
        if ended && timing.duration_ms > 0 {
            return Some(Self {
                beat: 0,
                position_ms: f64::from(timing.duration_ms),
                lower_ms: timing.duration_ms,
                upper_ms: timing.duration_ms,
                rate: 0.0,
                anchored_at: now,
                observed_at: now,
            });
        }
        let beat = beat?;
        let index = usize::try_from(beat.checked_sub(1)?).ok()?;
        let lower = *timing.beats_ms.get(index)?;
        let upper = timing
            .beats_ms
            .get(index + 1)
            .copied()
            .unwrap_or(timing.duration_ms);
        if upper < lower || !rate.is_finite() {
            return None;
        }
        let previous = previous.filter(|_| !reset);
        let same_beat = previous.filter(|old| old.beat == beat);
        let position_ms = same_beat
            .map(|old| f64::from(old.position(now)))
            .unwrap_or(f64::from(if rate < 0.0 { upper } else { lower }));
        // A beat transition happened between two status packets. Use their
        // midpoint only for an adjacent, continuously playing transition.
        // Seeks, loops, cue jumps and first observations anchor immediately.
        let adjacent = previous.filter(|old| {
            old.rate * rate > 0.0
                && ((rate > 0.0 && old.beat.checked_add(1) == Some(beat))
                    || (rate < 0.0 && beat.checked_add(1) == Some(old.beat)))
        });
        let correction = adjacent
            .map(|old| {
                now.saturating_duration_since(old.observed_at)
                    .min(Duration::from_millis(250))
                    / 2
            })
            .unwrap_or_default();
        Some(Self {
            beat,
            position_ms,
            lower_ms: lower,
            upper_ms: upper,
            rate,
            anchored_at: now - correction,
            observed_at: now,
        })
    }

    pub fn position(&self, now: Instant) -> u32 {
        // Never run indefinitely when a cable, deck or status stream disappears.
        let elapsed = now
            .saturating_duration_since(self.anchored_at)
            .min(Duration::from_millis(500))
            .as_secs_f64();
        (self.position_ms + elapsed * 1000.0 * self.rate)
            .clamp(f64::from(self.lower_ms), f64::from(self.upper_ms))
            .round() as u32
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn grid() -> TrackTiming {
        TrackTiming {
            duration_ms: 4000,
            beats_ms: vec![100, 600, 1100, 1700, 2400],
        }
    }
    #[test]
    fn uses_real_grid_and_pitch_and_never_runs_past_reported_beat() {
        let now = Instant::now();
        let clock = BeatPlayhead::update(None, &grid(), Some(3), 1.25, false, false, now).unwrap();
        assert_eq!(clock.position(now + Duration::from_millis(200)), 1350);
        assert_eq!(clock.position(now + Duration::from_secs(20)), 1700);
    }
    #[test]
    fn repeated_status_does_not_restart_the_same_beat_and_pause_holds_position() {
        let now = Instant::now();
        let a = BeatPlayhead::update(None, &grid(), Some(2), 1.0, false, false, now).unwrap();
        let b = BeatPlayhead::update(
            Some(&a),
            &grid(),
            Some(2),
            1.0,
            false,
            false,
            now + Duration::from_millis(100),
        )
        .unwrap();
        assert_eq!(b.position(now + Duration::from_millis(200)), 800);
        let paused = BeatPlayhead::update(
            Some(&b),
            &grid(),
            Some(2),
            0.0,
            false,
            false,
            now + Duration::from_millis(200),
        )
        .unwrap();
        assert_eq!(paused.position(now + Duration::from_secs(5)), 800);
    }
    #[test]
    fn seeks_loops_reverse_cues_and_end_reset_without_drifting() {
        let now = Instant::now();
        let a = BeatPlayhead::update(None, &grid(), Some(4), 1.0, false, false, now).unwrap();
        let jump = BeatPlayhead::update(
            Some(&a),
            &grid(),
            Some(1),
            1.0,
            false,
            false,
            now + Duration::from_millis(200),
        )
        .unwrap();
        assert_eq!(jump.position(now + Duration::from_millis(200)), 100);
        let reverse =
            BeatPlayhead::update(None, &grid(), Some(3), -1.0, false, false, now).unwrap();
        assert_eq!(reverse.position(now + Duration::from_millis(200)), 1500);
        let cue = BeatPlayhead::update(
            Some(&a),
            &grid(),
            Some(4),
            0.0,
            false,
            true,
            now + Duration::from_millis(100),
        )
        .unwrap();
        assert_eq!(cue.position(now + Duration::from_secs(1)), 1700);
        let ended = BeatPlayhead::update(Some(&a), &grid(), None, 0.0, true, false, now).unwrap();
        assert_eq!(ended.position(now + Duration::from_secs(1)), 4000);
        assert!(BeatPlayhead::update(None, &grid(), Some(0), 1.0, false, false, now).is_none());
        assert!(BeatPlayhead::update(None, &grid(), Some(100), 1.0, false, false, now).is_none());
    }
}
