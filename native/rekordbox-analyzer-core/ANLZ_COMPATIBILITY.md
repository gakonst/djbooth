# Clean-room Rekordbox analyzer status

This crate is the releasable half of the analyzer replacement. It contains no
AlphaTheta/Rekordbox executable, JUCE binary, patched application bundle,
offset table, or dynamic-loader call. The sibling `rekordbox-analyzer` rehost
remains a local reference oracle only.

## Reproducible oracle

Rekordbox 6.8.2.0018 analysis is deterministic for the tested input and
settings. Re-analyzing the same `Brunello - Science Fiction.mp3` source produced
files identical to the previously retained outputs:

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `ANLZ0000.DAT` | 9,054 | `2f6413aae44e699316c912ac802e8a598e385f39ca9654e600ec14859287c5e1` |
| `ANLZ0000.EXT` | 188,324 | `23a2089a0e810055f2aadbf1abad163f98d8963cb626b6a825f2a345cc97f0ad` |
| `ANLZ0000.2EX` | 182,358 | `b9944c77876cc79f33c87000f8526143ed32dedae934d0574fb3d13f140daf77` |

The oracle reported `126.998379` BPM and key `D`. This gives us a strict
golden, not a tolerance-based approximation.

Local differential flow:

```sh
# Local/private reference generation. Never package its runtime.
REKORDBOX_ANALYZER_ROOT=/path/to/music-ts/packages/rekordbox-ts \
  arch -x86_64 packages/rekordbox-ts/vendor/rekordbox-analyzer \
  analyze INPUT_AUDIO REFERENCE_DIR REFERENCE_DIR/native.log

# Candidate generation by clean-room Rust code, followed by an exact gate.
native/rekordbox-analyzer-core/target/debug/rekordbox-analyzer \
  diff REFERENCE_DIR CANDIDATE_DIR

# Timing/tempo/downbeat comparison with sub-millisecond PQT2 precision.
native/rekordbox-analyzer-core/target/debug/rekordbox-analyzer \
  beat-grid-diff REFERENCE_DIR CANDIDATE_DIR

# Decoded waveform-component comparison across DAT, EXT, and 2EX.
native/rekordbox-analyzer-core/target/debug/rekordbox-analyzer \
  waveform-diff REFERENCE_DIR CANDIDATE_DIR
```

`diff` compares all three files, SHA-256 hashes, lengths, ordered tags, and the
first differing byte. `beat-grid-diff` monotonically aligns PQTZ/PQT2 grids and
reports endpoint, drift, tempo, downbeat, and 70/100 ms match metrics. Its trace
allocation is bounded to 25 million cells. `waveform-diff` decodes the semantic
components of PWAV/PWV2/PWV3/PWV4/PWV5/PWV6/PWV7 and reports count deltas,
exact fractions, correlation, mean, MAE, error percentiles, and signed bias.
`diff` exits nonzero on any exact mismatch.

`rebuild-anlz INPUT OUTPUT` performs a non-destructive semantic clean-room
rebuild for the supported Rekordbox 6.8.2 DAT/EXT/2EX shapes. The retained
Science Fiction DAT, EXT, and 2EX oracle files were checked locally and rebuilt
byte-for-byte. Repository tests gate the distributable DAT/EXT seed shapes,
generated 2EX round trips, and optional FLAC `PVB2` preservation; the private
three-file oracle check remains a separate local differential gate. This proves
the serializer and field mapping, not the DSP.

## Implemented exact binary surface

The PMAI envelope and every tagged section are parsed losslessly. Unknown tags,
repeated tags, header bytes, and payload bytes survive a general parse/build
round trip.

The semantic writer currently covers:

| File | Semantically rebuilt | Opaque but preserved |
| --- | --- | --- |
| DAT | `PPTH`, `PVBR`, `PQTZ`, `PWAV`, `PWV2`, empty cue scaffolding | non-empty `PCOB` entries |
| EXT | `PPTH`, `PWV3`, `PQT2`, `PWV4`, `PWV5` | `PCOB`, `PCO2`, optional `PVB2`, obfuscated `PSSI` |
| 2EX | `PPTH`, `PWV6`, `PWV7`, `PWVC` | none |

The following fields remain named as unknown and are round-tripped explicitly:

- the four PMAI words after `len_file`;
- the PVBR word before its 400 seek entries and its trailing word;
- PQT2 words at offsets 12, 16, 20, 48, and 52;
- PWV3/PWV4/PWV5/PWV7 format words;
- the PWVC word at offset 12;
- all uninterpreted waveform entry bits and cue/song-structure bytes.

Primary public format references:

- [Deep Symmetry analysis-file format](https://djl-analysis.deepsymmetry.org/rekordbox-export-analysis/anlz.html)
- [pyrekordbox ANLZ structures](https://github.com/dylanljones/pyrekordbox/blob/master/pyrekordbox/anlz/structs.py)

## JUCE versus proprietary analysis

The Rekordbox executable uses JUCE extensively for strings, threads, containers,
and audio decoding. The analysis algorithm is not simply a JUCE facility.
Unstripped 6.8.2 symbols show a separate proprietary stack:

- `BA_CreateConst44k`, `BA_SetSample`, `BA_GetBpm`, `BA_GetBeatList`;
- `BA_GetLoudWave`, `BA_GetDotsWave`, `BA_GetZoomWave`, `BA_GetKey`;
- `peakss::BeatSensor`, `peakss::BeatInfoAnalyzer::analyze`;
- `CBeatAnalyzeThread::analyze`;
- `CMusicAnalyzeFile::write_pmai`, `write_pmai_ext`, and `write_pmai_ex2`.

Therefore a JUCE-compatible decoder only reproduces input samples. Byte-exact
analysis still requires clean-room parity for the `peakss` beat detector,
waveform quantizers, key detector, phrase detector, unsupported MP3 seek
variants, and post-processing such as first-bar/half-double-tempo adjustment.

## Clean audio and DSP vertical slice

The crate now analyzes local audio without Rekordbox, JUCE, FFmpeg, or a
platform codec dependency:

- Symphonia 0.6 decodes WAV/AIFF/CAF, MP3, AAC/MP4, ALAC, FLAC, Vorbis/OGG,
  ADPCM, and PCM using redistributable Rust crates. Decode failures, changing
  stream parameters, and non-finite samples fail closed.
- Samples are normalized to `f32`, mixed to mono, deterministically resampled
  to 44,100 Hz with integer-phase linear interpolation, and exposed as
  tail-aware 294-sample frames: exactly 150 waveform columns per second.
- The waveform path emits fixed 400-byte `PWAV`, 100-byte `PWV2`,
  1,200-column `PWV4`/`PWV6`, and variable 150 Hz
  `PWV3`/`PWV5`/`PWV7` arrays. Peak-power height quantization and known
  monochrome/RGB packing match the public ANLZ layouts. `PWV4` uses separate
  linear-amplitude preview filters and its inverse luminance byte; `PWV5`
  stores frame-RMS-normalized spectral hue independently from its height.
  `PWV6` mean-reduces encoded `PWV7` detail into its exact 1,200-column preview
  window, then applies corpus-gated low/mid preview calibration.
  Local corpus and pure-tone probes establish that each three-band entry is
  7-bit low/mid/high, despite older public notes describing a different order.
- Rhythm analysis uses low- and body-band STFT spectral flux, bounded
  autocorrelation/harmonic scoring, hierarchical sub-frame tempo/phase
  refinement, FFT-center correction, a continuous non-snapping grid, and
  low-band meter evidence. PQTZ stores floor milliseconds; each paired PQT2
  word stores its big-endian `0..=999` microsecond remainder. The PQT2 word at
  offset 44 is the wrapping sum of every PQTZ entry's beat, BPM-hundredths, and
  floor-millisecond time.
- Key analysis combines peak chroma with a tuning-aware whitened 36-bin
  HPCP/CENS path, Krumhansl and Faraldo BGate profiles, and bounded
  intro/outro tonic evidence.
- Validated MPEG-1 Layer III `Xing` input gets the Rekordbox 6.8.2 400-entry
  `PVBR` table: offsets are relative to the first data frame and retain an
  eight-frame decoder preroll. `Info`/CBR, unmarked MP3, constant-rate
  containers, and unproven MPEG/VBR variants retain the native all-zero shape.
- `analyze AUDIO OUTPUT_DIR [LOG]` writes DAT/EXT/2EX, validates them through
  the clean parser, and emits the bounded summary consumed and persisted as
  `analysis.json` by the TypeScript wrapper.

The integration suite verifies scalar WAV decode, 22.05-to-44.1 kHz
normalization, framing, and waveform entry counts. A separate 12-second,
120-BPM D-major synthetic track runs twice through decode, beat/key analysis,
DAT/EXT/2EX persistence, PQT2 first/last anchors, timestamp remainders and
checksum, optional `PVB2` preservation, byte-identical artifact comparison,
semantic beat-grid comparison, and clean ANLZ parsing. Synthetic straight-grid
tests also reject independent beat snapping by requiring all precise intervals
to differ by at most one microsecond. No user library or proprietary fixture is
mutated or packaged.

## Deterministic parallel analysis

`analyze AUDIO OUTPUT_DIR [LOG] --threads N` runs waveform, rhythm, and key
analysis in one bounded Rayon pool. Rhythm and key FFT frames are partitioned
into ordered contiguous ranges; global reductions remain in their original
order. The default is the host's available parallelism, bounded to `1..=64`.
`REKORDBOX_ANALYZER_THREADS` supplies the same budget when the TypeScript
wrapper launches the helper.

Thread counts 1, 2, 3, 4, 8, and 12 produced the same summary semantics and
byte-identical DAT/EXT/2EX SHA-256 hashes for three real recordings plus one
502-second recording. Five repeated 12-thread runs also retained those hashes.
Release-mode wall-clock medians on an Apple M2 Max with 12 available CPUs were:

| Recording | Duration | Scalar baseline | Automatic (12) | Speedup |
| --- | ---: | ---: | ---: | ---: |
| Science Fiction | 397 s | 1.11 s | 0.54 s | 2.06x |
| Crystalised | 201 s | 0.80 s | 0.46 s | 1.74x |
| Pleasure from the Bass | 233 s | 0.62 s | 0.26 s | 2.38x |
| Back Together (Main Classic Mix) | 502 s | 1.29 s | 0.55 s | 2.35x |

For all four files together, one process at a time with the same total
12-thread budget took 1.86 seconds. Four analyzer processes receiving three
threads each took 0.81 seconds, a 2.30x batch speedup, with peak RSS remaining
about 188–190 MiB. The TypeScript multi-track and Tracks workflow commands
treat `--threads` as one total CPU budget, divide it deterministically across
active processes or stream slots, and cap process concurrency to that budget.
This prevents process-level concurrency from multiplying the native worker
count.

## Three-track differential

Release builds were run against three existing recordings and compared
read-only with their Rekordbox 6.8.2 oracle artifacts:

| Track | Reference BPM | Clean BPM | Error | Reference/clean key | Beat count |
| --- | ---: | ---: | ---: | --- | ---: |
| Science Fiction | 126.998379 | 127.003948 | 0.0044% | D / D | 839 / 839 |
| Crystalised | 123.424746 | 123.416192 | 0.0069% | Bm / Bm | 413 / 413 |
| Pleasure from the Bass | 126.983124 | 126.985722 | 0.0020% | Gm / Gm | 493 / 493 |

The semantic beat-grid gate aligns all beats in those three tracks with no
insertions or deletions. Beat-number accuracy and F1 at both 70 and 100 ms are
`1.0` for all three. Median/p95 absolute timestamp errors are respectively
`3.088/8.905`, `6.196/27.056`, and `4.032/7.341` ms.

Wall time was 0.52–0.98 seconds per track on the test machine. The detailed
monochrome waveform (`PWV3`) correlations were 0.998, 0.985, and 0.999; color
detail height (`PWV5`) correlations were 0.993, 0.913, and 0.986. Peak-power
quantization also brought clean/reference `PWV3` means within 0.14, 0.34, and
0.26 of one another.

The RGB path was subsequently re-derived from 31 steady-frequency tones,
0 to -60 dB amplitude ladders/ramps, and matched-PCM copies of the same three
recordings. `PWV4` is an absolute representation: its first byte is linear
peak, its second nonzero byte is approximately `256 - peak`, and its remaining
fields are separately filtered linear band peaks. At -6 dB, clean PWV4
medians for 80 Hz, 500 Hz, and 4 kHz are respectively
`64/192/63/63/1/0`, `64/192/34/1/53/0`, and
`64/192/1/0/3/33`; the reference values are
`64/192/63/62/0/0`, `64/192/34/0/53/0`, and
`64/192/0/0/0/33`.

`PWV5` color is amplitude-invariant spectral hue, not absolute band loudness.
Continuous Butterworth filters feed 294-sample band RMS values which are
divided by broadband frame RMS before three-bit quantization; height remains a
separate peak-power field. The same three tones now produce the exact reference
hues `7/0/0`, `0/7/1`, and `0/2/7`, including when the tone is attenuated to
-60 dB. On visible frames in Science Fiction, the clean mean RGB moved from
the former direct-map `3.59/2.04/0.90` to `6.27/1.36/1.67`, versus the
reference `6.59/0.98/1.84`. Across Science Fiction, Crystalised, and Pleasure
from the Bass, visible per-channel MAE is `0.49..1.16` red, `0.66..0.85`
green, and `0.78..1.29` blue. PWV5 height correlations remain
`0.993/0.913/0.986`.

This is not a byte-parity claim. Three additional mostly steady heldouts expose
the boundary of the current estimator: Ana Tijoux has exact count/downbeat
phase and `12.358/35.690` ms median/p95 error; Michael Jackson has accurate
timing (`4.842/10.589` ms) but one missing endpoint beat and a one-beat meter
rotation; Lenny Kravitz has the exact `87.32` BPM/count but selects a syncopated
phase about 173 ms from the native grid and rotates the bar by two beats. Two
decoder/framer boundaries also differ by 8 and 14 detail entries; the Science
Fiction MP3 matches its 59,528-entry oracle count exactly.

The `PWV7` byte order and range were re-derived from 114 local 6.8.2 2EX
oracles containing 5,279,881 detail entries. Every observed band byte was in
`0..=127`. Deterministic 12-second, 44.1 kHz pure-tone oracle probes produced
steady low/mid/high medians of `50/4/0` at 40 Hz, `4/41/19` at 2 kHz, and
`1/16/40` at 4 kHz; silence produced `0/0/0`. Correcting the clean packing from
mid/high/low at 8-bit scale to low/mid/high at 7-bit scale changed aligned
three-track band correlations from `0.158..0.782` to `0.533..0.937` and reduced
mean per-band absolute error from `31.58..48.12` bytes to `9.50..12.78` bytes.
The native bands overlap and have a stateful envelope, so cutoff and
normalization parity remain open rather than being guessed from these probes.

## 110-track differential checkpoint

A read-only corpus pass matched 113 local recordings to 115 Rekordbox 6.8.2
reference directories; 110 decoded successfully. Three malformed/short media
files were rejected without partial output. Strengthening the center-tempo
prior removed all 26 observed 2:3 subharmonic selections and broke none of the
78 previously correct tempo choices. Adding 35% body-band evidence to phase
selection fixed two half-beat phase errors. Mean F1 at 70 ms improved from
`0.664846` to `0.752310`, and tracks at `>=0.99` moved from 59 to 79 of 110.

For `PWV6`, preview generation now mean-reduces the encoded detail envelope
instead of max-pooling raw features. Weighted byte MAE moved from
`52.011/36.540/15.041` to `4.834/5.142/5.647` for low/mid/high. Every one of
the 110 tracks improved; median per-track correlations are
`0.8973/0.8128/0.9023`. Science Fiction's average PWV6 MAE moved from `36.664`
to `6.777`. An independent 77-fixture tone/level/transient corpus improved on
73 fixtures; high-band mean reduction remained uncalibrated to preserve the
four non-regression gates.

The pass intentionally retained PWV3, PWV5, and PWV7 detail. PWV3 already has
median correlation `0.99868` and weighted MAE `0.586`; PWV5 channel median
correlations are `0.852/0.847/0.837`. A global PWV7 gain curve improved
aggregate error but regressed ten real tracks, so the unresolved
filter/envelope detector was not guessed. A narrower rhythm low band likewise
fixed three tracks but regressed ten and was rejected.

## Variable-tempo and syncopated-phase audit

A second clean-room pass tested local-period estimation, beat snapping,
barwise reconstruction, and pulse-based phase selection against nine real
PQTZ/PQT2 grids. The oracle tempo fields are piecewise constant and strongly
bar-quantized: every run in the corpus spans at least four beats and the
median run is four beats. The three variable-tempo targets have the following
run shapes:

| Track | Tempo range | Runs | Minimum/median/maximum beats | Runs divisible by four |
| --- | ---: | ---: | ---: | ---: |
| James Brown — Ants | 107.25–108.59 | 176 | 4 / 4 / 28 | 175 / 176 |
| James Brown — Get Up | 146.88–151.06 | 73 | 4 / 4 / 35 | 71 / 73 |
| Chopin | 81.90–154.24 | 22 | 4 / 4 / 280 | 19 / 22 |

The unchanged global-grid baseline is:

| Track | Reference/clean beats | Median/p95 error | F1 at 70/100 ms |
| --- | ---: | ---: | ---: |
| Ants | 806 / 803 | 53.496 / 251.856 ms | 0.579 / 0.641 |
| Get Up | 354 / 355 | 37.344 / 184.841 ms | 0.683 / 0.725 |
| Chopin | 692 / 786 | 98.803 / 188.479 ms | 0.315 / 0.451 |

A 64-beat windowed autocorrelation estimated Ants' local tempo well
(`0.189` BPM median error), but using those estimates to integrate a grid
reduced its 70/100 ms F1. Get Up's local estimate had `0.702` BPM median
error, yet its integrated grid also regressed. Chopin retained octave and
subdivision ambiguity (`21.245/73.385` BPM median/p95 error), so the same path
was not confidence-safe.

The strongest barwise reconstructions still failed the release gate. Ants
improved to `34.986` ms median and `0.592/0.650` F1, but p95 worsened to
`267.531` ms. Get Up improved to `27.671` ms median and `0.686/0.743` F1,
but p95 worsened to `242.8` ms. Independent beat snapping could reach
`0.755/0.784` F1 on Get Up, but emitted 353 beats and raised p95 to
`215.5` ms; it did not improve Ants. Better local BPM fields are therefore
not accepted without better integrated timestamps and stable tails.

Lenny Kravitz remains a genuine syncopated-phase ambiguity. The clean period
is `59.183` onset frames (`87.3217` BPM); its selected `35.4`-frame phase has
a mixed-band alignment score of `0.685`, while the native `50.861`-frame
phase scores `0.312`. An overlap-added predominant-local-pulse probe over
one-, three-, and five-second windows selected `34.15` frames, corroborating
the clean onset phase rather than the native grid. A corpus-specific
173-millisecond shift would not be an evidence-based analyzer rule.

The evaluated clean-room designs follow the transition-constrained beat
tracking and local-tempo ideas in
[Ellis (2007)](https://www.ee.columbia.edu/~dpwe/pubs/Ellis07-beattrack.pdf),
[Wu et al. (2011)](https://ismir2011.ismir.net/papers/PS2-4.pdf), and
[Chiu et al. (2023)](https://arxiv.org/abs/2308.10355). None passed the
required joint gate: meaningful timing/F1 improvement on both James Brown
tracks, no regression on Science Fiction, Crystalised, Pleasure from the Bass,
Ana Tijoux, Michael Jackson, or Lenny Kravitz, and barwise segments of at
least four beats. No analyzer code, ignored corpus test, or local oracle
artifact was retained, so distributable output remains unchanged.

## Known semantic gaps

- Rekordbox EXT files for two tested FLACs contain an undocumented `PVB2`
  section. Semantic rebuilds preserve it opaquely; the clean baseline does not
  synthesize one because no public field definition was found.
- MPEG-2/2.5 Layer III, Layer I/II, and VBRI seek-table parity have no local
  Rekordbox oracle yet, so they intentionally use the conservative zero
  `PVBR` fallback.
- Song structure/phrase analysis is not implemented. Clean `PSSI` is valid
  empty scaffolding instead of a proprietary phrase map.
- Cue sections are emitted empty. Non-empty `PCOB`, `PCO2`, and obfuscated
  `PSSI` remain losslessly preservable by the format core.
- `PWVC` uses the observed fixed configuration; its remaining semantics are
  not claimed as DSP parity.
- Variable-tempo tracking remains intentionally unimplemented. A global static
  grid reaches 70/100 ms F1 of `0.579/0.641` on James Brown's “Ants,”
  `0.683/0.725` on the live “Get Up,” and `0.315/0.451` on the strongly
  variable Chopin heldout. The native grids contain 175, 72, and 21 local tempo
  changes while the clean grid contains none. A barwise/local-tempo path needs
  its own confidence gate and steady-track non-regression corpus before release.
- Syncopated phase/meter post-adjustment and three-band
  filter/envelope/normalization remain high-value differential work.

Clean output is a protocol-compatible baseline suitable for import and
connected-player testing, not a representation of proprietary Rekordbox DSP.
The release gate remains strict: only the clean-room crate/binary may be
packaged. The reference helper, Rekordbox application bytes, generated cache,
captures, and local goldens stay outside release artifacts.

The npm package's explicit `files` allowlist excludes `vendor/`, and the helper
build script compiles only `native/rekordbox-analyzer-core`. A release therefore
does not require or copy the local reference rehost.

Universal helper builds place `LICENSE` and `THIRD_PARTY_LICENSES.md` beside
the executable. Symphonia 0.6.0 is MPL-2.0; the latter notice identifies the
exact corresponding source and both files must remain with any distributed
helper binary.
