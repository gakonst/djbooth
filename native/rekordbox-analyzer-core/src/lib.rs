//! Clean-room Rekordbox analysis-file primitives.
//!
//! This crate contains no Rekordbox executable bytes, JUCE ABI calls, or
//! proprietary runtime dependencies. The proprietary analyzer can be used as
//! a local differential oracle by the sibling `rekordbox-analyzer` crate.

pub mod anlz;
pub mod differential;

pub use anlz::{
    AnlzFile, AnlzTag, BeatGridEntry, CountedWaveform, DatAnalysis, ExtAnalysis, ExtendedBeatGrid,
    FILE_HEADER_LEN, ThreeBandAnalysis, WaveformColorConfig, build_beat_grid_tag,
    build_counted_waveform_tag, build_empty_cue_tag, build_extended_beat_grid_tag, build_path_tag,
    build_vbr_tag, build_vbr_tag_with_unknowns, build_waveform_color_config_tag,
    build_waveform_tag,
};
pub use differential::{
    DifferentialReport, FileDifferential, FirstDifference, TagDifferential,
    compare_output_directories,
};
