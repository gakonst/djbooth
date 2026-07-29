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
pub mod flac;
pub mod key;
pub mod linked_rhythm;
pub mod phrase;
pub mod phrase_frontend;
pub mod rhythm;
pub mod sample_rate_converter;
pub mod unit_envelope;
pub mod waveform;

pub use analysis::{
    AnalysisFileSummary, AnalysisOptions, AnalyzerOutput, AnalyzerTimings, BeatGridSummary,
    BeatSummary, DEFAULT_ANALYZER_THREADS, GeneratedAnalysis, MAX_ANALYZER_THREADS, OutputSummary,
    PhraseSummary, RhythmMode, SongStructureSummary, analyze_audio_file,
    analyze_audio_file_with_options, analyze_to_directory, analyze_to_directory_with_options,
};
pub use anlz::{
    AnlzFile, AnlzTag, BeatGridEntry, CountedWaveform, DatAnalysis, ExtAnalysis, ExtendedBeatGrid,
    FILE_HEADER_LEN, PVB2_ENTRY_COUNT, Pvb2Entry, Pvb2Table, ThreeBandAnalysis,
    WaveformColorConfig, build_beat_grid_tag, build_counted_waveform_tag, build_empty_cue_tag,
    build_extended_beat_grid_tag, build_path_tag, build_vbr_tag, build_vbr_tag_with_unknowns,
    build_waveform_color_config_tag, build_waveform_tag,
};
pub use audio::{
    ANALYSIS_SAMPLE_RATE, AudioSourceInfo, DETAIL_COLUMNS_PER_SECOND, DETAIL_FRAME_SAMPLES,
    DecodedAudio, FrameSpec, MonoPcm, PcmFrame, PcmFrames, decode_audio_file,
};
pub use beat_decoder::{
    AdjustedTempoSection, BeatTempoSection, ExpandedBeat, ProvisionalTempoSection,
    RefinedTempoSection, adjust_tempo_section_phases, build_provisional_tempo_sections,
    correct_expanded_beat_gaps, expand_tempo_sections, finalize_expanded_beats,
    prune_discontinuous_hypotheses, prune_short_hypothesis_runs, refine_tempo_sections,
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
pub use flac::{FlacFrame, FlacFrameIndex, build_flac_pvb2, parse_flac_frame_index};
pub use key::{KeyAnalysis, analyze_key};
pub use linked_rhythm::{
    LinkedRhythmAnalysis, analyze_linked_beats, analyze_linked_beats_with_reader_padding,
    analyze_linked_rhythm, analyze_linked_rhythm_with_reader_padding, decode_linked_rhythm,
};
pub use phrase::{
    PhraseEntry, PhraseFeatureDiagnostics, SongStructure, SongStructureDiagnostics,
    analyze_song_structure,
};
pub use phrase_frontend::{
    NativePhraseFeatureTrace, PhraseBeatBoundaries, PhraseMultiratePcm,
    extract_native_phrase_features, generate_phrase_multirate,
};
pub use rhythm::{BeatAnalysis, analyze_beats};
pub use sample_rate_converter::{
    AnalysisSampleRateConverter, analysis_sample_rate, quantize_analysis_pcm,
};
pub use unit_envelope::{
    UnitEnvelopeAdjustment, UnitEnvelopeAdjustmentReport, UnitEnvelopeFeature,
    UnitEnvelopeNumbering, UnitEnvelopePhase, UnitEnvelopeScoring, apply_unit_envelope_adjustment,
    extract_unit_envelope_feature, score_unit_envelope, score_unit_envelope_feature,
    select_unit_envelope_phase, unit_envelope_numbering,
};
pub use waveform::{
    COLOR_PREVIEW_COLUMNS, MONOCHROME_PREVIEW_COLUMNS, TINY_PREVIEW_COLUMNS, WaveformData,
};
