use std::path::Path;
use std::process::Command;

use rekordbox_analyzer_core::{
    ANALYSIS_SAMPLE_RATE, AnlzFile, AnlzTag, COLOR_PREVIEW_COLUMNS, DETAIL_FRAME_SAMPLES,
    ExtAnalysis, WaveformData, analyze_to_directory, decode_audio_file,
};
use tempfile::tempdir;

#[test]
fn synthetic_wav_decodes_normalizes_frames_and_builds_waveform_tags() {
    let fixture_dir = tempdir().expect("fixture directory");
    let fixture = fixture_dir.path().join("stereo-22050.wav");
    let mono_frames = [0_i16, 8_192, 16_384, 8_192, 0, -8_192];
    write_pcm16_wav(&fixture, 22_050, 2, &mono_frames);

    let first = decode_audio_file(&fixture).expect("decode WAV");
    let second = decode_audio_file(&fixture).expect("decode WAV again");
    assert_eq!(
        first, second,
        "the scalar decode path must be deterministic"
    );
    assert_eq!(first.source().sample_rate(), 22_050);
    assert_eq!(first.source().channels(), 2);
    assert_eq!(first.source().decoded_frames(), mono_frames.len());
    assert_eq!(first.mono().len(), mono_frames.len());
    assert!((first.mono().samples()[2] - 0.5).abs() < 0.000_1);

    let normalized = first.into_analysis_pcm().expect("normalize sample rate");
    assert_eq!(normalized.sample_rate(), ANALYSIS_SAMPLE_RATE);
    assert_eq!(normalized.len(), mono_frames.len() * 2);
    let frames = normalized.detail_frames().collect::<Vec<_>>();
    assert_eq!(frames.len(), 1);
    assert_eq!(frames[0].frame_len(), DETAIL_FRAME_SAMPLES);
    assert_eq!(frames[0].valid_len(), mono_frames.len() * 2);

    let waveforms = WaveformData::generate(&normalized).expect("waveform analysis");
    assert_eq!(waveforms.monochrome_detail().len(), 1);
    assert_eq!(
        waveforms.three_band_preview().len(),
        COLOR_PREVIEW_COLUMNS * 3
    );
    assert_eq!(waveforms.pwav_tag().expect("PWAV tag").kind(), *b"PWAV");
    assert_eq!(
        waveforms.pwv5().to_tag().expect("PWV5 tag").kind(),
        *b"PWV5"
    );
    assert_eq!(
        waveforms.pwv7().to_tag().expect("PWV7 tag").kind(),
        *b"PWV7"
    );
}

#[test]
fn synthetic_tonal_click_track_produces_deterministic_full_analysis() {
    let fixture_dir = tempdir().expect("fixture directory");
    let fixture = fixture_dir.path().join("d-major-120.wav");
    write_pcm16_wav(&fixture, 22_050, 2, &tonal_click_track(22_050, 12, 120.0));
    let first_directory = fixture_dir.path().join("first");
    let second_directory = fixture_dir.path().join("second");

    let first =
        analyze_to_directory(&fixture, &first_directory, None).expect("first full analysis");
    let second =
        analyze_to_directory(&fixture, &second_directory, None).expect("second full analysis");

    assert!(
        (first.summary.tempo_bpm - 120.0).abs() < 1.0,
        "detected {} BPM",
        first.summary.tempo_bpm
    );
    assert_eq!(first.summary.key, "D");
    assert!(first.summary.beat_grid.beat_count >= 20);
    assert_eq!(second.summary.key, first.summary.key);
    assert_eq!(
        second.summary.beat_grid.beat_count,
        first.summary.beat_grid.beat_count
    );

    for name in ["ANLZ0000.DAT", "ANLZ0000.EXT", "ANLZ0000.2EX"] {
        let first_bytes = std::fs::read(first_directory.join(name)).expect("first artifact");
        let second_bytes = std::fs::read(second_directory.join(name)).expect("second artifact");
        assert_eq!(first_bytes, second_bytes, "{name} must be deterministic");
        let parsed = AnlzFile::parse(&first_bytes).expect("parse generated ANLZ");
        assert!(!parsed.tags().is_empty());
        if name.ends_with(".EXT") {
            let extended = ExtAnalysis::parse(&parsed).expect("parse generated EXT");
            assert_eq!(
                extended.extended_beat_grid.anchors[0].time_ms,
                first.summary.beat_grid.first_beats[0].time_ms
            );
            assert_eq!(
                extended.extended_beat_grid.anchors[1].time_ms,
                first.summary.beat_grid.last_beat_ms
            );

            let mut pvb2 = vec![0_u8; 12];
            pvb2[..4].copy_from_slice(b"PVB2");
            pvb2[4..8].copy_from_slice(&12_u32.to_be_bytes());
            pvb2[8..12].copy_from_slice(&12_u32.to_be_bytes());
            let mut with_vbr = extended;
            with_vbr.vbr_2 = Some(AnlzTag::parse(&pvb2).expect("synthetic PVB2"));
            let encoded = with_vbr
                .to_file()
                .expect("build EXT with PVB2")
                .to_bytes()
                .expect("encode EXT with PVB2");
            let decoded = ExtAnalysis::parse(
                &AnlzFile::parse(&encoded).expect("parse encoded EXT with PVB2"),
            )
            .expect("decode EXT with PVB2");
            assert_eq!(decoded.vbr_2.as_ref().expect("retained PVB2").raw(), pvb2);
            assert_eq!(
                decoded
                    .to_file()
                    .expect("rebuild EXT with PVB2")
                    .to_bytes()
                    .expect("encode rebuilt EXT with PVB2"),
                encoded
            );
        }
    }

    let dat = first_directory.join("ANLZ0000.DAT");
    let dat_before = std::fs::read(&dat).expect("DAT before in-place rejection");
    let in_place = Command::new(env!("CARGO_BIN_EXE_rekordbox-analyzer"))
        .args(["rebuild-anlz"])
        .arg(&dat)
        .arg(&dat)
        .output()
        .expect("run rebuild CLI");
    assert!(!in_place.status.success());
    assert!(String::from_utf8_lossy(&in_place.stderr).contains("must be distinct"));
    assert_eq!(
        std::fs::read(&dat).expect("DAT after in-place rejection"),
        dat_before
    );

    let directory_output = fixture_dir.path().join("rebuild-output-directory");
    std::fs::create_dir(&directory_output).expect("rebuild output directory");
    let directory_target = Command::new(env!("CARGO_BIN_EXE_rekordbox-analyzer"))
        .args(["rebuild-anlz"])
        .arg(&dat)
        .arg(&directory_output)
        .output()
        .expect("run rebuild CLI with directory output");
    assert!(!directory_target.status.success());
    assert!(
        String::from_utf8_lossy(&directory_target.stderr)
            .contains("exists but is not a regular file")
    );
    assert!(directory_output.is_dir());
}

fn tonal_click_track(sample_rate: u32, seconds: usize, bpm: f64) -> Vec<i16> {
    let sample_rate = sample_rate as usize;
    let beat_samples = sample_rate as f64 * 60.0 / bpm;
    (0..sample_rate * seconds)
        .map(|index| {
            let time = index as f64 / sample_rate as f64;
            let chord = 0.12 * (std::f64::consts::TAU * 146.832 * time).sin()
                + 0.10 * (std::f64::consts::TAU * 184.997 * time).sin()
                + 0.08 * (std::f64::consts::TAU * 220.0 * time).sin();
            let beat_start =
                ((index as f64 / beat_samples).floor() * beat_samples).round() as usize;
            let beat_offset = index.saturating_sub(beat_start) as f64;
            let click = if beat_offset < 256.0 {
                0.9 * (-beat_offset / 36.0).exp()
                    * (std::f64::consts::TAU * 1_200.0 * beat_offset / sample_rate as f64).sin()
            } else {
                0.0
            };
            ((chord + click).clamp(-1.0, 1.0) * f64::from(i16::MAX)).round() as i16
        })
        .collect()
}

fn write_pcm16_wav(path: &Path, sample_rate: u32, channels: u16, mono_frames: &[i16]) {
    let mut samples = Vec::with_capacity(mono_frames.len() * channels as usize);
    for sample in mono_frames {
        samples.extend(std::iter::repeat_n(*sample, channels as usize));
    }
    let data_len = u32::try_from(samples.len() * 2).expect("small synthetic WAV");
    let byte_rate = sample_rate * u32::from(channels) * 2;
    let block_align = channels * 2;
    let mut wav = Vec::with_capacity(44 + data_len as usize);
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(36 + data_len).to_le_bytes());
    wav.extend_from_slice(b"WAVE");
    wav.extend_from_slice(b"fmt ");
    wav.extend_from_slice(&16_u32.to_le_bytes());
    wav.extend_from_slice(&1_u16.to_le_bytes());
    wav.extend_from_slice(&channels.to_le_bytes());
    wav.extend_from_slice(&sample_rate.to_le_bytes());
    wav.extend_from_slice(&byte_rate.to_le_bytes());
    wav.extend_from_slice(&block_align.to_le_bytes());
    wav.extend_from_slice(&16_u16.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&data_len.to_le_bytes());
    for sample in samples {
        wav.extend_from_slice(&sample.to_le_bytes());
    }
    std::fs::write(path, wav).expect("write synthetic WAV");
}
