use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail, ensure};
use djbooth_analyzer::{
    BeatGridEntry, GeneratedAnalysis, PhraseFeatureDiagnostics, analyze_audio_file,
    decode_audio_file_with_channels,
};
use serde::{Deserialize, Serialize};

const SCHEMA_VERSION: u32 = 1;
const SIXTEENTHS_PER_BAR: usize = 16;
const SILENCE_DB_BELOW_RMS: f64 = 30.0;

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReferenceProfile {
    schema_version: u32,
    source: PathBuf,
    duration_seconds: f64,
    bpm: f64,
    first_downbeat_seconds: f64,
    key: String,
    key_confidence: f32,
    bars: usize,
    phrase_count: usize,
    phrase_length_histogram: BTreeMap<usize, usize>,
    mix: SourceProfile,
    stems: BTreeMap<String, SourceProfile>,
    sections: Vec<SectionProfile>,
    relationships: RelationshipProfile,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SourceProfile {
    path: PathBuf,
    peak_db: f64,
    rms_db: f64,
    crest_factor_db: f64,
    dynamic_range_db: f64,
    silence_ratio: f64,
    transient_density_per_second: f64,
    stereo_correlation: f64,
    stereo_width_db: f64,
    low_band_ratio: f64,
    mid_band_ratio: f64,
    high_band_ratio: f64,
    sixteenth_energy_db: [f64; SIXTEENTHS_PER_BAR],
    syncopation_ratio: f64,
    section_rms_db: Vec<f64>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SectionProfile {
    index: u16,
    start_beat: u16,
    start_seconds: f64,
    duration_bars: usize,
    kind: u16,
    energy_z: f64,
    low_band_z: f64,
    mid_band_z: f64,
    high_band_z: f64,
    onset_z: f64,
    energy_delta_z: f64,
    distance_from_previous: f64,
    stem_rms_db: BTreeMap<String, f64>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RelationshipProfile {
    bass_to_drums_rms_db: Option<f64>,
    other_to_drums_rms_db: Option<f64>,
    vocals_to_drums_rms_db: Option<f64>,
    section_contrast_db: f64,
    active_stems_per_section: Vec<usize>,
}

#[derive(Clone, Copy)]
struct SectionRange {
    start_frame: usize,
    end_frame: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProfileComparison {
    schema_version: u32,
    reference_profile: PathBuf,
    candidate_profile: PathBuf,
    reference_source: PathBuf,
    candidate_source: PathBuf,
    overall_score: f64,
    categories: BTreeMap<String, f64>,
    metrics: Vec<MetricComparison>,
    recommendations: Vec<Recommendation>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MetricComparison {
    name: String,
    category: String,
    reference: f64,
    candidate: f64,
    target_delta: f64,
    unit: String,
    score: f64,
    weight: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Recommendation {
    priority: &'static str,
    target: &'static str,
    adjustment: f64,
    unit: &'static str,
    instruction: String,
    rationale: String,
}

pub(crate) fn compare_profiles(
    reference_path: &Path,
    candidate_path: &Path,
    output: Option<&Path>,
) -> Result<()> {
    let reference = read_profile(reference_path, "reference")?;
    let candidate = read_profile(candidate_path, "candidate")?;
    let metrics = comparison_metrics(&reference, &candidate);
    let categories = category_scores(&metrics);
    let category_weights = [
        ("groove", 0.25),
        ("balance", 0.20),
        ("dynamics", 0.15),
        ("stereo", 0.15),
        ("timbre", 0.15),
        ("arrangement", 0.10),
    ];
    let (weighted_score, included_weight) = category_weights
        .iter()
        .filter_map(|(name, weight)| categories.get(*name).map(|score| (score * weight, weight)))
        .fold((0.0, 0.0), |(score_sum, weight_sum), (score, weight)| {
            (score_sum + score, weight_sum + weight)
        });
    let overall_score = weighted_score / included_weight.max(f64::EPSILON);
    let recommendations = recommendations(&reference, &candidate);
    let comparison = ProfileComparison {
        schema_version: SCHEMA_VERSION,
        reference_profile: reference_path.to_path_buf(),
        candidate_profile: candidate_path.to_path_buf(),
        reference_source: reference.source,
        candidate_source: candidate.source,
        overall_score,
        categories,
        metrics,
        recommendations,
    };
    let json = serde_json::to_string_pretty(&comparison)?;
    if let Some(output) = output {
        if let Some(parent) = output
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
        {
            fs::create_dir_all(parent)
                .with_context(|| format!("failed to create {}", parent.display()))?;
        }
        fs::write(output, format!("{json}\n"))
            .with_context(|| format!("failed to write {}", output.display()))?;
    }
    println!("{json}");
    Ok(())
}

fn read_profile(path: &Path, role: &str) -> Result<ReferenceProfile> {
    ensure!(
        path.is_file(),
        "{role} profile does not exist: {}",
        path.display()
    );
    let profile = serde_json::from_slice::<ReferenceProfile>(
        &fs::read(path).with_context(|| format!("failed to read {}", path.display()))?,
    )
    .with_context(|| format!("invalid {role} profile JSON in {}", path.display()))?;
    ensure!(
        profile.schema_version == SCHEMA_VERSION,
        "unsupported {role} profile schema version {} in {}",
        profile.schema_version,
        path.display()
    );
    Ok(profile)
}

fn comparison_metrics(
    reference: &ReferenceProfile,
    candidate: &ReferenceProfile,
) -> Vec<MetricComparison> {
    let mut metrics = vec![
        fit_metric(
            "tempo",
            "arrangement",
            reference.bpm,
            candidate.bpm,
            "BPM",
            0.5,
            1.0,
        ),
        fit_metric(
            "mix RMS",
            "dynamics",
            reference.mix.rms_db,
            candidate.mix.rms_db,
            "dB",
            3.0,
            1.5,
        ),
        fit_metric(
            "crest factor",
            "dynamics",
            reference.mix.crest_factor_db,
            candidate.mix.crest_factor_db,
            "dB",
            4.0,
            1.0,
        ),
        fit_metric(
            "dynamic range",
            "dynamics",
            reference.mix.dynamic_range_db,
            candidate.mix.dynamic_range_db,
            "dB",
            6.0,
            0.75,
        ),
        fit_metric(
            "section contrast",
            "arrangement",
            reference.relationships.section_contrast_db,
            candidate.relationships.section_contrast_db,
            "dB",
            8.0,
            1.25,
        ),
        fit_metric(
            "stereo width",
            "stereo",
            reference.mix.stereo_width_db,
            candidate.mix.stereo_width_db,
            "dB",
            8.0,
            1.5,
        ),
        fit_metric(
            "stereo correlation",
            "stereo",
            reference.mix.stereo_correlation,
            candidate.mix.stereo_correlation,
            "ratio",
            0.4,
            1.0,
        ),
        fit_metric(
            "mix syncopation",
            "groove",
            reference.mix.syncopation_ratio,
            candidate.mix.syncopation_ratio,
            "ratio",
            0.25,
            1.5,
        ),
        fit_metric(
            "transient density",
            "timbre",
            reference.mix.transient_density_per_second,
            candidate.mix.transient_density_per_second,
            "transients/s",
            1.5,
            0.75,
        ),
        fit_metric(
            "silence ratio",
            "arrangement",
            reference.mix.silence_ratio,
            candidate.mix.silence_ratio,
            "ratio",
            0.2,
            0.5,
        ),
    ];

    let band_distance = (reference.mix.low_band_ratio - candidate.mix.low_band_ratio).abs()
        + (reference.mix.mid_band_ratio - candidate.mix.mid_band_ratio).abs()
        + (reference.mix.high_band_ratio - candidate.mix.high_band_ratio).abs();
    metrics.push(distance_metric(
        "spectral balance distance",
        "timbre",
        band_distance,
        "ratio",
        0.35,
        1.5,
    ));
    metrics.push(distance_metric(
        "mix sixteenth shape error",
        "groove",
        pattern_distance(
            &reference.mix.sixteenth_energy_db,
            &candidate.mix.sixteenth_energy_db,
        ),
        "dB MAE",
        10.0,
        1.0,
    ));
    metrics.push(similarity_metric(
        "phrase-length grammar",
        "arrangement",
        histogram_similarity(
            &reference.phrase_length_histogram,
            &candidate.phrase_length_histogram,
        ),
        1.25,
    ));

    if let (Some(reference_drums), Some(candidate_drums)) =
        (reference.stems.get("drums"), candidate.stems.get("drums"))
    {
        metrics.push(distance_metric(
            "drum sixteenth shape error",
            "groove",
            pattern_distance(
                &reference_drums.sixteenth_energy_db,
                &candidate_drums.sixteenth_energy_db,
            ),
            "dB MAE",
            10.0,
            1.5,
        ));
    }
    if let (Some(reference_bass), Some(candidate_bass)) =
        (reference.stems.get("bass"), candidate.stems.get("bass"))
    {
        metrics.push(fit_metric(
            "bass syncopation",
            "groove",
            reference_bass.syncopation_ratio,
            candidate_bass.syncopation_ratio,
            "ratio",
            0.15,
            1.5,
        ));
        metrics.push(fit_metric(
            "bass stereo width",
            "stereo",
            reference_bass.stereo_width_db,
            candidate_bass.stereo_width_db,
            "dB",
            12.0,
            1.0,
        ));
    }
    push_optional_balance(
        &mut metrics,
        "bass/drums balance",
        reference.relationships.bass_to_drums_rms_db,
        candidate.relationships.bass_to_drums_rms_db,
        5.0,
        1.5,
    );
    push_optional_balance(
        &mut metrics,
        "other/drums balance",
        reference.relationships.other_to_drums_rms_db,
        candidate.relationships.other_to_drums_rms_db,
        7.0,
        1.0,
    );
    metrics
}

fn fit_metric(
    name: &str,
    category: &str,
    reference: f64,
    candidate: f64,
    unit: &str,
    tolerance: f64,
    weight: f64,
) -> MetricComparison {
    let target_delta = reference - candidate;
    MetricComparison {
        name: name.to_owned(),
        category: category.to_owned(),
        reference,
        candidate,
        target_delta,
        unit: unit.to_owned(),
        score: fit_score(target_delta, tolerance),
        weight,
    }
}

fn distance_metric(
    name: &str,
    category: &str,
    distance: f64,
    unit: &str,
    tolerance: f64,
    weight: f64,
) -> MetricComparison {
    MetricComparison {
        name: name.to_owned(),
        category: category.to_owned(),
        reference: 0.0,
        candidate: distance,
        target_delta: -distance,
        unit: unit.to_owned(),
        score: fit_score(distance, tolerance),
        weight,
    }
}

fn similarity_metric(name: &str, category: &str, similarity: f64, weight: f64) -> MetricComparison {
    MetricComparison {
        name: name.to_owned(),
        category: category.to_owned(),
        reference: 1.0,
        candidate: similarity,
        target_delta: 1.0 - similarity,
        unit: "similarity".to_owned(),
        score: similarity.clamp(0.0, 1.0) * 100.0,
        weight,
    }
}

fn push_optional_balance(
    metrics: &mut Vec<MetricComparison>,
    name: &str,
    reference: Option<f64>,
    candidate: Option<f64>,
    tolerance: f64,
    weight: f64,
) {
    if let (Some(reference), Some(candidate)) = (reference, candidate) {
        metrics.push(fit_metric(
            name, "balance", reference, candidate, "dB", tolerance, weight,
        ));
    }
}

fn fit_score(delta: f64, tolerance: f64) -> f64 {
    100.0 * (-0.5 * (delta / tolerance.max(f64::EPSILON)).powi(2)).exp()
}

fn pattern_distance(
    reference: &[f64; SIXTEENTHS_PER_BAR],
    candidate: &[f64; SIXTEENTHS_PER_BAR],
) -> f64 {
    reference
        .iter()
        .zip(candidate)
        .map(|(reference, candidate)| (reference - candidate).abs())
        .sum::<f64>()
        / SIXTEENTHS_PER_BAR as f64
}

fn histogram_similarity(
    reference: &BTreeMap<usize, usize>,
    candidate: &BTreeMap<usize, usize>,
) -> f64 {
    let reference_total = reference.values().sum::<usize>() as f64;
    let candidate_total = candidate.values().sum::<usize>() as f64;
    if reference_total == 0.0 || candidate_total == 0.0 {
        return f64::from(reference_total == candidate_total);
    }
    let mut keys = reference
        .keys()
        .chain(candidate.keys())
        .copied()
        .collect::<Vec<_>>();
    keys.sort_unstable();
    keys.dedup();
    keys.into_iter()
        .map(|key| {
            let reference_share = *reference.get(&key).unwrap_or(&0) as f64 / reference_total;
            let candidate_share = *candidate.get(&key).unwrap_or(&0) as f64 / candidate_total;
            reference_share.min(candidate_share)
        })
        .sum()
}

fn category_scores(metrics: &[MetricComparison]) -> BTreeMap<String, f64> {
    let mut weighted = BTreeMap::<String, (f64, f64)>::new();
    for metric in metrics {
        let entry = weighted.entry(metric.category.clone()).or_default();
        entry.0 += metric.score * metric.weight;
        entry.1 += metric.weight;
    }
    weighted
        .into_iter()
        .map(|(category, (score, weight))| (category, score / weight.max(f64::EPSILON)))
        .collect()
}

fn recommendations(
    reference: &ReferenceProfile,
    candidate: &ReferenceProfile,
) -> Vec<Recommendation> {
    let mut recommendations = Vec::new();
    push_recommendation(
        &mut recommendations,
        "masterRmsDb",
        reference.mix.rms_db - candidate.mix.rms_db,
        "dB",
        0.5,
        "adjust master input gain",
        "match the reference's average energy",
    );
    push_recommendation(
        &mut recommendations,
        "stereoWidthDb",
        reference.mix.stereo_width_db - candidate.mix.stereo_width_db,
        "dB",
        1.5,
        "adjust side energy in upper layers while keeping the sub mono",
        "match the reference's stereo image",
    );
    push_recommendation(
        &mut recommendations,
        "sectionContrastDb",
        reference.relationships.section_contrast_db - candidate.relationships.section_contrast_db,
        "dB",
        1.0,
        "adjust breakdown and drop energy separation",
        "match the reference's macro-dynamic contrast",
    );
    push_recommendation(
        &mut recommendations,
        "mixSyncopationRatio",
        reference.mix.syncopation_ratio - candidate.mix.syncopation_ratio,
        "ratio",
        0.04,
        "rebalance off-grid percussion and note attacks",
        "match the reference's rhythmic push-pull",
    );
    push_recommendation(
        &mut recommendations,
        "tempoBpm",
        reference.bpm - candidate.bpm,
        "BPM",
        0.2,
        "adjust song tempo",
        "match the reference tempo",
    );
    if let (Some(reference), Some(candidate)) = (
        reference.relationships.bass_to_drums_rms_db,
        candidate.relationships.bass_to_drums_rms_db,
    ) {
        push_recommendation(
            &mut recommendations,
            "bassGainDb",
            reference - candidate,
            "dB",
            0.75,
            "adjust the complete bass group relative to drums",
            "match the reference's bass/drums balance",
        );
    }
    if let (Some(reference), Some(candidate)) = (
        reference.relationships.other_to_drums_rms_db,
        candidate.relationships.other_to_drums_rms_db,
    ) {
        push_recommendation(
            &mut recommendations,
            "otherGainDb",
            reference - candidate,
            "dB",
            1.0,
            "adjust melodic and atmospheric layers relative to drums",
            "match the reference's other/drums balance",
        );
    }
    for (target, reference, candidate, instruction) in [
        (
            "lowBandRatio",
            reference.mix.low_band_ratio,
            candidate.mix.low_band_ratio,
            "rebalance sub and low-bass energy",
        ),
        (
            "midBandRatio",
            reference.mix.mid_band_ratio,
            candidate.mix.mid_band_ratio,
            "rebalance body and midrange energy",
        ),
        (
            "highBandRatio",
            reference.mix.high_band_ratio,
            candidate.mix.high_band_ratio,
            "rebalance hats, air and high-frequency texture",
        ),
    ] {
        push_recommendation(
            &mut recommendations,
            target,
            reference - candidate,
            "ratio",
            0.04,
            instruction,
            "match the reference's broad spectral balance",
        );
    }
    recommendations.sort_by(|left, right| {
        priority_rank(right.priority)
            .cmp(&priority_rank(left.priority))
            .then_with(|| right.adjustment.abs().total_cmp(&left.adjustment.abs()))
    });
    recommendations
}

fn push_recommendation(
    recommendations: &mut Vec<Recommendation>,
    target: &'static str,
    adjustment: f64,
    unit: &'static str,
    threshold: f64,
    instruction: &'static str,
    rationale: &'static str,
) {
    if adjustment.abs() < threshold {
        return;
    }
    let severity = adjustment.abs() / threshold;
    let priority = if severity >= 3.0 {
        "high"
    } else if severity >= 1.5 {
        "medium"
    } else {
        "low"
    };
    let direction = if adjustment >= 0.0 {
        "increase"
    } else {
        "decrease"
    };
    recommendations.push(Recommendation {
        priority,
        target,
        adjustment,
        unit,
        instruction: format!(
            "{instruction}: {direction} by {:.3} {unit}",
            adjustment.abs()
        ),
        rationale: rationale.to_owned(),
    });
}

fn priority_rank(priority: &str) -> u8 {
    match priority {
        "high" => 3,
        "medium" => 2,
        _ => 1,
    }
}

pub(crate) fn profile_reference(
    audio: &Path,
    stem_arguments: &[String],
    output: Option<&Path>,
) -> Result<()> {
    ensure!(
        audio.is_file(),
        "reference mix does not exist: {}",
        audio.display()
    );
    let stems = parse_stems(stem_arguments)?;
    let analysis = analyze_audio_file(audio)
        .with_context(|| format!("failed to analyze reference mix {}", audio.display()))?;
    let sample_rate = analysis.source.sample_rate();
    let section_ranges = section_ranges(&analysis, sample_rate);
    let mix = source_profile(audio, &analysis.beat.beats, &section_ranges)?;
    let mut stem_profiles = BTreeMap::new();
    for (name, path) in &stems {
        stem_profiles.insert(
            name.clone(),
            source_profile(path, &analysis.beat.beats, &section_ranges)
                .with_context(|| format!("failed to profile stem '{name}'"))?,
        );
    }
    let sections = build_sections(&analysis, &stem_profiles);
    let relationships = relationships(&mix, &stem_profiles);
    let mut phrase_length_histogram = BTreeMap::new();
    for feature in &analysis.song_structure.diagnostics.phrase_features {
        *phrase_length_histogram
            .entry(feature.duration_bars)
            .or_insert(0) += 1;
    }
    let first_downbeat_seconds = analysis
        .beat
        .beats
        .first()
        .map(|beat| f64::from(beat.time_ms) / 1_000.0)
        .unwrap_or_default();
    let profile = ReferenceProfile {
        schema_version: SCHEMA_VERSION,
        source: audio.to_path_buf(),
        duration_seconds: analysis.duration_seconds,
        bpm: analysis.beat.bpm,
        first_downbeat_seconds,
        key: analysis.key.key.clone(),
        key_confidence: analysis.key.confidence,
        bars: analysis.beat.beats.len() / 4,
        phrase_count: analysis.song_structure.entries.len(),
        phrase_length_histogram,
        mix,
        stems: stem_profiles,
        sections,
        relationships,
    };
    let json = serde_json::to_string_pretty(&profile)?;
    if let Some(output) = output {
        if let Some(parent) = output
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
        {
            fs::create_dir_all(parent)
                .with_context(|| format!("failed to create {}", parent.display()))?;
        }
        fs::write(output, format!("{json}\n"))
            .with_context(|| format!("failed to write {}", output.display()))?;
    }
    println!("{json}");
    Ok(())
}

fn parse_stems(arguments: &[String]) -> Result<BTreeMap<String, PathBuf>> {
    let mut stems = BTreeMap::new();
    for argument in arguments {
        let Some((name, path)) = argument.split_once('=') else {
            bail!("--stem must use NAME=PATH, received '{argument}'");
        };
        ensure!(!name.trim().is_empty(), "stem name must not be empty");
        let path = PathBuf::from(path);
        ensure!(path.is_file(), "stem does not exist: {}", path.display());
        ensure!(
            stems.insert(name.to_owned(), path).is_none(),
            "stem '{name}' was provided more than once"
        );
    }
    Ok(stems)
}

fn source_profile(
    path: &Path,
    beats: &[BeatGridEntry],
    section_ranges: &[SectionRange],
) -> Result<SourceProfile> {
    let decoded = decode_audio_file_with_channels(path)
        .with_context(|| format!("failed to decode {}", path.display()))?;
    let sample_rate = decoded.mono().sample_rate();
    let [left, right] = decoded
        .stereo()
        .context("taste profiling requires stereo PCM")?;
    ensure!(
        left.len() == right.len(),
        "decoded stereo channels have different lengths"
    );
    let metrics = audio_metrics(left.samples(), right.samples(), sample_rate);
    let sixteenth_energy_db =
        sixteenth_pattern(left.samples(), right.samples(), sample_rate, beats);
    let syncopation_ratio = syncopation_ratio(&sixteenth_energy_db);
    let section_rms_db = section_ranges
        .iter()
        .map(|range| stereo_rms_db(left.samples(), right.samples(), *range))
        .collect();
    Ok(SourceProfile {
        path: path.to_path_buf(),
        peak_db: metrics.peak_db,
        rms_db: metrics.rms_db,
        crest_factor_db: metrics.crest_factor_db,
        dynamic_range_db: metrics.dynamic_range_db,
        silence_ratio: metrics.silence_ratio,
        transient_density_per_second: metrics.transient_density_per_second,
        stereo_correlation: metrics.stereo_correlation,
        stereo_width_db: metrics.stereo_width_db,
        low_band_ratio: metrics.low_band_ratio,
        mid_band_ratio: metrics.mid_band_ratio,
        high_band_ratio: metrics.high_band_ratio,
        sixteenth_energy_db,
        syncopation_ratio,
        section_rms_db,
    })
}

struct AudioMetrics {
    peak_db: f64,
    rms_db: f64,
    crest_factor_db: f64,
    dynamic_range_db: f64,
    silence_ratio: f64,
    transient_density_per_second: f64,
    stereo_correlation: f64,
    stereo_width_db: f64,
    low_band_ratio: f64,
    mid_band_ratio: f64,
    high_band_ratio: f64,
}

fn audio_metrics(left: &[f32], right: &[f32], sample_rate: u32) -> AudioMetrics {
    let alpha_low = one_pole_alpha(140.0, sample_rate);
    let alpha_mid = one_pole_alpha(5_000.0, sample_rate);
    let mut low_pass = 0.0_f64;
    let mut mid_pass = 0.0_f64;
    let mut peak = 0.0_f64;
    let mut sum = 0.0_f64;
    let mut sum_left = 0.0_f64;
    let mut sum_right = 0.0_f64;
    let mut sum_cross = 0.0_f64;
    let mut sum_mid = 0.0_f64;
    let mut sum_side = 0.0_f64;
    let mut low_energy = 0.0_f64;
    let mut mid_energy = 0.0_f64;
    let mut high_energy = 0.0_f64;
    let window_frames = (sample_rate as usize / 100).max(1);
    let mut window_energy = Vec::with_capacity(left.len() / window_frames + 1);
    let mut current_window = 0.0_f64;
    let mut current_count = 0_usize;
    for (left, right) in left.iter().zip(right) {
        let left = f64::from(*left);
        let right = f64::from(*right);
        let mono = 0.5 * (left + right);
        let side = 0.5 * (left - right);
        low_pass += alpha_low * (mono - low_pass);
        mid_pass += alpha_mid * (mono - mid_pass);
        let low = low_pass;
        let middle = mid_pass - low_pass;
        let high = mono - mid_pass;
        peak = peak.max(left.abs()).max(right.abs());
        let energy = 0.5 * (left * left + right * right);
        sum += energy;
        sum_left += left * left;
        sum_right += right * right;
        sum_cross += left * right;
        sum_mid += mono * mono;
        sum_side += side * side;
        low_energy += low * low;
        mid_energy += middle * middle;
        high_energy += high * high;
        current_window += energy;
        current_count += 1;
        if current_count == window_frames {
            window_energy.push((current_window / current_count as f64).sqrt());
            current_window = 0.0;
            current_count = 0;
        }
    }
    if current_count > 0 {
        window_energy.push((current_window / current_count as f64).sqrt());
    }
    let rms = (sum / left.len().max(1) as f64).sqrt();
    let threshold = rms * db_to_gain(-SILENCE_DB_BELOW_RMS);
    let silence_ratio = window_energy
        .iter()
        .filter(|value| **value < threshold)
        .count() as f64
        / window_energy.len().max(1) as f64;
    let active = window_energy
        .iter()
        .copied()
        .filter(|value| *value >= threshold)
        .collect::<Vec<_>>();
    let p10 = percentile(&active, 0.10);
    let p95 = percentile(&active, 0.95);
    let transient_threshold = percentile(&window_energy, 0.75) * 1.35;
    let transient_count = window_energy
        .windows(3)
        .filter(|window| {
            window[1] > transient_threshold
                && window[1] > window[0] * 1.08
                && window[1] >= window[2]
        })
        .count();
    let duration = left.len() as f64 / f64::from(sample_rate);
    let total_band_energy = (low_energy + mid_energy + high_energy).max(f64::EPSILON);
    AudioMetrics {
        peak_db: gain_to_db(peak),
        rms_db: gain_to_db(rms),
        crest_factor_db: gain_to_db(peak / rms.max(f64::EPSILON)),
        dynamic_range_db: gain_to_db(p95 / p10.max(f64::EPSILON)),
        silence_ratio,
        transient_density_per_second: transient_count as f64 / duration.max(f64::EPSILON),
        stereo_correlation: sum_cross / (sum_left.sqrt() * sum_right.sqrt()).max(f64::EPSILON),
        stereo_width_db: gain_to_db((sum_side / sum_mid.max(f64::EPSILON)).sqrt()),
        low_band_ratio: low_energy / total_band_energy,
        mid_band_ratio: mid_energy / total_band_energy,
        high_band_ratio: high_energy / total_band_energy,
    }
}

fn sixteenth_pattern(
    left: &[f32],
    right: &[f32],
    sample_rate: u32,
    beats: &[BeatGridEntry],
) -> [f64; SIXTEENTHS_PER_BAR] {
    let mut energy = [0.0_f64; SIXTEENTHS_PER_BAR];
    let mut counts = [0_usize; SIXTEENTHS_PER_BAR];
    for (beat_index, beat) in beats.iter().enumerate() {
        let Some(next) = beats.get(beat_index + 1) else {
            break;
        };
        let start = milliseconds_to_frame(beat.time_ms, sample_rate).min(left.len());
        let end = milliseconds_to_frame(next.time_ms, sample_rate).min(left.len());
        if end <= start {
            continue;
        }
        for subdivision in 0..4 {
            let sub_start = start + (end - start) * subdivision / 4;
            let sub_end = start + (end - start) * (subdivision + 1) / 4;
            let phase = ((usize::from(beat.beat.saturating_sub(1)) % 4) * 4 + subdivision)
                % SIXTEENTHS_PER_BAR;
            let range = SectionRange {
                start_frame: sub_start,
                end_frame: sub_end,
            };
            let db = stereo_rms_db(left, right, range);
            energy[phase] += db_to_power(db);
            counts[phase] += 1;
        }
    }
    for (value, count) in energy.iter_mut().zip(counts) {
        *value = if count == 0 {
            -120.0
        } else {
            gain_to_db((*value / count as f64).sqrt())
        };
    }
    let max = energy.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    for value in &mut energy {
        *value = (*value - max).max(-60.0);
    }
    energy
}

fn syncopation_ratio(pattern: &[f64; SIXTEENTHS_PER_BAR]) -> f64 {
    let mut on_grid = 0.0;
    let mut off_grid = 0.0;
    for (index, db) in pattern.iter().enumerate() {
        if index % 4 == 0 {
            on_grid += db_to_power(*db);
        } else {
            off_grid += db_to_power(*db);
        }
    }
    off_grid / (on_grid + off_grid).max(f64::EPSILON)
}

fn section_ranges(analysis: &GeneratedAnalysis, sample_rate: u32) -> Vec<SectionRange> {
    analysis
        .song_structure
        .entries
        .iter()
        .enumerate()
        .map(|(index, entry)| {
            let start = beat_frame(&analysis.beat.beats, entry.beat, sample_rate);
            let end = analysis
                .song_structure
                .entries
                .get(index + 1)
                .map(|next| beat_frame(&analysis.beat.beats, next.beat, sample_rate))
                .unwrap_or_else(|| {
                    (analysis.duration_seconds * f64::from(sample_rate)).round() as usize
                });
            SectionRange {
                start_frame: start,
                end_frame: end.max(start + 1),
            }
        })
        .collect()
}

fn build_sections(
    analysis: &GeneratedAnalysis,
    stems: &BTreeMap<String, SourceProfile>,
) -> Vec<SectionProfile> {
    analysis
        .song_structure
        .entries
        .iter()
        .enumerate()
        .map(|(index, entry)| {
            let feature = analysis
                .song_structure
                .diagnostics
                .phrase_features
                .get(index)
                .copied()
                .unwrap_or_else(|| PhraseFeatureDiagnostics {
                    index: entry.index,
                    beat: entry.beat,
                    ..PhraseFeatureDiagnostics::default()
                });
            let stem_rms_db = stems
                .iter()
                .filter_map(|(name, profile)| {
                    profile
                        .section_rms_db
                        .get(index)
                        .copied()
                        .map(|rms| (name.clone(), rms))
                })
                .collect();
            SectionProfile {
                index: entry.index,
                start_beat: entry.beat,
                start_seconds: beat_seconds(&analysis.beat.beats, entry.beat),
                duration_bars: feature.duration_bars,
                kind: entry.kind,
                energy_z: feature.energy_z,
                low_band_z: feature.low_band_z,
                mid_band_z: feature.mid_band_z,
                high_band_z: feature.high_band_z,
                onset_z: feature.onset_z,
                energy_delta_z: feature.energy_delta_z,
                distance_from_previous: feature.distance_from_previous,
                stem_rms_db,
            }
        })
        .collect()
}

fn relationships(
    mix: &SourceProfile,
    stems: &BTreeMap<String, SourceProfile>,
) -> RelationshipProfile {
    let drums = stems.get("drums");
    let offset = |name: &str| Some(stems.get(name)?.rms_db - drums?.rms_db);
    let mut active_stems_per_section = Vec::with_capacity(mix.section_rms_db.len());
    for index in 0..mix.section_rms_db.len() {
        active_stems_per_section.push(
            stems
                .values()
                .filter(|stem| {
                    stem.section_rms_db
                        .get(index)
                        .is_some_and(|rms| *rms > stem.rms_db - 24.0)
                })
                .count(),
        );
    }
    RelationshipProfile {
        bass_to_drums_rms_db: offset("bass"),
        other_to_drums_rms_db: offset("other"),
        vocals_to_drums_rms_db: offset("vocals"),
        section_contrast_db: percentile(&mix.section_rms_db, 0.90)
            - percentile(&mix.section_rms_db, 0.10),
        active_stems_per_section,
    }
}

fn stereo_rms_db(left: &[f32], right: &[f32], range: SectionRange) -> f64 {
    let start = range.start_frame.min(left.len()).min(right.len());
    let end = range.end_frame.min(left.len()).min(right.len());
    if end <= start {
        return -120.0;
    }
    let sum = left[start..end]
        .iter()
        .zip(&right[start..end])
        .map(|(left, right)| 0.5 * (f64::from(*left).powi(2) + f64::from(*right).powi(2)))
        .sum::<f64>();
    gain_to_db((sum / (end - start) as f64).sqrt())
}

fn beat_frame(beats: &[BeatGridEntry], one_based_beat: u16, sample_rate: u32) -> usize {
    beats
        .get(usize::from(one_based_beat.saturating_sub(1)))
        .map(|beat| milliseconds_to_frame(beat.time_ms, sample_rate))
        .unwrap_or_default()
}

fn beat_seconds(beats: &[BeatGridEntry], one_based_beat: u16) -> f64 {
    beats
        .get(usize::from(one_based_beat.saturating_sub(1)))
        .map(|beat| f64::from(beat.time_ms) / 1_000.0)
        .unwrap_or_default()
}

fn milliseconds_to_frame(milliseconds: u32, sample_rate: u32) -> usize {
    (f64::from(milliseconds) * f64::from(sample_rate) / 1_000.0).round() as usize
}

fn percentile(values: &[f64], quantile: f64) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    let mut values = values.to_vec();
    values.sort_by(f64::total_cmp);
    let index = ((values.len() - 1) as f64 * quantile.clamp(0.0, 1.0)).round() as usize;
    values[index]
}

fn one_pole_alpha(cutoff_hz: f64, sample_rate: u32) -> f64 {
    1.0 - (-2.0 * std::f64::consts::PI * cutoff_hz / f64::from(sample_rate)).exp()
}

fn gain_to_db(value: f64) -> f64 {
    20.0 * value.max(1.0e-12).log10()
}

fn db_to_gain(db: f64) -> f64 {
    10.0_f64.powf(db / 20.0)
}

fn db_to_power(db: f64) -> f64 {
    10.0_f64.powf(db / 10.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percentile_is_deterministic() {
        assert_eq!(percentile(&[4.0, 1.0, 3.0, 2.0], 0.0), 1.0);
        assert_eq!(percentile(&[4.0, 1.0, 3.0, 2.0], 1.0), 4.0);
    }

    #[test]
    fn syncopation_distinguishes_quarter_notes() {
        let mut quarters = [-60.0; SIXTEENTHS_PER_BAR];
        for phase in [0, 4, 8, 12] {
            quarters[phase] = 0.0;
        }
        assert!(syncopation_ratio(&quarters) < 0.001);
    }

    #[test]
    fn fit_score_rewards_close_targets() {
        assert_eq!(fit_score(0.0, 1.0), 100.0);
        assert!(fit_score(0.5, 1.0) > fit_score(2.0, 1.0));
    }

    #[test]
    fn phrase_histograms_compare_proportions_not_track_length() {
        let reference = BTreeMap::from([(8, 16), (16, 8)]);
        let scaled_candidate = BTreeMap::from([(8, 4), (16, 2)]);
        let different_candidate = BTreeMap::from([(4, 4), (8, 2)]);
        assert!((histogram_similarity(&reference, &scaled_candidate) - 1.0).abs() < 1.0e-9);
        assert!(histogram_similarity(&reference, &different_candidate) < 0.5);
    }
}
