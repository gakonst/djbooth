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
generated 2EX round trips, and FLAC `PVB2` synthesis; the private
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
| EXT | `PPTH`, `PWV3`, `PQT2`, `PWV4`, `PWV5`, `PVB2` | `PCOB`, `PCO2`, obfuscated `PSSI` |
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
  stream parameters, and non-finite samples fail closed. Fragmented DASH AAC
  discards the positive edit-list media start plus Core Audio's 512-frame
  transform delay. The observed `1,600 + 512 = 2,112` priming exactly recovers
  Life Is Hard; ordinary `M4A ` edit lists remain untrimmed because their stock
  grids prove different backend semantics. See Apple's
  [packet-table priming definition](https://developer.apple.com/documentation/audiotoolbox/audiofilepackettableinfo).
- Samples are normalized to `f32` and mixed to mono. Waveform, key, and Normal
  rhythm analysis deterministically resample to 44,100 Hz with integer-phase
  linear interpolation and expose tail-aware 294-sample frames: exactly 150
  waveform columns per second. Dynamic rhythm consumes source-rate PCM because
  its recovered detector measures positions in source frames. For other rates,
  the linked reader accepts 8–200 kHz, selects 48 kHz for the 8 kHz family and
  44.1 kHz otherwise, then runs the recovered 29-tap Kaiser converter and i16
  boundary. Reader length is format-derived: WAV/other readers advertise the
  decoded length, while FLAC adds its validated STREAMINFO maximum block size;
  the converted reader exposes `ceil(advertised * target/source) - 1` frames.
- The waveform path emits fixed 400-byte `PWAV`, 100-byte `PWV2`,
  1,200-column `PWV4`/`PWV6`, and variable 150 Hz
  `PWV3`/`PWV5`/`PWV7` arrays. Peak-power height quantization and known
  monochrome/RGB packing match the public ANLZ layouts. `PWV4` uses separate
  linear-amplitude preview filters and its inverse luminance byte; `PWV5`
  stores frame-RMS-normalized spectral hue independently from its height.
  `PWV6` and `PWV7` use a clean-room port of the linked three-band path:
  source-rate Butterworth filters, 1 ms peak buckets, track-relative preview
  windows, per-track normalization, finite decay histories, and the native
  nonlinear high-band transfer. Each entry is 7-bit low/mid/high, despite
  older public notes describing a different order.
- Normal rhythm analysis uses low- and body-band STFT spectral flux, bounded
  autocorrelation/harmonic scoring, hierarchical sub-frame tempo/phase
  refinement, FFT-center correction, a continuous non-snapping grid, and
  low-band meter evidence. Dynamic is a clean-room port of the linked
  `peakss::BeatSensor` path: causal peak detection, hypothesis pruning,
  variable-tempo section refinement, pulse/phase selection, rolling
  four-beat expansion, gap repair, and `UnitEnvelopeMaker` bar finishing.
  Auto runs both inside the same bounded pool and selects Dynamic only when
  the central 90% of its local tempi span at least 0.75% of the median.
  PQTZ stores floor milliseconds; each paired PQT2 word stores its big-endian
  `0..=999` microsecond remainder. The PQT2 word at offset 44 is the wrapping
  sum of every PQTZ entry's beat, BPM-hundredths, and floor-millisecond time.
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

Native FLAC analysis also validates the complete CRC-8 header and CRC-16 frame
chain and emits the 400-entry, 8,032-byte `PVB2` seek table. A configured
read-only local gate compares the result against Rekordbox 6.8.2; three
independent FLAC tracks matched byte-for-byte. The CRC-16 implementation uses
an eight-byte slicing table pinned against the scalar FLAC polynomial, and
seek-table construction overlaps decode inside the same bounded worker pool.

## Deterministic parallel analysis

`analyze AUDIO OUTPUT_DIR [LOG] --threads N --rhythm-mode MODE` runs waveform,
rhythm, and key analysis in one bounded Rayon pool. Rhythm and key FFT frames
are partitioned into ordered contiguous ranges; global reductions remain in
their original order. Auto overlaps its independent Normal and Dynamic
candidates rather than serializing them. Non-44.1 kHz three-band extraction
and resampling also run independently. The recovered SRC output fill is
deterministically parallel above 262,144 frames. AArch64 packs the stateful
legacy and three-band filters into bit-exact NEON pairs; obsolete fitted
filter lanes are no longer evaluated. The raw helper defaults to the lower of
eight and host parallelism, accepts `1..=64`, and reads the same budget from
`REKORDBOX_ANALYZER_THREADS`.

Thread counts 1, 2, 3, 4, 8, and 12 produced the same summary semantics and
byte-identical DAT/EXT/2EX SHA-256 hashes for three real recordings plus one
502-second recording. Five repeated 12-thread runs also retained those hashes.
With every recovered path enabled, five Science Fiction Auto runs measured
`0.875/0.875/0.887/0.890/0.990 s` on an Apple M2 Max. The same artifacts took
about `1.00 s` before the final legacy/three-band NEON pass. Power Dynamic
measured `1.31 s` at eight threads versus `2.27 s` at one, with identical
DAT/EXT/2EX hashes.

The final 100-track, 8.55-hour Auto batch measured `15.88–15.92 s`
(`6.28–6.32 tracks/s`) with 12 processes sharing 24 Rayon slots. Twelve slots
measured `16.12–16.68 s`; 24 one-thread processes measured `16.20 s`;
4/6/8 processes sharing 12 slots measured `19.24/17.36/16.94 s`. The
TypeScript scheduler therefore caps process count to host parallelism and 12.
On Apple Silicon it defaults to two scheduling slots per core, while small
batches use at most eight threads per track. Explicit limits remain available
through 64 when analysis must yield capacity to live DJ software.

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
Subsequent static and live stage tracing recovered the overlapping filters,
stateful envelope, and normalization path. The clean implementation now uses
`LP300`, `HP250 → LP1200`, and `HP3000 → LP9000` source-rate biquads, exact
1 ms peak buckets, `300/200/100 ms` finite decay histories, and PWVC gains
derived from the 1,200-column track preview.

## 110-track Normal baseline checkpoint

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

The original pass intentionally retained PWV3, PWV5, and PWV7 detail. PWV3
already had median correlation `0.99868` and weighted MAE `0.586`; PWV5
channel median correlations were `0.852/0.847/0.837`. The later linked-path
reconstruction replaced the rejected global PWV7 gain guess. A fresh
110-track replay improved all 110 PWV6 and PWV7 comparisons with no
regressions; median PWV7 correlation is
`0.999991/0.999977/0.999809` and median MAE is
`0.0123/0.0169/0.0474`.

The later exact legacy-lane reconstruction materially closes PWV4/PWV5 without
changing PWV6/PWV7. Across the same 110 tracks, PWV4 median correlation is
`0.99930` for amplitude, `0.99999` for bottom, and `0.99999` for red; median
exact fractions are `87.75%`, `98.08%`, and `98.17%`. PWV5 median
red/green/blue correlations are `0.99722/0.98962/0.97689`, median MAE is
`0.0242/0.0455/0.1240`, and median exact fractions are
`98.21%/96.48%/93.03%`. PWV5 height correlation is `0.99977`.
PWV4 green/blue remain the older fitted lanes and are the largest color
preview gap. PWAV/PWV2 amplitude and PWV3 whiteness also remain materially
less exact.

## Linked Dynamic differential checkpoint

A fresh, read-only 110-track Dynamic replay completed with zero analyzer
failures. All 110 tracks reached F1 `>= 0.99`; mean F1 is `0.999918881`, mean
p95 timing error is `0.834 ms`, median p95 is zero, and p90/p95 of per-track
p95 are `1.542/5.646 ms`. All 110 grids have exact aligned bar phase, 108/110
have exact beat numbering, and 60/110 have zero median/p95/max timestamp
error. The prior static implementation reached 94/110, mean F1
`0.878300174`, and mean p95 `43.365 ms`.

The recovered low-frequency UnitEnvelope extractor, four-bucket scorer,
all-nonpositive first-peak fallback, numbering branches, one-beat boundary
repair, DASH AAC priming, and format-derived FLAC reader tail produce an exact
Life Is Hard grid and recover seven previously missing FLAC endpoint beats.
Only Conga (867/868 beats, `0.99481` F1) and Chopin (692/691,
`0.99783` F1) retain internal section-transition/numbering differences.
Their first divergence is upstream section-origin/survivor selection, not a
generic numbering or gap-repair defect.

A separate 849-track audit confirms that Normal and Dynamic are distinct
analysis modes, not interchangeable quality levels. All 14 references with
local tempo movement pass in Dynamic. Of 835 static Normal references, Normal
passes 759 while forced Dynamic passes 606. Differential tests and the local
reference helper therefore require the same explicit mode on both sides.

## Historical variable-tempo and syncopated-phase audit

The following records the superseded global/barwise experiments that motivated
the linked-path reconstruction. They are retained to document rejected
heuristics, not the current production Dynamic implementation.

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

- MPEG-2/2.5 Layer III, Layer I/II, and VBRI seek-table parity have no local
  Rekordbox oracle yet, so they intentionally use the conservative zero
  `PVBR` fallback.
- Song structure/phrase analysis is not implemented. Clean `PSSI` is valid
  empty scaffolding instead of a proprietary phrase map.
- Cue sections are emitted empty. Non-empty `PCOB`, `PCO2`, and obfuscated
  `PSSI` remain losslessly preservable by the format core.
- Non-44.1/48 kHz Dynamic input uses the recovered 29-tap Kaiser polyphase
  converter, including native rate-family selection, initial history,
  format-derived reader length, and i16 boundary quantization. At the recovered
  converter boundary, both Power stereo channels match all 15,598,860 native
  48 kHz frames bit-for-bit before and after i16 quantization. Production
  still mixes decoded channels before SRC; its clean grid matches all 608
  stock beats with F1 `1.0`, exact labels/downbeat, and `0.375 ms` p95 timing
  error.
- `PWVC` stores the reconstructed per-track three-band normalization
  coefficients. Science Fiction matches the linked `[80, 172, 147]` values
  exactly. Fresh Science Fiction `PWV7` low/mid/high correlations are
  `0.999989/0.999978/0.999944`; PWV4 green/blue remain less exact.
- Source-decoder/framer detail-count boundaries, syncopated Normal meter
  inference, PWAV/PWV2 and PWV3 whiteness, PWV4 green/blue operation order,
  the two Dynamic survivor near-ties, phrase structure, and unsupported MP3
  seek variants remain high-value differential work.

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
