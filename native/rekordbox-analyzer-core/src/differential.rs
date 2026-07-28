use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::anlz::{
    AnlzFile, AnlzTag, BeatGridEntry, CountedWaveform, DatAnalysis, ExtAnalysis, ThreeBandAnalysis,
};

const OUTPUT_NAMES: [&str; 3] = ["ANLZ0000.DAT", "ANLZ0000.EXT", "ANLZ0000.2EX"];
const MAX_BEAT_ALIGNMENT_CELLS: usize = 25_000_000;

/// First byte at which two files differ.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FirstDifference {
    pub offset: usize,
    pub reference: Option<u8>,
    pub candidate: Option<u8>,
}

/// Structural and byte comparison for one same-position tag.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagDifferential {
    pub index: usize,
    pub reference_kind: Option<String>,
    pub candidate_kind: Option<String>,
    pub reference_len: Option<usize>,
    pub candidate_len: Option<usize>,
    pub reference_sha256: Option<String>,
    pub candidate_sha256: Option<String>,
    pub exact: bool,
    pub first_difference: Option<FirstDifference>,
}

/// Byte and tag differential for one DAT, EXT, or 2EX file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDifferential {
    pub name: String,
    pub reference_path: PathBuf,
    pub candidate_path: PathBuf,
    pub reference_len: usize,
    pub candidate_len: usize,
    pub reference_sha256: String,
    pub candidate_sha256: String,
    pub exact: bool,
    pub first_difference: Option<FirstDifference>,
    pub tags: Vec<TagDifferential>,
}

/// Complete three-file analyzer differential.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DifferentialReport {
    pub reference_directory: PathBuf,
    pub candidate_directory: PathBuf,
    pub exact: bool,
    pub files: Vec<FileDifferential>,
}

/// One endpoint in a sub-millisecond beat-grid summary.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BeatGridEndpoint {
    pub beat: u16,
    pub bpm: f64,
    pub time_ms: f64,
}

/// Absolute aligned timestamp-error distribution, in milliseconds.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimestampErrorDistribution {
    pub mean_ms: f64,
    pub median_ms: f64,
    pub p95_ms: f64,
    pub max_ms: f64,
}

/// Absolute aligned tempo-error distribution, in beats per minute.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TempoErrorDistribution {
    pub mean_bpm: f64,
    pub median_bpm: f64,
    pub p95_bpm: f64,
    pub max_bpm: f64,
}

/// Precision/recall/F1 for aligned beats inside one timing collar.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BeatMatchRate {
    pub tolerance_ms: f64,
    pub matches: usize,
    pub precision: f64,
    pub recall: f64,
    pub f1: f64,
}

/// Semantic PQTZ/PQT2 comparison with monotonic insertion/deletion alignment.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BeatGridDifferential {
    pub reference_directory: PathBuf,
    pub candidate_directory: PathBuf,
    pub reference_beat_count: usize,
    pub candidate_beat_count: usize,
    pub matched_beats: usize,
    pub reference_unmatched_beats: usize,
    pub candidate_unmatched_beats: usize,
    pub reference_first: BeatGridEndpoint,
    pub candidate_first: BeatGridEndpoint,
    pub reference_last: BeatGridEndpoint,
    pub candidate_last: BeatGridEndpoint,
    pub first_timestamp_error_ms: f64,
    pub last_timestamp_error_ms: f64,
    pub aligned_timestamp_error: TimestampErrorDistribution,
    pub drift_ms_per_100_beats: f64,
    /// Candidate beat number minus reference beat number, modulo four.
    pub beat_number_phase: u8,
    pub beat_number_accuracy: f64,
    pub reference_tempo_changes: usize,
    pub candidate_tempo_changes: usize,
    pub aligned_tempo_error: TempoErrorDistribution,
    pub reference_downbeat_count: usize,
    pub candidate_downbeat_count: usize,
    pub matched_downbeats: usize,
    pub downbeat_timestamp_error: TimestampErrorDistribution,
    pub at_70_ms: BeatMatchRate,
    pub at_100_ms: BeatMatchRate,
}

/// Same-column scalar errors for one decoded waveform component.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WaveformComponentDifferential {
    pub name: String,
    pub reference_count: usize,
    pub candidate_count: usize,
    pub overlap_count: usize,
    pub count_delta: i64,
    pub exact_values: usize,
    pub exact_fraction: f64,
    pub correlation: Option<f64>,
    pub mean_reference: f64,
    pub mean_candidate: f64,
    pub mean_absolute_error: f64,
    pub median_absolute_error: f64,
    pub p95_absolute_error: f64,
    pub max_absolute_error: f64,
    pub signed_mean_error: f64,
}

/// Semantic component comparison for one Rekordbox waveform tag.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WaveformTagDifferential {
    pub kind: String,
    pub entry_bytes: usize,
    pub reference_count: usize,
    pub candidate_count: usize,
    pub count_delta: i64,
    pub components: Vec<WaveformComponentDifferential>,
}

/// Semantic PWAV/PWV2/PWV3/PWV4/PWV5/PWV6/PWV7 comparison.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WaveformDifferential {
    pub reference_directory: PathBuf,
    pub candidate_directory: PathBuf,
    pub waveforms: Vec<WaveformTagDifferential>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct PreciseBeat {
    entry: BeatGridEntry,
    time_us: u64,
}

/// Compare DAT, EXT, and 2EX outputs byte-for-byte and section-by-section.
pub fn compare_output_directories(
    reference_directory: &Path,
    candidate_directory: &Path,
) -> Result<DifferentialReport> {
    let mut files = Vec::with_capacity(OUTPUT_NAMES.len());
    for name in OUTPUT_NAMES {
        let reference_path = reference_directory.join(name);
        let candidate_path = candidate_directory.join(name);
        files.push(compare_file(name, &reference_path, &candidate_path)?);
    }
    Ok(DifferentialReport {
        reference_directory: reference_directory.to_path_buf(),
        candidate_directory: candidate_directory.to_path_buf(),
        exact: files.iter().all(|file| file.exact),
        files,
    })
}

/// Compare the PQTZ grids and PQT2 sub-millisecond residuals in two output directories.
pub fn compare_beat_grids(
    reference_directory: &Path,
    candidate_directory: &Path,
) -> Result<BeatGridDifferential> {
    let reference = read_precise_beat_grid(reference_directory)?;
    let candidate = read_precise_beat_grid(candidate_directory)?;
    let alignment = align_beats(&reference, &candidate)?;
    let timestamp_errors_us = alignment
        .matches
        .iter()
        .map(|&(reference_index, candidate_index)| {
            candidate[candidate_index]
                .time_us
                .abs_diff(reference[reference_index].time_us)
        })
        .collect::<Vec<_>>();
    let signed_timestamp_errors_ms = alignment
        .matches
        .iter()
        .map(|&(reference_index, candidate_index)| {
            (candidate[candidate_index].time_us as f64 - reference[reference_index].time_us as f64)
                / 1_000.0
        })
        .collect::<Vec<_>>();
    let tempo_errors_hundredths = alignment
        .matches
        .iter()
        .map(|&(reference_index, candidate_index)| {
            candidate[candidate_index]
                .entry
                .bpm_hundredths
                .abs_diff(reference[reference_index].entry.bpm_hundredths)
        })
        .collect::<Vec<_>>();
    let mut phases = [0usize; 4];
    let exact_beat_numbers = alignment
        .matches
        .iter()
        .filter(|&&(reference_index, candidate_index)| {
            let reference_beat = reference[reference_index].entry.beat;
            let candidate_beat = candidate[candidate_index].entry.beat;
            let phase = (candidate_beat + 4 - reference_beat) % 4;
            phases[usize::from(phase)] += 1;
            phase == 0
        })
        .count();
    let beat_number_phase = phases
        .iter()
        .enumerate()
        .max_by_key(|&(phase, count)| (*count, std::cmp::Reverse(phase)))
        .map(|(phase, _)| phase as u8)
        .unwrap_or_default();

    let reference_downbeats = reference
        .iter()
        .copied()
        .filter(|beat| beat.entry.beat == 1)
        .collect::<Vec<_>>();
    let candidate_downbeats = candidate
        .iter()
        .copied()
        .filter(|beat| beat.entry.beat == 1)
        .collect::<Vec<_>>();
    let downbeat_alignment = align_beats(&reference_downbeats, &candidate_downbeats)?;
    let downbeat_errors_us = downbeat_alignment
        .matches
        .iter()
        .map(|&(reference_index, candidate_index)| {
            candidate_downbeats[candidate_index]
                .time_us
                .abs_diff(reference_downbeats[reference_index].time_us)
        })
        .collect::<Vec<_>>();

    Ok(BeatGridDifferential {
        reference_directory: reference_directory.to_path_buf(),
        candidate_directory: candidate_directory.to_path_buf(),
        reference_beat_count: reference.len(),
        candidate_beat_count: candidate.len(),
        matched_beats: alignment.matches.len(),
        reference_unmatched_beats: alignment.reference_unmatched,
        candidate_unmatched_beats: alignment.candidate_unmatched,
        reference_first: endpoint(reference[0]),
        candidate_first: endpoint(candidate[0]),
        reference_last: endpoint(*reference.last().expect("validated non-empty grid")),
        candidate_last: endpoint(*candidate.last().expect("validated non-empty grid")),
        first_timestamp_error_ms: signed_error_ms(candidate[0], reference[0]),
        last_timestamp_error_ms: signed_error_ms(
            *candidate.last().expect("validated non-empty grid"),
            *reference.last().expect("validated non-empty grid"),
        ),
        aligned_timestamp_error: timestamp_distribution(&timestamp_errors_us),
        drift_ms_per_100_beats: drift_per_100_beats(
            &alignment.matches,
            &signed_timestamp_errors_ms,
        ),
        beat_number_phase,
        beat_number_accuracy: exact_beat_numbers as f64 / alignment.matches.len().max(1) as f64,
        reference_tempo_changes: tempo_change_count(&reference),
        candidate_tempo_changes: tempo_change_count(&candidate),
        aligned_tempo_error: tempo_distribution(&tempo_errors_hundredths),
        reference_downbeat_count: reference_downbeats.len(),
        candidate_downbeat_count: candidate_downbeats.len(),
        matched_downbeats: downbeat_alignment.matches.len(),
        downbeat_timestamp_error: timestamp_distribution(&downbeat_errors_us),
        at_70_ms: match_rate(
            &timestamp_errors_us,
            reference.len(),
            candidate.len(),
            70_000,
        ),
        at_100_ms: match_rate(
            &timestamp_errors_us,
            reference.len(),
            candidate.len(),
            100_000,
        ),
    })
}

/// Compare all Rekordbox waveform tags by decoded same-column components.
pub fn compare_waveforms(
    reference_directory: &Path,
    candidate_directory: &Path,
) -> Result<WaveformDifferential> {
    let reference = read_semantic_waveforms(reference_directory)?;
    let candidate = read_semantic_waveforms(candidate_directory)?;
    if reference.len() != candidate.len() {
        bail!(
            "waveform tag count differs: reference {} candidate {}",
            reference.len(),
            candidate.len()
        );
    }
    let waveforms = reference
        .iter()
        .zip(&candidate)
        .map(|(reference, candidate)| compare_semantic_waveform(reference, candidate))
        .collect::<Result<Vec<_>>>()?;
    Ok(WaveformDifferential {
        reference_directory: reference_directory.to_path_buf(),
        candidate_directory: candidate_directory.to_path_buf(),
        waveforms,
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SemanticWaveform {
    kind: &'static str,
    entry_bytes: usize,
    components: Vec<(&'static str, Vec<u8>)>,
}

impl SemanticWaveform {
    fn count(&self) -> usize {
        self.components
            .first()
            .map(|(_, values)| values.len())
            .unwrap_or_default()
    }
}

fn read_semantic_waveforms(directory: &Path) -> Result<Vec<SemanticWaveform>> {
    let dat_path = directory.join("ANLZ0000.DAT");
    let ext_path = directory.join("ANLZ0000.EXT");
    let two_ex_path = directory.join("ANLZ0000.2EX");
    let dat = DatAnalysis::parse(&AnlzFile::read(&dat_path)?)
        .with_context(|| format!("invalid waveform file {}", dat_path.display()))?;
    let ext = ExtAnalysis::parse(&AnlzFile::read(&ext_path)?)
        .with_context(|| format!("invalid waveform file {}", ext_path.display()))?;
    let two_ex = ThreeBandAnalysis::parse(&AnlzFile::read(&two_ex_path)?)
        .with_context(|| format!("invalid waveform file {}", two_ex_path.display()))?;

    Ok(vec![
        decode_waveform("PWAV", 1, &dat.preview_waveform)?,
        decode_waveform("PWV2", 1, &dat.tiny_preview_waveform)?,
        decode_counted_waveform(&ext.detail_waveform)?,
        decode_counted_waveform(&ext.color_preview_waveform)?,
        decode_counted_waveform(&ext.color_detail_waveform)?,
        decode_counted_waveform(&two_ex.preview_waveform)?,
        decode_counted_waveform(&two_ex.detail_waveform)?,
    ])
}

fn decode_counted_waveform(waveform: &CountedWaveform) -> Result<SemanticWaveform> {
    decode_waveform(
        match &waveform.kind {
            b"PWV3" => "PWV3",
            b"PWV4" => "PWV4",
            b"PWV5" => "PWV5",
            b"PWV6" => "PWV6",
            b"PWV7" => "PWV7",
            kind => bail!(
                "{} is not a supported semantic waveform",
                String::from_utf8_lossy(kind)
            ),
        },
        usize::try_from(waveform.entry_bytes).context("waveform entry width overflow")?,
        &waveform.entries,
    )
}

fn decode_waveform(
    kind: &'static str,
    entry_bytes: usize,
    entries: &[u8],
) -> Result<SemanticWaveform> {
    let expected_entry_bytes = match kind {
        "PWAV" | "PWV2" | "PWV3" => 1,
        "PWV5" => 2,
        "PWV6" | "PWV7" => 3,
        "PWV4" => 6,
        _ => bail!("{kind} is not a supported semantic waveform"),
    };
    if entry_bytes != expected_entry_bytes || !entries.len().is_multiple_of(entry_bytes) {
        bail!(
            "{kind} requires {expected_entry_bytes}-byte entries, received width {entry_bytes} and {} bytes",
            entries.len()
        );
    }
    let components = match kind {
        "PWAV" | "PWV3" => vec![
            ("height", entries.iter().map(|value| value & 0x1f).collect()),
            (
                "whiteness",
                entries.iter().map(|value| value >> 5).collect(),
            ),
        ],
        "PWV2" => vec![
            ("height", entries.iter().map(|value| value & 0x0f).collect()),
            (
                "unusedHigh",
                entries.iter().map(|value| value >> 4).collect(),
            ),
        ],
        "PWV4" => {
            let names = [
                "amplitude",
                "inverseLuminance",
                "bottom",
                "red",
                "green",
                "blue",
            ];
            names
                .into_iter()
                .enumerate()
                .map(|(component, name)| {
                    (
                        name,
                        entries
                            .chunks_exact(entry_bytes)
                            .map(|entry| entry[component])
                            .collect(),
                    )
                })
                .collect()
        }
        "PWV5" => {
            let values = entries
                .chunks_exact(entry_bytes)
                .map(|entry| u16::from_be_bytes([entry[0], entry[1]]))
                .collect::<Vec<_>>();
            vec![
                (
                    "red",
                    values
                        .iter()
                        .map(|value| ((value >> 13) & 7) as u8)
                        .collect(),
                ),
                (
                    "green",
                    values
                        .iter()
                        .map(|value| ((value >> 10) & 7) as u8)
                        .collect(),
                ),
                (
                    "blue",
                    values
                        .iter()
                        .map(|value| ((value >> 7) & 7) as u8)
                        .collect(),
                ),
                (
                    "height",
                    values
                        .iter()
                        .map(|value| ((value >> 2) & 31) as u8)
                        .collect(),
                ),
                (
                    "unusedLow",
                    values.iter().map(|value| (value & 3) as u8).collect(),
                ),
            ]
        }
        // A 114-track Rekordbox 6.8.2 corpus and pure-tone probes establish
        // low/mid/high byte order, despite older public notes describing
        // mid/high/low.
        "PWV6" | "PWV7" => ["low", "mid", "high"]
            .into_iter()
            .enumerate()
            .map(|(component, name)| {
                (
                    name,
                    entries
                        .chunks_exact(entry_bytes)
                        .map(|entry| entry[component])
                        .collect(),
                )
            })
            .collect(),
        _ => unreachable!("validated waveform kind"),
    };
    Ok(SemanticWaveform {
        kind,
        entry_bytes,
        components,
    })
}

fn compare_semantic_waveform(
    reference: &SemanticWaveform,
    candidate: &SemanticWaveform,
) -> Result<WaveformTagDifferential> {
    if reference.kind != candidate.kind
        || reference.entry_bytes != candidate.entry_bytes
        || reference.components.len() != candidate.components.len()
    {
        bail!(
            "waveform shape mismatch: reference {} candidate {}",
            reference.kind,
            candidate.kind
        );
    }
    let components = reference
        .components
        .iter()
        .zip(&candidate.components)
        .map(
            |((reference_name, reference_values), (candidate_name, candidate_values))| {
            if reference_name != candidate_name {
                bail!(
                    "{} component mismatch: reference {reference_name} candidate {candidate_name}",
                    reference.kind
                );
            }
            compare_waveform_component(
                reference_name,
                reference_values,
                candidate_values,
            )
        },
        )
        .collect::<Result<Vec<_>>>()?;
    Ok(WaveformTagDifferential {
        kind: reference.kind.to_string(),
        entry_bytes: reference.entry_bytes,
        reference_count: reference.count(),
        candidate_count: candidate.count(),
        count_delta: count_delta(reference.count(), candidate.count())?,
        components,
    })
}

fn compare_waveform_component(
    name: &str,
    reference: &[u8],
    candidate: &[u8],
) -> Result<WaveformComponentDifferential> {
    let reference_count = reference.len();
    let candidate_count = candidate.len();
    let overlap_count = reference_count.min(candidate_count);
    let reference = &reference[..overlap_count];
    let candidate = &candidate[..overlap_count];
    let absolute_errors = reference
        .iter()
        .zip(candidate)
        .map(|(reference, candidate)| reference.abs_diff(*candidate))
        .collect::<Vec<_>>();
    let mut sorted_errors = absolute_errors.clone();
    sorted_errors.sort_unstable();
    let signed_error_sum = reference
        .iter()
        .zip(candidate)
        .map(|(reference, candidate)| f64::from(*candidate) - f64::from(*reference))
        .sum::<f64>();
    let denominator = overlap_count.max(1) as f64;
    let exact_values = absolute_errors.iter().filter(|error| **error == 0).count();
    Ok(WaveformComponentDifferential {
        name: name.to_string(),
        reference_count,
        candidate_count,
        overlap_count,
        count_delta: count_delta(reference_count, candidate_count)?,
        exact_values,
        exact_fraction: exact_values as f64 / denominator,
        correlation: pearson_correlation(reference, candidate),
        mean_reference: reference.iter().map(|value| f64::from(*value)).sum::<f64>() / denominator,
        mean_candidate: candidate.iter().map(|value| f64::from(*value)).sum::<f64>() / denominator,
        mean_absolute_error: absolute_errors
            .iter()
            .map(|value| f64::from(*value))
            .sum::<f64>()
            / denominator,
        median_absolute_error: f64::from(percentile(&sorted_errors, 0.50)),
        p95_absolute_error: f64::from(percentile(&sorted_errors, 0.95)),
        max_absolute_error: f64::from(sorted_errors.last().copied().unwrap_or_default()),
        signed_mean_error: signed_error_sum / denominator,
    })
}

fn count_delta(reference: usize, candidate: usize) -> Result<i64> {
    let reference = i64::try_from(reference).context("reference waveform count exceeds i64")?;
    let candidate = i64::try_from(candidate).context("candidate waveform count exceeds i64")?;
    Ok(candidate - reference)
}

fn pearson_correlation(reference: &[u8], candidate: &[u8]) -> Option<f64> {
    let count = reference.len().min(candidate.len());
    if count < 2 {
        return None;
    }
    let mean_reference = reference[..count]
        .iter()
        .map(|value| f64::from(*value))
        .sum::<f64>()
        / count as f64;
    let mean_candidate = candidate[..count]
        .iter()
        .map(|value| f64::from(*value))
        .sum::<f64>()
        / count as f64;
    let (covariance, reference_variance, candidate_variance) =
        reference[..count].iter().zip(&candidate[..count]).fold(
            (0.0, 0.0, 0.0),
            |(covariance, reference_variance, candidate_variance), (reference, candidate)| {
                let reference = f64::from(*reference) - mean_reference;
                let candidate = f64::from(*candidate) - mean_candidate;
                (
                    covariance + reference * candidate,
                    reference_variance + reference * reference,
                    candidate_variance + candidate * candidate,
                )
            },
        );
    let denominator = (reference_variance * candidate_variance).sqrt();
    (denominator > f64::EPSILON).then_some((covariance / denominator).clamp(-1.0, 1.0))
}

fn read_precise_beat_grid(directory: &Path) -> Result<Vec<PreciseBeat>> {
    let dat_path = directory.join("ANLZ0000.DAT");
    let ext_path = directory.join("ANLZ0000.EXT");
    let dat_bytes = std::fs::read(&dat_path)
        .with_context(|| format!("failed to read beat grid {}", dat_path.display()))?;
    let ext_bytes = std::fs::read(&ext_path)
        .with_context(|| format!("failed to read extended beat grid {}", ext_path.display()))?;
    let dat = DatAnalysis::parse(
        &AnlzFile::parse(&dat_bytes)
            .with_context(|| format!("invalid beat grid {}", dat_path.display()))?,
    )?;
    let ext = ExtAnalysis::parse(
        &AnlzFile::parse(&ext_bytes)
            .with_context(|| format!("invalid extended beat grid {}", ext_path.display()))?,
    )?;
    if dat.beat_grid.is_empty() {
        bail!("{} contains an empty PQTZ beat grid", dat_path.display());
    }
    if ext.extended_beat_grid.entries.len() != dat.beat_grid.len() {
        bail!(
            "{} PQT2 count {} does not match {} PQTZ count {}",
            ext_path.display(),
            ext.extended_beat_grid.entries.len(),
            dat_path.display(),
            dat.beat_grid.len()
        );
    }
    let expected_anchors = [
        dat.beat_grid[0],
        *dat.beat_grid.last().expect("validated non-empty grid"),
    ];
    if ext.extended_beat_grid.anchors != expected_anchors {
        bail!(
            "{} PQT2 anchors do not match the first and last PQTZ entries",
            ext_path.display()
        );
    }

    let beats = dat
        .beat_grid
        .into_iter()
        .zip(ext.extended_beat_grid.entries)
        .enumerate()
        .map(|(index, (entry, residual_bytes))| {
            let residual_us = u16::from_be_bytes(residual_bytes);
            if residual_us > 999 {
                bail!(
                    "{} PQT2 entry {index} has invalid microsecond residual {residual_us}",
                    ext_path.display()
                );
            }
            Ok(PreciseBeat {
                entry,
                time_us: u64::from(entry.time_ms) * 1_000 + u64::from(residual_us),
            })
        })
        .collect::<Result<Vec<_>>>()?;
    if let Some((index, _)) = beats
        .windows(2)
        .enumerate()
        .find(|(_, pair)| pair[1].time_us <= pair[0].time_us)
    {
        bail!(
            "{} PQTZ/PQT2 time is not strictly increasing at entries {index} and {}",
            dat_path.display(),
            index + 1
        );
    }
    Ok(beats)
}

#[derive(Debug, Default)]
struct BeatAlignment {
    matches: Vec<(usize, usize)>,
    reference_unmatched: usize,
    candidate_unmatched: usize,
}

fn align_beats(reference: &[PreciseBeat], candidate: &[PreciseBeat]) -> Result<BeatAlignment> {
    if reference.is_empty() || candidate.is_empty() {
        return Ok(BeatAlignment {
            matches: Vec::new(),
            reference_unmatched: reference.len(),
            candidate_unmatched: candidate.len(),
        });
    }
    let Some(cells) = (reference.len() + 1).checked_mul(candidate.len() + 1) else {
        bail!("beat-grid alignment dimensions overflow");
    };
    if cells > MAX_BEAT_ALIGNMENT_CELLS {
        bail!(
            "beat-grid alignment requires {cells} cells for {} x {} beats; maximum is {MAX_BEAT_ALIGNMENT_CELLS}",
            reference.len(),
            candidate.len()
        );
    }
    let gap_cost = median_period_us(reference).saturating_mul(45) / 100;
    let columns = candidate.len() + 1;
    let mut trace = vec![0u8; (reference.len() + 1) * columns];
    let mut previous = (0..=candidate.len())
        .map(|count| gap_cost.saturating_mul(count as u64))
        .collect::<Vec<_>>();
    let mut current = vec![0u64; columns];
    for reference_index in 1..=reference.len() {
        current[0] = gap_cost.saturating_mul(reference_index as u64);
        trace[reference_index * columns] = 2;
        for candidate_index in 1..=candidate.len() {
            let match_cost = previous[candidate_index - 1].saturating_add(
                reference[reference_index - 1]
                    .time_us
                    .abs_diff(candidate[candidate_index - 1].time_us),
            );
            let delete_cost = previous[candidate_index].saturating_add(gap_cost);
            let insert_cost = current[candidate_index - 1].saturating_add(gap_cost);
            let (cost, operation) = if match_cost <= delete_cost && match_cost <= insert_cost {
                (match_cost, 1)
            } else if delete_cost <= insert_cost {
                (delete_cost, 2)
            } else {
                (insert_cost, 3)
            };
            current[candidate_index] = cost;
            trace[reference_index * columns + candidate_index] = operation;
        }
        std::mem::swap(&mut previous, &mut current);
    }

    let mut result = BeatAlignment::default();
    let mut reference_index = reference.len();
    let mut candidate_index = candidate.len();
    while reference_index > 0 || candidate_index > 0 {
        let operation = trace[reference_index * columns + candidate_index];
        match operation {
            1 => {
                reference_index -= 1;
                candidate_index -= 1;
                result.matches.push((reference_index, candidate_index));
            }
            2 => {
                reference_index -= 1;
                result.reference_unmatched += 1;
            }
            3 => {
                candidate_index -= 1;
                result.candidate_unmatched += 1;
            }
            _ if reference_index > 0 => {
                reference_index -= 1;
                result.reference_unmatched += 1;
            }
            _ => {
                candidate_index -= 1;
                result.candidate_unmatched += 1;
            }
        }
    }
    result.matches.reverse();
    Ok(result)
}

fn median_period_us(beats: &[PreciseBeat]) -> u64 {
    let mut periods = beats
        .windows(2)
        .map(|pair| pair[1].time_us.saturating_sub(pair[0].time_us))
        .filter(|period| *period > 0)
        .collect::<Vec<_>>();
    if periods.is_empty() {
        return 500_000;
    }
    periods.sort_unstable();
    periods[periods.len() / 2]
}

fn endpoint(beat: PreciseBeat) -> BeatGridEndpoint {
    BeatGridEndpoint {
        beat: beat.entry.beat,
        bpm: f64::from(beat.entry.bpm_hundredths) / 100.0,
        time_ms: beat.time_us as f64 / 1_000.0,
    }
}

fn signed_error_ms(candidate: PreciseBeat, reference: PreciseBeat) -> f64 {
    (candidate.time_us as f64 - reference.time_us as f64) / 1_000.0
}

fn timestamp_distribution(values_us: &[u64]) -> TimestampErrorDistribution {
    let mut sorted = values_us.to_vec();
    sorted.sort_unstable();
    TimestampErrorDistribution {
        mean_ms: sorted.iter().map(|value| *value as f64).sum::<f64>()
            / sorted.len().max(1) as f64
            / 1_000.0,
        median_ms: percentile(&sorted, 0.50) as f64 / 1_000.0,
        p95_ms: percentile(&sorted, 0.95) as f64 / 1_000.0,
        max_ms: sorted.last().copied().unwrap_or_default() as f64 / 1_000.0,
    }
}

fn tempo_distribution(values_hundredths: &[u16]) -> TempoErrorDistribution {
    let mut sorted = values_hundredths.to_vec();
    sorted.sort_unstable();
    TempoErrorDistribution {
        mean_bpm: sorted.iter().map(|value| f64::from(*value)).sum::<f64>()
            / sorted.len().max(1) as f64
            / 100.0,
        median_bpm: f64::from(percentile(&sorted, 0.50)) / 100.0,
        p95_bpm: f64::from(percentile(&sorted, 0.95)) / 100.0,
        max_bpm: f64::from(sorted.last().copied().unwrap_or_default()) / 100.0,
    }
}

fn percentile<T: Copy + Default>(sorted: &[T], quantile: f64) -> T {
    if sorted.is_empty() {
        return T::default();
    }
    let index = ((sorted.len() - 1) as f64 * quantile).round() as usize;
    sorted[index.min(sorted.len() - 1)]
}

fn drift_per_100_beats(matches: &[(usize, usize)], signed_errors_ms: &[f64]) -> f64 {
    if matches.len() < 2 || matches.len() != signed_errors_ms.len() {
        return 0.0;
    }
    let mean_x = matches.iter().map(|(index, _)| *index as f64).sum::<f64>() / matches.len() as f64;
    let mean_y = signed_errors_ms.iter().sum::<f64>() / signed_errors_ms.len() as f64;
    let (covariance, variance) = matches.iter().zip(signed_errors_ms).fold(
        (0.0, 0.0),
        |(covariance, variance), ((index, _), error)| {
            let centered_x = *index as f64 - mean_x;
            (
                covariance + centered_x * (*error - mean_y),
                variance + centered_x * centered_x,
            )
        },
    );
    if variance > f64::EPSILON {
        covariance / variance * 100.0
    } else {
        0.0
    }
}

fn tempo_change_count(beats: &[PreciseBeat]) -> usize {
    beats
        .windows(2)
        .filter(|pair| pair[0].entry.bpm_hundredths != pair[1].entry.bpm_hundredths)
        .count()
}

fn match_rate(
    aligned_errors_us: &[u64],
    reference_count: usize,
    candidate_count: usize,
    tolerance_us: u64,
) -> BeatMatchRate {
    let matches = aligned_errors_us
        .iter()
        .filter(|error| **error <= tolerance_us)
        .count();
    let precision = matches as f64 / candidate_count.max(1) as f64;
    let recall = matches as f64 / reference_count.max(1) as f64;
    let f1 = if precision + recall > 0.0 {
        2.0 * precision * recall / (precision + recall)
    } else {
        0.0
    };
    BeatMatchRate {
        tolerance_ms: tolerance_us as f64 / 1_000.0,
        matches,
        precision,
        recall,
        f1,
    }
}

fn compare_file(
    name: &str,
    reference_path: &Path,
    candidate_path: &Path,
) -> Result<FileDifferential> {
    let reference = std::fs::read(reference_path)
        .with_context(|| format!("failed to read reference {}", reference_path.display()))?;
    let candidate = std::fs::read(candidate_path)
        .with_context(|| format!("failed to read candidate {}", candidate_path.display()))?;
    let reference_file = AnlzFile::parse(&reference)
        .with_context(|| format!("invalid reference {}", reference_path.display()))?;
    let candidate_file = AnlzFile::parse(&candidate)
        .with_context(|| format!("invalid candidate {}", candidate_path.display()))?;
    let tag_count = reference_file.tags().len().max(candidate_file.tags().len());
    let tags = (0..tag_count)
        .map(|index| {
            compare_tag(
                index,
                reference_file.tags().get(index),
                candidate_file.tags().get(index),
            )
        })
        .collect();
    Ok(FileDifferential {
        name: name.to_string(),
        reference_path: reference_path.to_path_buf(),
        candidate_path: candidate_path.to_path_buf(),
        reference_len: reference.len(),
        candidate_len: candidate.len(),
        reference_sha256: sha256(&reference),
        candidate_sha256: sha256(&candidate),
        exact: reference == candidate,
        first_difference: first_difference(&reference, &candidate),
        tags,
    })
}

fn compare_tag(
    index: usize,
    reference: Option<&AnlzTag>,
    candidate: Option<&AnlzTag>,
) -> TagDifferential {
    let reference_raw = reference.map(AnlzTag::raw);
    let candidate_raw = candidate.map(AnlzTag::raw);
    TagDifferential {
        index,
        reference_kind: reference.map(AnlzTag::kind_text),
        candidate_kind: candidate.map(AnlzTag::kind_text),
        reference_len: reference_raw.map(<[u8]>::len),
        candidate_len: candidate_raw.map(<[u8]>::len),
        reference_sha256: reference_raw.map(sha256),
        candidate_sha256: candidate_raw.map(sha256),
        exact: reference_raw == candidate_raw,
        first_difference: match (reference_raw, candidate_raw) {
            (Some(reference), Some(candidate)) => first_difference(reference, candidate),
            _ => None,
        },
    }
}

fn first_difference(reference: &[u8], candidate: &[u8]) -> Option<FirstDifference> {
    let shared_len = reference.len().min(candidate.len());
    let offset = (0..shared_len)
        .find(|index| reference[*index] != candidate[*index])
        .or_else(|| (reference.len() != candidate.len()).then_some(shared_len))?;
    Some(FirstDifference {
        offset,
        reference: reference.get(offset).copied(),
        candidate: candidate.get(offset).copied(),
    })
}

fn sha256(data: &[u8]) -> String {
    let digest = Sha256::digest(data);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::tempdir;

    use super::*;
    use crate::anlz::{AnlzFile, build_empty_cue_tag};

    fn fixture() -> Vec<u8> {
        AnlzFile::from_tags(vec![
            build_empty_cue_tag(1).expect("cue"),
            build_empty_cue_tag(0).expect("cue"),
        ])
        .expect("file")
        .to_bytes()
        .expect("bytes")
    }

    #[test]
    fn reports_exact_outputs_and_one_changed_payload_byte() {
        let reference = tempdir().expect("reference");
        let candidate = tempdir().expect("candidate");
        for name in OUTPUT_NAMES {
            fs::write(reference.path().join(name), fixture()).expect("reference fixture");
            fs::write(candidate.path().join(name), fixture()).expect("candidate fixture");
        }
        let exact =
            compare_output_directories(reference.path(), candidate.path()).expect("exact diff");
        assert!(exact.exact);

        let path = candidate.path().join("ANLZ0000.EXT");
        let mut changed = fs::read(&path).expect("read candidate");
        let last = changed.len() - 1;
        changed[last] ^= 1;
        fs::write(&path, changed).expect("write candidate");
        let report =
            compare_output_directories(reference.path(), candidate.path()).expect("changed diff");
        assert!(!report.exact);
        let ext = &report.files[1];
        assert_eq!(
            ext.first_difference,
            Some(FirstDifference {
                offset: fixture().len() - 1,
                reference: Some(0xff),
                candidate: Some(0xfe),
            })
        );
        assert!(!ext.tags[1].exact);
    }

    fn precise_beat(time_us: u64, beat: u16) -> PreciseBeat {
        PreciseBeat {
            entry: BeatGridEntry {
                beat,
                bpm_hundredths: 12_000,
                time_ms: u32::try_from(time_us / 1_000).expect("small fixture timestamp"),
            },
            time_us,
        }
    }

    #[test]
    fn semantic_alignment_retains_order_across_one_insertion() {
        let reference = [0, 500_000, 1_000_000, 1_500_000]
            .into_iter()
            .enumerate()
            .map(|(index, time_us)| precise_beat(time_us, (index % 4 + 1) as u16))
            .collect::<Vec<_>>();
        let candidate = [5_000, 505_000, 750_000, 1_005_000, 1_505_000]
            .into_iter()
            .enumerate()
            .map(|(index, time_us)| precise_beat(time_us, (index % 4 + 1) as u16))
            .collect::<Vec<_>>();

        let alignment = align_beats(&reference, &candidate).expect("bounded alignment");
        assert_eq!(alignment.matches, vec![(0, 0), (1, 1), (2, 3), (3, 4)]);
        assert_eq!(alignment.reference_unmatched, 0);
        assert_eq!(alignment.candidate_unmatched, 1);
        let errors = alignment
            .matches
            .iter()
            .map(|&(reference_index, candidate_index)| {
                reference[reference_index]
                    .time_us
                    .abs_diff(candidate[candidate_index].time_us)
            })
            .collect::<Vec<_>>();
        let rate = match_rate(&errors, reference.len(), candidate.len(), 70_000);
        assert_eq!(rate.tolerance_ms, 70.0);
        assert_eq!(rate.matches, 4);
        assert_eq!(rate.precision, 0.8);
        assert_eq!(rate.recall, 1.0);
        assert!((rate.f1 - 8.0 / 9.0).abs() < f64::EPSILON);
    }

    #[test]
    fn semantic_alignment_rejects_unbounded_trace_allocation() {
        let long = (0..5_000)
            .map(|index| precise_beat(index * 500_000, (index % 4 + 1) as u16))
            .collect::<Vec<_>>();
        let error = align_beats(&long, &long).expect_err("bounded alignment");
        assert!(error.to_string().contains("maximum is"));
    }

    #[test]
    fn semantic_waveforms_decode_bitfields_and_report_overlap_errors() {
        let monochrome = decode_waveform("PWAV", 1, &[0b1011_0010]).expect("PWAV");
        assert_eq!(
            monochrome.components,
            vec![("height", vec![18]), ("whiteness", vec![5])]
        );
        let tiny = decode_waveform("PWV2", 1, &[0xab]).expect("PWV2");
        assert_eq!(
            tiny.components,
            vec![("height", vec![11]), ("unusedHigh", vec![10])]
        );
        let color = decode_waveform("PWV5", 2, &[0b1011_0110, 0b1101_0110]).expect("PWV5");
        assert_eq!(
            color.components,
            vec![
                ("red", vec![5]),
                ("green", vec![5]),
                ("blue", vec![5]),
                ("height", vec![21]),
                ("unusedLow", vec![2]),
            ]
        );
        let three_band = decode_waveform("PWV7", 3, &[10, 20, 30, 40, 50, 60]).expect("PWV7");
        assert_eq!(
            three_band.components,
            vec![
                ("low", vec![10, 40]),
                ("mid", vec![20, 50]),
                ("high", vec![30, 60]),
            ]
        );

        let report =
            compare_waveform_component("height", &[1, 2, 3], &[1, 4]).expect("component diff");
        assert_eq!(report.reference_count, 3);
        assert_eq!(report.candidate_count, 2);
        assert_eq!(report.overlap_count, 2);
        assert_eq!(report.count_delta, -1);
        assert_eq!(report.exact_values, 1);
        assert_eq!(report.exact_fraction, 0.5);
        assert_eq!(report.correlation, Some(1.0));
        assert_eq!(report.mean_absolute_error, 1.0);
        assert_eq!(report.median_absolute_error, 2.0);
        assert_eq!(report.p95_absolute_error, 2.0);
        assert_eq!(report.max_absolute_error, 2.0);
        assert_eq!(report.signed_mean_error, 1.0);
    }
}
