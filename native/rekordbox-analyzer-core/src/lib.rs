//! Clean-room Rekordbox analysis-file primitives.
//!
//! This crate contains no Rekordbox executable bytes, JUCE ABI calls, or
//! proprietary runtime dependencies. The proprietary analyzer can be used as
//! a local differential oracle by the sibling `rekordbox-analyzer` crate.

pub mod analysis;
pub mod anlz;
pub mod audio;
pub mod beat_decoder;
pub mod beat_sensor;
pub mod differential;
pub mod key;
pub mod rhythm;
pub mod waveform;

pub use analysis::{
    AnalysisFileSummary, AnalysisOptions, AnalyzerOutput, AnalyzerTimings, BeatGridSummary,
    BeatSummary, DEFAULT_ANALYZER_THREADS, GeneratedAnalysis, MAX_ANALYZER_THREADS, OutputSummary,
    analyze_audio_file, analyze_audio_file_with_options, analyze_to_directory,
    analyze_to_directory_with_options,
};
pub use anlz::{
    AnlzFile, AnlzTag, BeatGridEntry, CountedWaveform, DatAnalysis, ExtAnalysis, ExtendedBeatGrid,
    FILE_HEADER_LEN, ThreeBandAnalysis, WaveformColorConfig, build_beat_grid_tag,
    build_counted_waveform_tag, build_empty_cue_tag, build_extended_beat_grid_tag, build_path_tag,
    build_vbr_tag, build_vbr_tag_with_unknowns, build_waveform_color_config_tag,
    build_waveform_tag,
};
pub use audio::{
    ANALYSIS_SAMPLE_RATE, AudioSourceInfo, DETAIL_COLUMNS_PER_SECOND, DETAIL_FRAME_SAMPLES,
    DecodedAudio, FrameSpec, MonoPcm, PcmFrame, PcmFrames, decode_audio_file,
};
pub use beat_decoder::{
    BeatTempoSection, ProvisionalTempoSection, build_provisional_tempo_sections,
    suppress_nearby_hypotheses,
};
pub use beat_sensor::{
    BeatSensorAnalysis, BeatSensorCandidate, BeatSensorEvent, BeatSensorHypothesis,
    analyze_beat_sensor_events,
};
pub use differential::{
    BeatGridDifferential, BeatGridEndpoint, BeatMatchRate, DifferentialReport, FileDifferential,
    FirstDifference, TagDifferential, TempoErrorDistribution, TimestampErrorDistribution,
    WaveformComponentDifferential, WaveformDifferential, WaveformTagDifferential,
    compare_beat_grids, compare_output_directories, compare_waveforms,
};
pub use key::{KeyAnalysis, analyze_key};
pub use rhythm::{BeatAnalysis, analyze_beats};
pub use waveform::{
    COLOR_PREVIEW_COLUMNS, MONOCHROME_PREVIEW_COLUMNS, TINY_PREVIEW_COLUMNS, WaveformData,
};
