use std::path::Path;
use std::process::Command;

use rekordbox_analyzer_core::{
    ANALYSIS_SAMPLE_RATE, AnalysisOptions, AnlzFile, AnlzTag, COLOR_PREVIEW_COLUMNS,
    DETAIL_FRAME_SAMPLES, DatAnalysis, ExtAnalysis, WaveformData,
    analyze_to_directory_with_options, build_flac_pvb2, compare_beat_grids, compare_waveforms,
    decode_audio_file,
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
    assert_eq!(first, second, "the decode path must be deterministic");
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

    let first = analyze_to_directory_with_options(
        &fixture,
        &first_directory,
        None,
        AnalysisOptions::new(1).expect("scalar options"),
    )
    .expect("first full analysis");
    let second = analyze_to_directory_with_options(
        &fixture,
        &second_directory,
        None,
        AnalysisOptions::new(3).expect("parallel options"),
    )
    .expect("second full analysis");

    assert!(
        (first.summary.tempo_bpm - 120.0).abs() < 1.0,
        "detected {} BPM",
        first.summary.tempo_bpm
    );
    assert_eq!(first.summary.key, "D");
    assert!(first.summary.beat_grid.beat_count >= 20);
    assert_eq!(first.summary.song_structure.sample_rate, 44_100);
    assert_eq!(
        first.summary.song_structure.input_mix,
        "left-0.99-right-0.01"
    );
    assert!(first.summary.song_structure.phrase_count >= 4);
    assert!(
        first.summary.song_structure.first_phrases.len()
            <= first.summary.song_structure.phrase_count
    );
    assert_eq!(second.summary.key, first.summary.key);
    assert_eq!(
        second.summary.song_structure.first_phrases,
        first.summary.song_structure.first_phrases
    );
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

    let dat = DatAnalysis::parse(
        &AnlzFile::parse(
            &std::fs::read(first_directory.join("ANLZ0000.DAT")).expect("generated DAT"),
        )
        .expect("parse generated DAT"),
    )
    .expect("decode generated DAT");
    let ext = ExtAnalysis::parse(
        &AnlzFile::parse(
            &std::fs::read(first_directory.join("ANLZ0000.EXT")).expect("generated EXT"),
        )
        .expect("parse generated EXT"),
    )
    .expect("decode generated EXT");
    assert!(
        ext.song_structure.raw().len() > ext.song_structure.header_len(),
        "PSSI must contain generated phrase records"
    );
    assert_eq!(
        ext.extended_beat_grid.entries.len(),
        dat.beat_grid.len(),
        "PQT2 must carry one sub-millisecond remainder per PQTZ beat"
    );
    assert!(
        ext.extended_beat_grid
            .entries
            .iter()
            .map(|entry| u16::from_be_bytes(*entry))
            .all(|residual| residual <= 999)
    );
    assert!(
        ext.extended_beat_grid
            .entries
            .iter()
            .any(|entry| *entry != [0, 0]),
        "synthetic phase should retain non-zero microseconds"
    );
    let expected_checksum = dat.beat_grid.iter().fold(0_u32, |sum, entry| {
        sum.wrapping_add(
            u32::from(entry.beat)
                .wrapping_add(u32::from(entry.bpm_hundredths))
                .wrapping_add(entry.time_ms),
        )
    });
    assert_eq!(ext.extended_beat_grid.unknown_3, expected_checksum);

    let semantic =
        compare_beat_grids(&first_directory, &second_directory).expect("semantic beat-grid diff");
    assert_eq!(semantic.reference_beat_count, semantic.candidate_beat_count);
    assert_eq!(semantic.matched_beats, semantic.reference_beat_count);
    assert_eq!(semantic.aligned_timestamp_error.max_ms, 0.0);
    assert_eq!(semantic.at_70_ms.f1, 1.0);

    let waveform =
        compare_waveforms(&first_directory, &second_directory).expect("semantic waveform diff");
    assert_eq!(waveform.waveforms.len(), 7);
    assert!(waveform.waveforms.iter().all(|tag| tag.count_delta == 0));
    assert!(waveform.waveforms.iter().all(|tag| {
        tag.components
            .iter()
            .all(|component| component.mean_absolute_error == 0.0)
    }));

    let explicit_directory = fixture_dir.path().join("explicit-threads");
    let explicit = Command::new(env!("CARGO_BIN_EXE_rekordbox-analyzer"))
        .args(["analyze"])
        .arg(&fixture)
        .arg(&explicit_directory)
        .args(["--threads", "2"])
        .output()
        .expect("run analyzer CLI with explicit threads");
    assert!(
        explicit.status.success(),
        "{}",
        String::from_utf8_lossy(&explicit.stderr)
    );
    for name in ["ANLZ0000.DAT", "ANLZ0000.EXT", "ANLZ0000.2EX"] {
        assert_eq!(
            std::fs::read(first_directory.join(name)).expect("scalar artifact"),
            std::fs::read(explicit_directory.join(name)).expect("explicit-thread artifact"),
            "{name} must not depend on the worker count"
        );
    }

    let invalid_threads = Command::new(env!("CARGO_BIN_EXE_rekordbox-analyzer"))
        .args(["analyze"])
        .arg(&fixture)
        .arg(fixture_dir.path().join("invalid-threads"))
        .args(["--threads", "0"])
        .output()
        .expect("run analyzer CLI with invalid threads");
    assert!(!invalid_threads.status.success());
    assert!(
        String::from_utf8_lossy(&invalid_threads.stderr)
            .contains("analyzer threads must be between")
    );

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

#[test]
fn configured_read_only_flac_fixture_matches_reference_pvb2() {
    let (Ok(audio_path), Ok(reference_ext_path)) = (
        std::env::var("REKORDBOX_FLAC_PVB2_FIXTURE"),
        std::env::var("REKORDBOX_FLAC_PVB2_REFERENCE_EXT"),
    ) else {
        return;
    };
    let audio = std::fs::read(&audio_path).expect("read configured FLAC fixture");
    let generated = build_flac_pvb2(&audio).expect("build fixture PVB2");
    let reference_file =
        AnlzFile::read(Path::new(&reference_ext_path)).expect("read configured reference EXT");
    let reference = reference_file
        .tags()
        .iter()
        .find(|tag| tag.kind() == *b"PVB2")
        .expect("reference EXT PVB2");
    assert_eq!(generated.raw(), reference.raw());
    assert_eq!(
        build_flac_pvb2(&audio).expect("rebuild fixture PVB2").raw(),
        generated.raw(),
        "configured FLAC indexing must be deterministic"
    );
}

#[test]
fn exact_stream_batch_boundary_matches_single_thread_analysis() {
    let fixture_dir = tempdir().expect("fixture directory");
    let fixture = fixture_dir.path().join("stream-boundary-44100.wav");
    write_pcm16_wav(&fixture, 44_100, 2, &tonal_click_track(44_100, 5, 120.0));
    let scalar_directory = fixture_dir.path().join("scalar");
    let streamed_directory = fixture_dir.path().join("streamed");

    analyze_to_directory_with_options(
        &fixture,
        &scalar_directory,
        None,
        AnalysisOptions::new(1).expect("scalar options"),
    )
    .expect("single-thread analysis");
    analyze_to_directory_with_options(
        &fixture,
        &streamed_directory,
        None,
        AnalysisOptions::new(8).expect("streamed options"),
    )
    .expect("streamed analysis");

    for name in ["ANLZ0000.DAT", "ANLZ0000.EXT", "ANLZ0000.2EX"] {
        assert_eq!(
            std::fs::read(scalar_directory.join(name)).expect("scalar artifact"),
            std::fs::read(streamed_directory.join(name)).expect("streamed artifact"),
            "{name} must not depend on streaming boundaries"
        );
    }
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
