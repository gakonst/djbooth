//! Clean-room primitives around Rekordbox 6.8.2's Spleeter model boundary.

use anyhow::{Result, bail};

/// FFT window used by the native separator.
pub const STEMS_FFT_SAMPLES: usize = 4_096;

/// STFT hop used by the native separator.
pub const STEMS_HOP_SAMPLES: usize = 1_024;

/// Number of model frames evaluated per inference window.
pub const STEMS_MODEL_FRAMES: usize = 512;

/// Number of new STFT frames advanced between inference windows.
pub const STEMS_FRAME_STRIDE: usize = 507;

/// Number of new PCM samples advanced between inference windows.
pub const STEMS_CHUNK_SAMPLES: usize = STEMS_FRAME_STRIDE * STEMS_HOP_SAMPLES;

/// Leading and trailing PCM context retained around each streamed output chunk.
pub const STEMS_CONTEXT_SAMPLES: usize = STEMS_FFT_SAMPLES;

/// PCM samples supplied for one streamed inference chunk, including context.
pub const STEMS_INPUT_WINDOW_SAMPLES: usize = STEMS_CHUNK_SAMPLES + 2 * STEMS_CONTEXT_SAMPLES;

/// One native Spleeter inference window.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StemsChunk {
    /// Zero-based inference-window index.
    pub index: usize,
    /// First output sample represented by this window.
    pub sample_offset: usize,
    /// First STFT frame sliced into the 512-frame model input.
    pub stft_frame_offset: usize,
    /// Number of source samples retained from this window.
    pub valid_samples: usize,
}

/// Three-source output exposed by Rekordbox 6.8.2.
#[derive(Debug, Clone, PartialEq)]
pub struct RecombinedStems {
    /// Bass plus other model sources.
    pub instrumental: Vec<f32>,
    /// Vocal model source without post-processing.
    pub vocals: Vec<f32>,
    /// Mixture residual after instrumental and vocals.
    pub drums: Vec<f32>,
}

/// Build the native 507-frame-stride inference schedule.
pub fn plan_stems_chunks(sample_count: usize) -> Vec<StemsChunk> {
    let chunk_count = sample_count.div_ceil(STEMS_CHUNK_SAMPLES);
    (0..chunk_count)
        .map(|index| {
            let sample_offset = index * STEMS_CHUNK_SAMPLES;
            StemsChunk {
                index,
                sample_offset,
                stft_frame_offset: index * STEMS_FRAME_STRIDE,
                valid_samples: (sample_count - sample_offset).min(STEMS_CHUNK_SAMPLES),
            }
        })
        .collect()
}

/// Recombine selected four-source Spleeter outputs into Rekordbox's three stems.
///
/// The native wrapper requests vocals, bass, and other from the model. It emits
/// `instrumental = bass + other`, preserves vocals, then derives drums as the
/// exact mixture residual. This intentionally ignores the model's drums tensor.
pub fn recombine_spleeter_sources(
    mixture: &[f32],
    vocals: &[f32],
    bass: &[f32],
    other: &[f32],
) -> Result<RecombinedStems> {
    let sample_count = mixture.len();
    if vocals.len() != sample_count || bass.len() != sample_count || other.len() != sample_count {
        bail!(
            "Spleeter source lengths differ: mixture={}, vocals={}, bass={}, other={}",
            sample_count,
            vocals.len(),
            bass.len(),
            other.len()
        );
    }

    let mut instrumental = Vec::with_capacity(sample_count);
    let mut drums = Vec::with_capacity(sample_count);
    for index in 0..sample_count {
        let combined = bass[index] + other[index];
        instrumental.push(combined);
        drums.push(mixture[index] - (combined + vocals[index]));
    }
    Ok(RecombinedStems {
        instrumental,
        vocals: vocals.to_vec(),
        drums,
    })
}
