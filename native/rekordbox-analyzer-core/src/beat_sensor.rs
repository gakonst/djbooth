//! Causal multi-band peak front end used by the clean-room rhythm analyzer.

use anyhow::{Result, bail};
use serde::{Deserialize, Serialize};

const BAND_COUNT: usize = 6;
const AGGREGATE_FRAMES: u64 = 8;
const MINIMUM_PEAK_SECONDS: f32 = 0.29000002;
const INITIAL_DECAY_SECONDS: f32 = 1.7;
const REPEATED_DECAY_SECONDS: f32 = 1.3;
const PEAK_THRESHOLD_FLOOR: f32 = 0.001;
const PEAK_THRESHOLD_SCALE: f32 = 0.75;
const INITIAL_DECAY_SCALE: f32 = 0.5;
const REPEATED_DECAY_SCALE: f32 = 0.5;
const MAX_EVENTS: usize = 1_000_000;
const TEMPO_HISTOGRAM_BINS: usize = 256;

/// One local-maximum event emitted by a frequency-band peak detector.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BeatSensorEvent {
    /// Zero-based detector path.
    pub band: u8,
    /// Source frame at the local maximum.
    pub peak_frame: u64,
    /// Source frame at which the local maximum became final.
    pub detected_frame: u64,
    /// Filtered amplitude at the local maximum.
    pub amplitude: f32,
    /// Filtered amplitude when the detector finalized the maximum.
    pub confirmation_input: f32,
}

/// Deterministic event stream from the six-path causal rhythm front end.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BeatSensorAnalysis {
    /// Source PCM sample rate.
    pub sample_rate: u32,
    /// Number of source frames consumed.
    pub source_frames: usize,
    /// Detector events in source-time order.
    pub events: Vec<BeatSensorEvent>,
    /// Period candidates accepted from recent peak-interval history.
    pub candidates: Vec<BeatSensorCandidate>,
    /// Accepted candidates retained by the cumulative tempo-family selector.
    pub selected_candidates: Vec<BeatSensorCandidate>,
    /// Sorted, de-duplicated peak hypotheses sent to the tempo-section decoder.
    pub beat_hypotheses: Vec<BeatSensorHypothesis>,
}

/// One beat-period candidate accepted from a detector path.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BeatSensorCandidate {
    /// Zero-based detector path.
    pub band: u8,
    /// Source frame of the peak that triggered this calculation.
    pub peak_frame: u64,
    /// Distance from the preceding peak, in milliseconds.
    pub interval_ms: f32,
    /// Normalized beat period, in milliseconds.
    pub period_ms: f32,
    /// Absolute error from the triggering interval's normalized period.
    pub error_ms: f32,
    /// Number of compatible preceding intervals.
    pub support: u32,
}

/// One pre-pruning beat hypothesis produced from an accepted peak history.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BeatSensorHypothesis {
    /// Source frame of the supporting peak.
    pub peak_frame: u64,
    /// Quantized number of quarter-beat periods since the preceding peak.
    pub period_ratio: f32,
    /// Candidate beat period, in milliseconds.
    pub period_ms: f32,
    /// Generation used to replace older same-position hypotheses.
    pub generation: u32,
    /// Zero-based detector path.
    pub band: u8,
}

/// Extract the six causal, multi-band peak streams used for tempo candidates.
///
/// Samples must be finite normalized mono PCM. Processing stays at the source
/// sample rate and ignores a final partial eight-sample aggregate.
pub fn analyze_beat_sensor_events(samples: &[f32], sample_rate: u32) -> Result<BeatSensorAnalysis> {
    if sample_rate == 0 {
        bail!("beat sensor requires a non-zero sample rate");
    }
    if samples.iter().any(|sample| !sample.is_finite()) {
        bail!("beat sensor received non-finite PCM");
    }

    let mut sensor = BeatSensor::new(sample_rate);
    let mut events = Vec::new();
    let mut candidates = Vec::new();
    let mut selected_candidates = Vec::new();
    let mut beat_hypotheses = Vec::new();
    for &sample in samples {
        sensor.put(
            sample,
            &mut events,
            &mut candidates,
            &mut selected_candidates,
            &mut beat_hypotheses,
        )?;
    }
    Ok(BeatSensorAnalysis {
        sample_rate,
        source_frames: samples.len(),
        events,
        candidates,
        selected_candidates,
        beat_hypotheses,
    })
}

struct BeatSensor {
    sample_rate: u32,
    filters: [PassFilter; 4],
    low_onset: MovingAverageSubtractor,
    high_onset: MovingAverageSubtractor,
    detectors: [PeakDetector; BAND_COUNT],
    peak_buffers: [PeakBuffer; BAND_COUNT],
    pending_candidates: [Option<PeakPeriodCandidate>; BAND_COUNT],
    selector: BandSelector,
    signal: BeatListSignal,
    sums: [f32; BAND_COUNT],
    aggregate_count: u64,
}

impl BeatSensor {
    fn new(sample_rate: u32) -> Self {
        let sample_rate_f64 = f64::from(sample_rate);
        let butterworth_q = f64::from(0.707106769_f32);
        let low = Biquad::low_pass(283.0, sample_rate_f64, butterworth_q);
        let wide = Biquad::wide_band_pass(150.0, sample_rate_f64, 1.5);
        let mid_high = Biquad::high_pass(283.0, sample_rate_f64, butterworth_q);
        let mid_low = Biquad::low_pass(7_900.0, sample_rate_f64, butterworth_q);
        let high = Biquad::high_pass(7_900.0, sample_rate_f64, butterworth_q);
        let low_onset_samples = moving_average_samples(sample_rate, 0.001);
        let high_onset_samples = moving_average_samples(sample_rate, 0.0002);

        Self {
            sample_rate,
            filters: [
                PassFilter::new(vec![low; 2]),
                PassFilter::new(vec![wide; 2]),
                PassFilter::new(vec![mid_high, mid_low, mid_high, mid_low]),
                PassFilter::new(vec![high; 2]),
            ],
            low_onset: MovingAverageSubtractor::new(low_onset_samples),
            high_onset: MovingAverageSubtractor::new(high_onset_samples),
            detectors: std::array::from_fn(|_| PeakDetector::new(sample_rate)),
            peak_buffers: std::array::from_fn(PeakBuffer::new),
            pending_candidates: [None; BAND_COUNT],
            selector: BandSelector::default(),
            signal: BeatListSignal::default(),
            sums: [0.0; BAND_COUNT],
            aggregate_count: 0,
        }
    }

    fn put(
        &mut self,
        sample: f32,
        events: &mut Vec<BeatSensorEvent>,
        candidates: &mut Vec<BeatSensorCandidate>,
        selected_candidates: &mut Vec<BeatSensorCandidate>,
        beat_hypotheses: &mut Vec<BeatSensorHypothesis>,
    ) -> Result<()> {
        let low = self.filters[0].put(sample).abs();
        let wide = self.filters[1].put(sample).abs();
        let mid = self.filters[2].put(sample).abs();
        let high = self.filters[3].put(sample).abs();
        let low_onset = self.low_onset.put(low);
        let high_onset = self.high_onset.put(high);
        let values = [low, wide, mid, high, low_onset, high_onset];
        for (sum, value) in self.sums.iter_mut().zip(values) {
            *sum += value;
        }

        self.aggregate_count += 1;
        if self.aggregate_count != AGGREGATE_FRAMES {
            return Ok(());
        }
        self.aggregate_count = 0;
        if self
            .selector
            .select_band(&mut self.pending_candidates)
            .is_some()
        {
            for (band, pending) in self.pending_candidates.iter().enumerate() {
                if let Some(candidate) = pending {
                    let peak = self.peak_buffers[band]
                        .records
                        .last()
                        .expect("accepted candidate requires a peak");
                    selected_candidates.push(BeatSensorCandidate {
                        band: band as u8,
                        peak_frame: peak.peak_frame,
                        interval_ms: candidate.interval_ms,
                        period_ms: candidate.period_ms,
                        error_ms: candidate.error_ms,
                        support: candidate.support,
                    });
                    self.signal.change_stat(
                        *candidate,
                        &self.peak_buffers[band],
                        beat_hypotheses,
                    )?;
                }
            }
        }
        self.pending_candidates.fill(None);

        let sample_rate = self.sample_rate;
        for (band, (detector, sum)) in self.detectors.iter_mut().zip(&mut self.sums).enumerate() {
            let input = *sum / AGGREGATE_FRAMES as f32;
            *sum = 0.0;
            if let Some(event) = detector.put(input) {
                if events.len() >= MAX_EVENTS {
                    bail!("beat sensor event count exceeds {MAX_EVENTS}");
                }
                let event = BeatSensorEvent {
                    band: band as u8,
                    peak_frame: event.peak_frame,
                    detected_frame: event.detected_frame,
                    amplitude: event.amplitude,
                    confirmation_input: input,
                };
                if let Some(candidate) =
                    self.peak_buffers[band].put(event.peak_frame, event.amplitude, sample_rate)
                {
                    self.pending_candidates[band] = Some(candidate);
                    candidates.push(BeatSensorCandidate {
                        band: band as u8,
                        peak_frame: event.peak_frame,
                        interval_ms: candidate.interval_ms,
                        period_ms: candidate.period_ms,
                        error_ms: candidate.error_ms,
                        support: candidate.support,
                    });
                }
                events.push(event);
            }
        }
        Ok(())
    }
}

#[derive(Clone, Copy)]
struct Biquad {
    b0: f64,
    b1: f64,
    b2: f64,
    a1: f64,
    a2: f64,
    x2: f64,
    x1: f64,
    y2: f64,
    y1: f64,
}

impl Biquad {
    fn low_pass(frequency: f64, sample_rate: f64, q: f64) -> Self {
        let (sin, cos) = (std::f64::consts::TAU * frequency / sample_rate).sin_cos();
        let alpha = sin / (2.0 * q);
        let inverse_a0 = 1.0 / (1.0 + alpha);
        Self::new(
            0.5 * (1.0 - cos) * inverse_a0,
            (1.0 - cos) * inverse_a0,
            0.5 * (1.0 - cos) * inverse_a0,
            -2.0 * cos * inverse_a0,
            (1.0 - alpha) * inverse_a0,
        )
    }

    fn high_pass(frequency: f64, sample_rate: f64, q: f64) -> Self {
        let (sin, cos) = (std::f64::consts::TAU * frequency / sample_rate).sin_cos();
        let alpha = sin / (2.0 * q);
        let inverse_a0 = 1.0 / (1.0 + alpha);
        Self::new(
            0.5 * (1.0 + cos) * inverse_a0,
            -(1.0 + cos) * inverse_a0,
            0.5 * (1.0 + cos) * inverse_a0,
            -2.0 * cos * inverse_a0,
            (1.0 - alpha) * inverse_a0,
        )
    }

    fn wide_band_pass(frequency: f64, sample_rate: f64, bandwidth: f64) -> Self {
        let omega = std::f64::consts::TAU * frequency / sample_rate;
        let (sin, cos) = omega.sin_cos();
        let alpha = sin * (std::f64::consts::LN_2 * 0.5 * bandwidth * omega / sin).sinh();
        let inverse_a0 = 1.0 / (1.0 + alpha);
        Self::new(
            alpha * inverse_a0,
            0.0,
            -alpha * inverse_a0,
            -2.0 * cos * inverse_a0,
            (1.0 - alpha) * inverse_a0,
        )
    }

    const fn new(b0: f64, b1: f64, b2: f64, a1: f64, a2: f64) -> Self {
        Self {
            b0,
            b1,
            b2,
            a1,
            a2,
            x2: 0.0,
            x1: 0.0,
            y2: 0.0,
            y1: 0.0,
        }
    }

    fn put(&mut self, input: f64) -> f64 {
        let output = self.x2 * self.b2 + self.x1 * self.b1 + input * self.b0
            - (self.y2 * self.a2 + self.y1 * self.a1);
        self.x2 = self.x1;
        self.x1 = input;
        self.y2 = self.y1;
        self.y1 = output;
        output
    }
}

struct PassFilter {
    stages: Vec<Biquad>,
}

impl PassFilter {
    fn new(stages: Vec<Biquad>) -> Self {
        Self { stages }
    }

    fn put(&mut self, input: f32) -> f32 {
        let mut output = f64::from(input);
        for stage in &mut self.stages {
            output = stage.put(output);
        }
        output as f32
    }
}

struct MovingAverageSubtractor {
    values: Vec<f32>,
    index: usize,
    sum: f32,
    reciprocal_len: f32,
}

impl MovingAverageSubtractor {
    fn new(samples: usize) -> Self {
        Self {
            values: vec![0.0; samples],
            index: 0,
            sum: 0.0,
            reciprocal_len: 1.0 / samples as f32,
        }
    }

    fn put(&mut self, sample: f32) -> f32 {
        self.sum = (sample - self.values[self.index]) + self.sum;
        self.values[self.index] = sample;
        self.index = (self.index + 1) % self.values.len();
        (sample - self.sum * self.reciprocal_len).max(0.0)
    }
}

fn moving_average_samples(sample_rate: u32, seconds: f64) -> usize {
    ((f64::from(sample_rate) * seconds + 0.5) as usize).max(2)
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct PeakEvent {
    peak_frame: u64,
    detected_frame: u64,
    amplitude: f32,
}

struct PeakDetector {
    state: u32,
    minimum_peak_frames: u64,
    threshold: f32,
    decay: f32,
    decay_per_put: f32,
    threshold_floor: f32,
    decay_stage: u32,
    decay_countdown: i32,
    peak_scale: f32,
    first_decay_scale: f32,
    repeated_decay_scale: f32,
    initial_decay_frames: u64,
    repeated_decay_frames: u64,
    last_decay_frame: u64,
    position: u64,
    peak_amplitude: f32,
    peak_frame: u64,
}

impl PeakDetector {
    fn new(sample_rate: u32) -> Self {
        let sample_rate_f32 = sample_rate as f32;
        Self {
            state: 0,
            minimum_peak_frames: (sample_rate_f32 * MINIMUM_PEAK_SECONDS) as u64,
            threshold: PEAK_THRESHOLD_FLOOR,
            decay: 0.0,
            decay_per_put: 0.0,
            threshold_floor: PEAK_THRESHOLD_FLOOR,
            decay_stage: 0,
            decay_countdown: 0,
            peak_scale: PEAK_THRESHOLD_SCALE,
            first_decay_scale: INITIAL_DECAY_SCALE,
            repeated_decay_scale: REPEATED_DECAY_SCALE,
            initial_decay_frames: (sample_rate_f32 * INITIAL_DECAY_SECONDS) as u64,
            repeated_decay_frames: (sample_rate_f32 * REPEATED_DECAY_SECONDS) as u64,
            last_decay_frame: 0,
            position: 0,
            peak_amplitude: 0.0,
            peak_frame: 0,
        }
    }

    fn put(&mut self, input: f32) -> Option<PeakEvent> {
        self.position += AGGREGATE_FRAMES;
        self.threshold -= self.decay_per_put;

        if self.state == 1 {
            if input > self.peak_amplitude {
                self.start_peak(input);
                return None;
            }
            if self.position - self.peak_frame >= self.minimum_peak_frames {
                self.state = 0;
                return Some(PeakEvent {
                    peak_frame: self.peak_frame,
                    detected_frame: self.position,
                    amplitude: self.peak_amplitude,
                });
            }
            return None;
        }

        self.threshold = self.threshold.max(self.threshold_floor);
        let elapsed = self.position as i32 - self.last_decay_frame as i32;
        if elapsed > self.decay_countdown {
            let target = if self.decay_stage == 0 {
                self.decay_stage = 1;
                self.decay_countdown = self.repeated_decay_frames as i32;
                self.first_decay_scale * self.peak_amplitude
            } else {
                self.decay_countdown = self.repeated_decay_frames as i32;
                self.repeated_decay_scale * self.threshold
            };
            self.decay = (self.threshold - target) / self.decay_countdown as f32;
            self.decay_per_put = AGGREGATE_FRAMES as f32 * self.decay;
            self.last_decay_frame = self.position;
        }

        if self.threshold <= input {
            self.start_peak(input);
        }
        None
    }

    fn start_peak(&mut self, input: f32) {
        self.peak_frame = self.position;
        self.peak_amplitude = input;
        self.threshold = input * self.peak_scale;
        self.decay_countdown = self.initial_decay_frames as i32;
        self.decay_stage = 0;
        self.decay = 0.0;
        self.decay_per_put = 0.0;
        self.last_decay_frame = self.position;
        self.state = 1;
    }
}

const BASE_RANGES: [(f32, f32, f32); 9] = [
    (500.0, 1_276.0, 1.5),
    (468.0, 1_071.0, 1.25),
    (923.0, 2_142.0, 2.5),
    (290.0, 638.0, 0.75),
    (320.0, 860.0, 1.0),
    (290.0, 428.0, 0.5),
    (666.0, 1_714.0, 2.0),
    (1_500.0, 3_333.0, 4.0),
    (1_125.0, 2_580.0, 3.0),
];

const COMPARISON_RANGES: [(f32, f32, f32); 9] = [
    (1_500.0, 3_333.0, 4.0),
    (923.0, 2_142.0, 2.5),
    (666.0, 1_714.0, 2.0),
    (500.0, 1_276.0, 1.5),
    (468.0, 1_071.0, 1.25),
    (320.0, 860.0, 1.0),
    (290.0, 638.0, 0.75),
    (290.0, 428.0, 0.5),
    (1_125.0, 2_580.0, 3.0),
];

#[derive(Clone, Copy)]
struct PeakInfo {
    peak_frame: u64,
    _amplitude: f32,
    interval_ms: f32,
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct PeakPeriodCandidate {
    interval_ms: f32,
    period_ms: f32,
    error_ms: f32,
    support: u32,
}

struct PeakBuffer {
    band: u8,
    records: Vec<PeakInfo>,
    last_peak_frame: u64,
}

impl PeakBuffer {
    fn new(band: usize) -> Self {
        Self {
            band: band as u8,
            records: Vec::with_capacity(32),
            last_peak_frame: 0,
        }
    }

    fn put(
        &mut self,
        peak_frame: u64,
        amplitude: f32,
        sample_rate: u32,
    ) -> Option<PeakPeriodCandidate> {
        let interval_ms = if self.last_peak_frame == 0 {
            0.0
        } else {
            (peak_frame - self.last_peak_frame) as f32 * 1_000.0 / sample_rate as f32
        };
        let candidate = (self.last_peak_frame != 0)
            .then(|| self.calculate(interval_ms))
            .flatten();
        self.last_peak_frame = peak_frame;
        if self.records.len() == 32 {
            self.records.remove(0);
        }
        self.records.push(PeakInfo {
            peak_frame,
            _amplitude: amplitude,
            interval_ms,
        });
        candidate
    }

    fn calculate(&self, interval_ms: f32) -> Option<PeakPeriodCandidate> {
        let mut best = None;
        for &(minimum, maximum, multiplier) in &BASE_RANGES {
            if !(interval_ms > minimum && interval_ms < maximum) {
                continue;
            }
            let Some(candidate) = self.calculate_for_multiplier(interval_ms, multiplier) else {
                continue;
            };
            if candidate.period_ms < 333.0
                || best.is_some_and(|best: PeakPeriodCandidate| best.support >= candidate.support)
            {
                continue;
            }
            best = Some(candidate);
        }
        best
    }

    fn calculate_for_multiplier(
        &self,
        interval_ms: f32,
        multiplier: f32,
    ) -> Option<PeakPeriodCandidate> {
        let normalized_period = interval_ms / multiplier;
        let initial_tolerance = period_tolerance(normalized_period);
        let mut target_multiplier = if multiplier < 4.0 { 4.0 } else { 8.0 };
        let mut multiplier_sum = multiplier;
        let mut interval_sum = interval_ms;
        let usable = self
            .records
            .get(1..)?
            .iter()
            .rev()
            .take(30)
            .collect::<Vec<_>>();
        let mut cursor = 0;

        while cursor < usable.len() {
            let prior = usable[cursor].interval_ms;
            let prior_multiplier =
                comparison_multiplier(prior, normalized_period, initial_tolerance)?;
            interval_sum += prior;
            multiplier_sum += prior_multiplier;
            cursor += 1;

            if multiplier_sum == target_multiplier {
                let period_ms = interval_sum / target_multiplier;
                let error_ms = (period_ms - normalized_period).abs();
                let tolerance = period_tolerance(period_ms);
                while cursor < usable.len() {
                    let prior = usable[cursor].interval_ms;
                    let mut quantized_multiplier = ((prior * 4.0 / period_ms + 0.5).trunc()) * 0.25;
                    if quantized_multiplier > 2.5 {
                        quantized_multiplier = (quantized_multiplier + 0.5).trunc();
                    }
                    quantized_multiplier = quantized_multiplier.min(4.0);
                    if quantized_multiplier <= 0.0
                        || (prior / quantized_multiplier - period_ms).abs() >= tolerance
                    {
                        break;
                    }
                    cursor += 1;
                }
                return Some(PeakPeriodCandidate {
                    interval_ms,
                    period_ms,
                    error_ms,
                    support: cursor as u32,
                });
            }

            if multiplier_sum > target_multiplier {
                if target_multiplier <= 4.0 || target_multiplier >= 16.0 || multiplier_sum >= 16.0 {
                    return None;
                }
                target_multiplier *= 2.0;
            }
        }
        None
    }
}

struct BandSelector {
    histogram: [i32; TEMPO_HISTOGRAM_BINS],
    minimum_bin: i32,
    maximum_bin: i32,
}

impl Default for BandSelector {
    fn default() -> Self {
        Self {
            histogram: [0; TEMPO_HISTOGRAM_BINS],
            minimum_bin: 200,
            maximum_bin: 40,
        }
    }
}

impl BandSelector {
    fn select_band(
        &mut self,
        pending: &mut [Option<PeakPeriodCandidate>; BAND_COUNT],
    ) -> Option<usize> {
        let mut minimum_error = f32::MAX;
        let mut minimum_error_band = None;
        let mut minimum_error_bin = 0;

        for (band, candidate) in pending.iter().enumerate() {
            let Some(candidate) = candidate else {
                continue;
            };
            let bin = round_positive(60_000.0 / candidate.period_ms);
            let Some(histogram) = self.histogram.get_mut(bin as usize) else {
                continue;
            };
            let weight = (4.0 / (candidate.error_ms + 0.5)).trunc() as i32;
            *histogram += weight.max(1);
            self.minimum_bin = self.minimum_bin.min(bin);
            self.maximum_bin = self.maximum_bin.max(bin);
            if candidate.error_ms < minimum_error {
                minimum_error = candidate.error_ms;
                minimum_error_band = Some(band);
                minimum_error_bin = bin;
            }
        }

        let minimum_error_band = minimum_error_band?;
        let candidate_period = pending[minimum_error_band]?.period_ms;
        let tolerance = period_tolerance(candidate_period);
        let selected_bin = loop {
            let selected_bin = self.strongest_bin()?;
            let selected_period = 60_000.0 / selected_bin as f32;
            if metrical_period_compatible(candidate_period, selected_period, tolerance) {
                break selected_bin;
            }
            if self.histogram[minimum_error_bin as usize] < 3 {
                return None;
            }
            self.retain_family(candidate_period, tolerance);
        };

        if self.histogram[selected_bin as usize] < 3 {
            return None;
        }
        let selected_period = 60_000.0 / selected_bin as f32;
        for candidate in pending {
            if candidate.is_some_and(|candidate| {
                !metrical_period_compatible(
                    candidate.period_ms,
                    selected_period,
                    period_tolerance(candidate.period_ms),
                )
            }) {
                *candidate = None;
            }
        }
        Some(minimum_error_band)
    }

    fn strongest_bin(&self) -> Option<i32> {
        if self.minimum_bin > self.maximum_bin {
            return None;
        }
        let mut selected = None;
        let mut strength = 0;
        for bin in self.minimum_bin..=self.maximum_bin {
            let current = *self.histogram.get(bin as usize)?;
            if current > strength {
                selected = Some(bin);
                strength = current;
            }
        }
        selected
    }

    fn retain_family(&mut self, candidate_period: f32, tolerance: f32) {
        let old_minimum = self.minimum_bin;
        let old_maximum = self.maximum_bin;
        self.minimum_bin = 200;
        self.maximum_bin = 40;
        for bin in old_minimum..=old_maximum {
            let Some(strength) = self.histogram.get_mut(bin as usize) else {
                continue;
            };
            let period = 60_000.0 / bin as f32;
            if !metrical_period_compatible(candidate_period, period, tolerance) {
                *strength = 0;
            }
            if *strength != 0 {
                self.minimum_bin = self.minimum_bin.min(bin);
                self.maximum_bin = self.maximum_bin.max(bin);
            }
        }
    }
}

#[derive(Default)]
struct BeatListSignal {
    generation: u32,
}

impl BeatListSignal {
    fn change_stat(
        &mut self,
        candidate: PeakPeriodCandidate,
        peak_buffer: &PeakBuffer,
        hypotheses: &mut Vec<BeatSensorHypothesis>,
    ) -> Result<()> {
        let record_count =
            usize::try_from(candidate.support.saturating_add(2)).unwrap_or(usize::MAX);
        self.generation = self
            .generation
            .wrapping_add(candidate.support)
            .wrapping_add(2);
        let generation = self.generation;
        let first = peak_buffer.records.len().saturating_sub(record_count);
        for peak in &peak_buffer.records[first..] {
            if hypotheses.len() >= MAX_EVENTS {
                bail!("beat sensor hypothesis count exceeds {MAX_EVENTS}");
            }
            let period_ratio =
                ((peak.interval_ms * 4.0 / candidate.period_ms + 0.5).trunc()) * 0.25;
            let hypothesis = BeatSensorHypothesis {
                peak_frame: peak.peak_frame,
                period_ratio,
                period_ms: candidate.period_ms,
                generation,
                band: peak_buffer.band,
            };
            insert_hypothesis(hypotheses, hypothesis);
        }
        self.generation = self.generation.wrapping_add(0x100) & 0xffff_ff00;
        Ok(())
    }
}

fn comparison_multiplier(interval_ms: f32, normalized_period: f32, tolerance: f32) -> Option<f32> {
    COMPARISON_RANGES
        .iter()
        .find_map(|&(minimum, maximum, multiplier)| {
            (interval_ms > minimum
                && interval_ms < maximum
                && (interval_ms / multiplier - normalized_period).abs() < tolerance)
                .then_some(multiplier)
        })
}

fn period_tolerance(period_ms: f32) -> f32 {
    (f64::from(period_ms) * 0.04).min(20.0) as f32
}

fn round_positive(value: f32) -> i32 {
    (value + 0.5).trunc() as i32
}

fn metrical_period_compatible(left: f32, right: f32, tolerance: f32) -> bool {
    (left - right).abs() <= tolerance
        || (left - right * 2.0).abs() <= tolerance
        || (left - right * 0.5).abs() <= tolerance
}

fn insert_hypothesis(hypotheses: &mut Vec<BeatSensorHypothesis>, hypothesis: BeatSensorHypothesis) {
    let equal_start =
        hypotheses.partition_point(|existing| existing.peak_frame < hypothesis.peak_frame);
    let mut equal_end =
        hypotheses.partition_point(|existing| existing.peak_frame <= hypothesis.peak_frame);
    let current_bpm_tenth = round_positive(600_000.0 / hypothesis.period_ms);
    let tolerance = period_tolerance(hypothesis.period_ms);
    for index in (equal_start..equal_end).rev() {
        let existing = hypotheses[index];
        let existing_bpm_tenth = round_positive(600_000.0 / existing.period_ms);
        let integer_family = existing_bpm_tenth == current_bpm_tenth * 2
            || existing_bpm_tenth == current_bpm_tenth
            || existing_bpm_tenth * 2 == current_bpm_tenth;
        if !integer_family
            && metrical_period_compatible(hypothesis.period_ms, existing.period_ms, tolerance)
        {
            continue;
        }
        if (hypothesis.generation as u8) <= (existing.generation as u8) {
            return;
        }
        hypotheses.remove(index);
        equal_end -= 1;
        break;
    }
    hypotheses.insert(equal_end, hypothesis);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn linked_filter_coefficients_match_runtime_snapshots() {
        let low_44 = Biquad::low_pass(283.0, 44_100.0, f64::from(0.707106769_f32));
        assert!((low_44.b0 - 0.00039512172754532175).abs() < 1.0e-16);
        assert!((low_44.b1 - 0.00079024345509064349).abs() < 1.0e-16);
        assert!((low_44.a1 - -1.9429927712041899).abs() < 1.0e-15);
        assert!((low_44.a2 - 0.94457325811437109).abs() < 1.0e-15);

        let wide_48 = Biquad::wide_band_pass(150.0, 48_000.0, 1.5);
        assert!((wide_48.b0 - 0.010560795605230589).abs() < 1.0e-15);
        assert!((wide_48.a1 - -1.9784969611414083).abs() < 1.0e-15);
        assert!((wide_48.a2 - 0.97887840878953880).abs() < 1.0e-15);
    }

    #[test]
    fn detector_constants_follow_native_float_rounding() {
        let detector_44 = PeakDetector::new(44_100);
        assert_eq!(detector_44.minimum_peak_frames, 12_789);
        assert_eq!(detector_44.initial_decay_frames, 74_970);
        assert_eq!(detector_44.repeated_decay_frames, 57_329);
        assert_eq!(moving_average_samples(44_100, 0.001), 44);
        assert_eq!(moving_average_samples(44_100, 0.0002), 9);

        let detector_48 = PeakDetector::new(48_000);
        assert_eq!(detector_48.minimum_peak_frames, 13_920);
        assert_eq!(detector_48.initial_decay_frames, 81_600);
        assert_eq!(detector_48.repeated_decay_frames, 62_399);
        assert_eq!(moving_average_samples(48_000, 0.001), 48);
        assert_eq!(moving_average_samples(48_000, 0.0002), 10);
    }

    #[test]
    fn peak_detector_reports_the_local_maximum_after_holdoff() {
        let mut detector = PeakDetector::new(100);
        detector.minimum_peak_frames = 16;
        assert_eq!(detector.put(0.5), None);
        assert_eq!(detector.put(0.75), None);
        assert_eq!(detector.put(0.25), None);
        assert_eq!(
            detector.put(0.25),
            Some(PeakEvent {
                peak_frame: 16,
                detected_frame: 32,
                amplitude: 0.75,
            })
        );
    }

    #[test]
    fn linked_signal_backfills_support_and_quantizes_quarter_periods() {
        let mut buffer = PeakBuffer::new(2);
        buffer.records = vec![
            PeakInfo {
                peak_frame: 40,
                _amplitude: 0.343_057_1,
                interval_ms: 0.0,
            },
            PeakInfo {
                peak_frame: 22_912,
                _amplitude: 0.484_722_17,
                interval_ms: 476.5,
            },
            PeakInfo {
                peak_frame: 68_672,
                _amplitude: 0.499_077_3,
                interval_ms: 953.333_3,
            },
            PeakInfo {
                peak_frame: 90_960,
                _amplitude: 0.393_923_64,
                interval_ms: 464.333_34,
            },
            PeakInfo {
                peak_frame: 113_496,
                _amplitude: 0.370_753_3,
                interval_ms: 469.5,
            },
        ];
        let candidate = PeakPeriodCandidate {
            interval_ms: 469.5,
            period_ms: 471.791_7,
            error_ms: 2.291_687,
            support: 3,
        };
        let mut signal = BeatListSignal::default();
        let mut hypotheses = Vec::new();
        signal
            .change_stat(candidate, &buffer, &mut hypotheses)
            .expect("linked trace fixture");

        assert_eq!(signal.generation, 256);
        assert_eq!(hypotheses.len(), 5);
        assert_eq!(
            hypotheses
                .iter()
                .map(|hypothesis| hypothesis.period_ratio)
                .collect::<Vec<_>>(),
            vec![0.0, 1.0, 2.0, 1.0, 1.0]
        );
        assert!(hypotheses.iter().all(|hypothesis| {
            hypothesis.period_ms == candidate.period_ms
                && hypothesis.generation == 5
                && hypothesis.band == 2
        }));
    }

    #[test]
    fn linked_signal_preserves_nearby_period_variants_at_one_peak() {
        let mut hypotheses = Vec::new();
        insert_hypothesis(
            &mut hypotheses,
            BeatSensorHypothesis {
                peak_frame: 40,
                period_ratio: 0.0,
                period_ms: 471.791_7,
                generation: 5,
                band: 2,
            },
        );
        insert_hypothesis(
            &mut hypotheses,
            BeatSensorHypothesis {
                peak_frame: 40,
                period_ratio: 0.0,
                period_ms: 469.291_7,
                generation: 8,
                band: 2,
            },
        );
        assert_eq!(hypotheses.len(), 2);

        insert_hypothesis(
            &mut hypotheses,
            BeatSensorHypothesis {
                peak_frame: 40,
                period_ratio: 0.0,
                period_ms: 471.791_7,
                generation: 9,
                band: 2,
            },
        );
        assert_eq!(hypotheses.len(), 2);
        assert_eq!(hypotheses[1].generation, 9);
    }

    #[test]
    fn linked_band_selector_requires_three_cumulative_family_votes() {
        let mut selector = BandSelector::default();
        let candidate = PeakPeriodCandidate {
            interval_ms: 472.0,
            period_ms: 472.0,
            error_ms: 9.0,
            support: 3,
        };
        for vote in 0..2 {
            let mut pending = [None; BAND_COUNT];
            pending[vote] = Some(candidate);
            assert_eq!(selector.select_band(&mut pending), None);
        }
        let mut pending = [None; BAND_COUNT];
        pending[2] = Some(candidate);
        assert_eq!(selector.select_band(&mut pending), Some(2));
        assert_eq!(pending[2], Some(candidate));
    }
}
