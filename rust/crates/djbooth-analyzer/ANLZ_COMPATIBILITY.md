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
REKORDBOX_ANALYZER_ROOT=/path/to/music-ts \
  arch -x86_64 archive/rekordbox/rehost/rekordbox-analyzer \
  analyze INPUT_AUDIO REFERENCE_DIR REFERENCE_DIR/native.log

# Candidate generation by clean-room Rust code, followed by an exact gate.
rust/target/debug/rekordbox-analyzer \
  diff REFERENCE_DIR CANDIDATE_DIR

# Timing/tempo/downbeat comparison with sub-millisecond PQT2 precision.
rust/target/debug/rekordbox-analyzer \
  beat-grid-diff REFERENCE_DIR CANDIDATE_DIR

# Decoded waveform-component comparison across DAT, EXT, and 2EX.
rust/target/debug/rekordbox-analyzer \
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
| EXT | `PPTH`, `PWV3`, `PQT2`, `PWV4`, `PWV5`, `PVB2`, generated `PSSI` | `PCOB`, `PCO2`, retained opaque/obfuscated `PSSI` |
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
- Key and Normal rhythm retain the deterministic equal-weight mono signal and
  resample it to 44.1 kHz. Dynamic instead reproduces
  `Analyzer::setSample`: truncate each stereo channel independently through
  signed 16-bit PCM, then average them while retaining the possible half-LSB
  midpoint. It consumes source-rate PCM because its recovered detector
  measures positions in source frames. Waveforms follow the native reader
  instead: each stereo channel is rounded through signed 16-bit PCM and
  combined with an exact half-sum that preserves half-LSB values. Native 44.1
  and 48 kHz rates are retained. Other 8–200 kHz inputs select 48 kHz for the
  8 kHz family and 44.1 kHz otherwise, run each stereo channel separately
  through the recovered 29-tap Kaiser converter, then quantize and mix.
  WAV/other readers advertise the decoded length. FLAC adds its validated
  STREAMINFO maximum block size, even after a leading ID3v2 tag. For MPEG-1
  Layer III `Info` streams whose encoder field starts with `LAME`, Core Audio
  derives a CBR byte duration and rounds its packet count upward; the
  advertised final packet can therefore be absent. The clean reader
  reproduces that structural estimate and supplies its 1,152 frames as
  zeroes. The converted reader exposes
  `ceil(advertised * target/source) - 1` frames.
- The waveform path emits fixed 400-byte `PWAV`, 100-byte `PWV2`,
  1,200-column `PWV4`/`PWV6`, and variable 150 Hz
  `PWV3`/`PWV5`/`PWV7` arrays. Peak-power height quantization and known
  monochrome/RGB packing match the public ANLZ layouts. `PWV4` and `PWV5`
  share the native 1 kHz legacy filter stream, with their distinct reductions,
  color transform, and height packing reconstructed independently.
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
- Song-structure analysis computes beat-aligned bar features from total,
  low/mid/high-band energy, envelope onset density, and zero-crossing rate.
  Its frontend follows the recovered reader contract: signed-16-bit stereo at
  the native 44.1/48 kHz analysis rate, mixed as 99% left and 1% right.
  A bounded dynamic program combines standardized change evidence with
  mood-specific musical-duration priors. Post-leading phrase starts follow the
  final beat grid's actual downbeat labels. The result uses the native 32-byte
  `PSSI` header and 24-byte phrase records, including mood, end beat, phrase
  kinds, `k1/k2/k3`, the Up3 discriminator and internal beats, and bounded
  fill markers. `analysis.json` exposes mood, reader rate/mix, phrase count,
  end beat, and the first twelve complete phrase records as a bounded summary.
- Validated MPEG-1 Layer III `Xing` input gets the Rekordbox 6.8.2 400-entry
  `PVBR` table: offsets are relative to the first data frame and retain an
  eight-frame decoder preroll. `Info`/CBR, unmarked MP3, and VBRI input retain
  400 zero offsets but advertise the native reader's sample span in the final
  word. That span excludes the metadata-only `Info` frame and ID3v1, preserves
  the native floating-point 44.1 kHz frame estimate, and uses a validated VBRI
  frame count when present.
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
With every recovered path enabled, a paired ten-run Science Fiction Auto check
measured a `0.793 s` median at eight threads and `0.798 s` at twelve on an
Apple M2 Max. Power Dynamic previously measured `1.31 s` at eight threads
versus `2.27 s` at one.

The second profile-guided pass packs the ten BeatSensor biquads into four
two-lane NEON stages plus two dependent scalar stages, evaluates two PWV7
finite followers per vector, and replaces per-sample linear-resampler division
with an exact quotient/remainder phase accumulator. A five-run 1 kHz Samply
profile moved total process CPU from `9,873 ms` to `8,980 ms`. BeatSensor fell
from `1,683 ms` to about `1,142 ms`, PWV7 follower work from `587 ms` to
`277 ms`, and linear resampling from `450 ms` to `181 ms`.

The final 100-track, 8.55-hour Auto batch measured `14.62–14.78 s`
(`6.79–6.86 tracks/s`) with 12 processes sharing 24 Rayon slots. Twelve,
sixteen, and thirty-two slots measured `15.06/15.68/15.29 s`; 10 and 16
processes sharing 24 slots measured `14.64/16.01 s`. The TypeScript scheduler
therefore retains its host-bounded 12-process cap and two Apple-Silicon
scheduling slots per core. Small batches still use at most eight threads per
track, and explicit limits remain available through 64.

All 110 valid Dynamic corpus tracks were replayed after this pass. Their
DAT/EXT/2EX files are byte-identical to all 330 frozen pre-optimization
artifacts, so beat-grid and waveform differential metrics are unchanged.

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

Wall time was 0.52–0.98 seconds per track on the test machine. The original
detailed monochrome waveform (`PWV3`) correlations were 0.998, 0.985, and
0.999; color detail height (`PWV5`) correlations were 0.993, 0.913, and 0.986.
The later native `ZoomViewMaker` reconstruction replaced the PWV3 estimator.
It uses a signed-16-bit stereo midpoint, 150 Hz low-pass ratio, eight
whiteness thresholds, and globally normalized peak-squared height. Tiga and
Crystalised are now completely byte-exact; Science Fiction differs in two
1-LSB height entries and has exact whiteness.

The RGB path was subsequently re-derived from native boundary traces,
31 steady-frequency tones, amplitude ladders/ramps, and matched-PCM copies of
the same three recordings. Its input boundary is signed-16-bit rounded stereo
with the native exact half-sum described above. `PWV4`'s first
two lanes are the positive and negative source extrema. Its remaining lanes
come directly from the native legacy bank: `LP400`, two-stage `LP200`,
two-stage `HP200 → LP2000`, and two-stage `HP2000`. Per-millisecond band
dominance, saturation-before-dominance quantization, centered red/green
windows, and the native 1,200-column phase reducer complete the path. No fitted
green or blue filters remain.

`PWV5` consumes the same 1 kHz stream with separate `LP100`,
`HP300 → LP3000`, and `HP1500` color bands. Centered maxima and the native
nonlinear RGB transform produce three-bit hue; globally normalized
peak-squared amplitude produces its five-bit height. On fresh matched inputs,
all six `PWV4` lanes are byte-exact for Science Fiction, Pleasure from the
Bass, and Crystalised: 21,600/21,600 payload bytes. `PWV6` is also byte-exact
for all three. Crystalised's complete `PWV5` is byte-exact; Pleasure from the
Bass has byte-exact RGB and 99.9341% exact height; Science Fiction has exact
red/green, 99.9966% exact blue, and 99.916% exact height.

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

The final native reader and legacy-lane reconstruction materially closes
PWV4/PWV5 without changing any frozen beat grid. Across the same 110 tracks,
every PWV4 lane has median correlation `1.0`, median MAE `0`, and median exact
fraction `100%`. Entire tracks are byte-exact in 58/110 amplitude,
67/110 negative-extrema, 60/110 bottom, 63/110 red, 62/110 green, and 56/110
blue lanes. PWV5 median red/green/blue correlation is
`0.9999995/0.9999945/0.9999981`; median MAE is
`0.0000084/0.0000310/0.0000277`; and median exact fraction is
`99.99916%/99.99795%/99.99723%`. Height correlation is `0.9999927`, with
`99.89945%` median exact entries. PWV6 has median byte-exact output in every
lane. PWV7 median low/mid/high correlation is
`0.9999984/0.9999975/0.9999922`, with
`99.7913%/99.7998%/99.6640%` median exact entries. A final-versus-frozen
candidate replay has F1 `1.0`, zero p95 movement, exact phase, exact numbering,
and exact beat count on all 110 tracks.

## Linked Dynamic differential checkpoint

A fresh, read-only 113-input Dynamic replay completed on all 110 valid
references; the same three malformed sources fail closed. All 110 valid grids
have F1 `1.0`, exact beat count, exact aligned bar phase, and exact beat
numbering. Median p95 timing error is zero and mean p95 is `0.120518 ms`.
Rapture, Adam Ten Intro Mix, Another Dimension, and The Power are the only
nonzero-p95 rows at `0.229/12.426/0.227/0.375 ms`. The prior static
implementation reached 94/110, mean F1 `0.878300174`, and mean p95
`43.365 ms`.

The recovered low-frequency UnitEnvelope extractor, four-bucket scorer,
all-nonpositive first-peak fallback, zero-valued falling confirmation,
numbering branches, one-beat boundary repair, DASH AAC priming, and
format-derived FLAC reader tail produce an exact Life Is Hard grid and recover
seven previously missing FLAC endpoint beats. The recovered
whole-beat-rounded short-section fit closes Chopin at the exact 692 beats,
labels, and tempo changes with zero p95 error. Enforcing the native
one-eighth-beat survivor-spacing invariant at section bounds closes Conga at
the exact 867 beats and labels. The fixed-history startup rule closes
Funkytown: all 1,850 accepted candidate updates match band, peak, period, and
support, both paths retain 13,177 hypotheses, and the final 957 beats are
exact.

A separate 849-track audit confirms that Normal and Dynamic are distinct
analysis modes, not interchangeable quality levels. All 14 references with
local tempo movement pass in Dynamic. Of 835 static Normal references, Normal
passes 759 while forced Dynamic passes 606. Differential tests and the local
reference helper therefore require the same explicit mode on both sides.

## Song-structure differential checkpoint

The clean analyzer now emits a valid, non-empty `PSSI` phrase map rather than
empty optional scaffolding. The binary envelope and record layout are exact:
32 header bytes, 24 bytes per phrase, one-based contiguous indices, native
mood/end-beat positions, phrase-kind fields, `k1/k2/k3`, Up3 `b` and internal
beats, and optional fill markers.

The implementation is clean-room and beat-synchronous. It uses six independent
bar features plus the recovered low/divided-low native envelopes, standardized
novelty, mood-specific phrase-duration priors, and a bounded dynamic-programming
decoder. The first phrase retains native beat index one semantics. Every later phrase follows an actual
`beat == 1` label; `99.59%` of 113 native-reference post-leading boundaries
show that same contract.

A full 110-track read-only differential after native input/rate correction
reports:

- mood-family accuracy: `90.0%`;
- mean native/clean phrase count: `18.164/17.664`;
- phrase-count mean absolute error: `2.482`;
- boundary F1 exact/within 4/within 8 beat-grid entries:
  `0.5749/0.6914/0.7362`;
- first/last phrase-kind agreement: `99.09%/87.27%`;
- micro/macro kind agreement among boundaries matched within four entries:
  `61.93%/61.59%`.

These measurements establish a useful protocol-compatible baseline, not exact
proprietary phrase analysis. A complete replay rejected an attempted endpoint
bias because it traded a `+0.0016` exact-F1 change for worse four/eight-entry
F1 and worse matched labels. Further complete sweeps removed a redundant
boundary-level metrical bonus: duration priors already represented meter, and
the removal improved corrected-input exact/within-four boundary F1 by
`+0.0169/+0.0239`. A subsequent full-corpus sweep reduced local novelty
weight to `0.75`, improving exact/within-four/within-eight F1 by
`+0.0084/+0.0081/+0.0129` without changing mood, count, or end-beat results.
Labeling now reserves high-mood Down for a greater-than-one-standard-deviation
phrase-energy drop; it no longer treats every low-energy phrase or ordinary
positive fluctuation as a transition.

Linked-analyzer inspection also recovered and cleanly implemented the
multirate frontend. Every path cascades four zero-state
direct-form-II-transposed Butterworth sections with damping constants
`1.9615705608064609`, `1.6629392246050905`, `1.1111404660392046`, and
`0.39018064403225661`. The `Fs/2` path is high-pass at `0.275Fs`; `Fs/8` and
`Fs/32` are low-pass at `0.05Fs` and `0.0125Fs`. Decimators emit source index
`factor - 1` and discard incomplete tails. `generate_phrase_multirate`
exposes these deterministic primitives without routing production labels
through an incomplete feature port. A complete replay rejected feeding only
the recovered `Fs/8` stream into the independent six-feature model: mood
accuracy fell to `33.64%` and exact boundary F1 to `0.3584`.

The next clean-room checkpoint recovers the native consumers behind that
frontend as a separate diagnostic API. `extract_native_phrase_features`
reproduces the linked analyzer's one-based, constant-BPM beat-window rounding
at `Fs/2`, `Fs/8`, and `Fs/32`, then emits low/middle/divided beat sums,
low/middle/all beat peaks, four-way low-peak and raw-power slices, and
eight-way high-peak slices. The filters match the linked constructors:
`LP150 → abs → LP5`, `HP500 → abs → LP5`, `LP100 → abs → LP5`,
`HP400 → LP1000 → abs → LP10`, and
`HP5000 → LP7000 → abs → LP10`. Second- and fourth-order Butterworth damping,
first-order envelope coefficients, native quarter/eighth rounding, and
out-of-range zero behavior are explicit and unit-tested. The complete trace
remains diagnostic; production boundary selection consumes only `lowLevel`
and `dividedLowLevel`, while mood and phrase labels remain independent.
The `phrase-features AUDIO REFERENCE_DAT` diagnostic command reconstructs the
same 99%-left/1%-right reader signal, uses the frozen PQTZ BPM/first-beat
boundary, and emits bounded pages of those traces. The TypeScript wrapper
canonicalizes inputs, verifies the clean helper, and validates the complete
page before returning it.

The analyzer now emits at most 38 per-phrase feature diagnostics in
`clean-room-analyzer.log`; the first twelve are nested into the bounded JSON
summary. Each record carries six standardized features, duration, energy
delta, and transition distance. Track-grouped validation showed that these
independent features improve mood-2/3 label accuracy only from `29.55%` to
`31.96%`; deeper trees overfit. No learned relabeler was accepted. The next
parity step remains the exact native boundary and phrase-kind judges, not
corpus memorization.

The private reference tracer now captures the complete high-mood boundary
chain from low-peak seeds through break/big-change/irregular evidence,
`VerseHookJudge_All`, and final candidate adjustment. A phrase-only trace
scope keeps these bounded arrays and scalars while omitting unrelated
rhythm/waveform instrumentation; on a representative track it reduced JSON
from `32.8 MB` to `147 KB` without changing DAT, EXT, or 2EX bytes. These
runtime traces establish the exact candidate transformations, but remain
differential evidence only. Mood 2/3 use the separate native
`VerseHookJudge23` path.

The phrase-only tracer now covers that mood-2/3 branch as well:
`VerseHookAnaData23`, both top-level judge call sites, all three
`VerseHookJudge23Sub` calls, and `VerseHookAdd_genre23`. Hardware runs on one
mood-2 and one mood-3 reference produced no trace warnings and byte-identical
DAT/EXT/2EX output. The judge advances by 16 bars, evaluates overlapping
22-value windows through three sub-judges, merges their candidates, then lets
the genre pass insert additional boundaries. On the two audited tracks the
judge emitted 25 and 20 boundaries; the genre pass expanded those to 31 and
22.

`VerseHookAnaData23` is also ported as clean change-feature primitives. Each
feature group is max-normalized except for its guard tail, exact zeros used by
ratios become `0.003`, and adjacent values produce both `next/current` and
`max(r, 1/r)`. One input is first averaged in four-beat groups. Replaying the
Rust formula against the hardware trace is exact for three groups and within
`3.3e-16` for the averaged group. The traced producer inputs identify the
three judge families as bar-aligned `lowPeak`, `lowLevel`, and `middlePeak`;
the constant gain on `middlePeak` cancels during normalization. Dynamic-grid
window parity and the upstream seed candidates remain under investigation, so
production boundaries do not consume the native judge yet.

`VerseHookJudge23Sub` is now ported as
`judge_native_phrase_change_window`. The clean implementation reproduces the
stable top-change ranking, adjacent-pulse suppression, dynamic
`1.05/1.09/1.0573` mean thresholds, primary-feature exception, forward-window
tests, absolute bar mapping, and the native three-zero result cleanup limit.
It matches all `114/114` captured sub-judge calls across two mood-2 runs and
one mood-3 run, including windows where an otherwise valid candidate is
discarded because too many earlier ranked slots were rejected. This primitive
feeds the recovered top-level mood-2/3 judge.

`judge_native_mood_23_phrase_boundaries` now ports the complete
`VerseHookJudge23` wrapper: beat-to-bar seed cleanup, 22-bar windows every 16
bars, three-family merge, duplicate removal, consecutive-run collapse,
candidate scoring, fixed bar protection, and beat remapping. Native constants
include score weights `1.05/0.9/0.25`, zero floor `0.003`, adjacent ratio
`1.07`, and suppression ceiling `1.6`. Direct Rust replay from all nine traced
feature arrays matches both mood-2 captures at `25/25` candidates and the
mood-3 capture at `20/20`. The downstream `VerseHookAdd_genre23` insertion
pass and its upstream seed construction still gate production integration.

The downstream pass is now traced and ported at every helper.
`detect_native_mood_23_sound_changes` reproduces `SouonChangeDet`: native
four-beat accumulation order, its unpopulated guard bar, `0.003` zero floor,
folded adjacent ratios, `1.8` spike gate, and `1.11` two-bar settling gate.
Direct replay returns the exact captured mood-2 bars `[2, 225, 226]` and the
empty mood-3 result. `detect_native_mood_23_short_breaks` recovers both
adaptive falling-edge thresholds, the native beat-phase filter, and the
four-beat `>2.5` recovery test; two additional native references exercise
positive results at bars 138 and 54. `detect_native_mood_23_snare_fills`
matches all 32-sample peak windows and the downstream ratio state machine.
The native routine overwrites its lower-quantile scratch with the upper-ratio
array, so its lower threshold intentionally remains mean-derived.
`detect_native_mood_23_vocal_entries` reproduces both long-silence and
low-density short-gap paths.

`add_native_mood_23_genre_candidates` composes all four detectors with
`adjust_native_mood_23_phrase_candidates`. Direct Rust replay is exact at
every detector and at the final beat list across eight native mood-2 traces,
including positive and negative short-break cases. The final merge retains
the right edge of consecutive detector runs, suppresses detector bars within
one bar of an existing judged boundary, excludes the last four bars, and maps
results back to beats. Production integration is now gated by upstream seed
construction and dynamic-grid feature-window alignment rather than an
unported genre stage.

Schema-21 tracing closes the feature-window ambiguity. The linked
`BeatsSamplesCalcFX` receives one constant BPM and first-beat offset even when
the final PQTZ grid is dynamic, then builds all three one-based position arrays
with `trunc(rate * firstBeatMs * 0.001 + 0.5)` and
`trunc(period * i + start + 1.5)`. Mapoch uses `120.0/375 ms`, Fire uses
`153.6/105 ms`, and Uncle John's Band uses `136.4/143 ms`; the latter two prove
that the first quantized PQTZ BPM is not this input. The Rust position builder
already matches the recovered formula. Production now supplies the global
`BeatAnalysis.bpm` and the first integer `PQTZ.time_ms` exactly; it neither
adds the `PQT2` microsecond residual nor substitutes the first entry's local
BPM. A repeated 120-track replay completed without failures and retained
exact/within-four/within-eight F1 of `0.6182/0.6842/0.7137`, because the removed
sub-millisecond residual did not cross a final phrase decision in that cohort.
Mapoch and Fire have exact clean seeds. Uncle remains an upstream Dynamic-grid
miss (`134.77 BPM @ 411 ms` clean versus `137.02 BPM @ 143 ms` native), while
the clean global phrase BPM is already the exact native `136.4`.

The same trace captures
`IntroEndJudge_main` without changing DAT/EXT/2EX bytes: its four feature
arrays, two integer candidate arrays, selected beat, and success flag. On the
three references it emits intro candidates `[4]`, `[49,45,5,0]`, and
`[35,35,15,7]`, selecting beats `4`, `5`, and `35`. The remaining production
gate is the clean construction of this constant-tempo seed and the inner
intro/end judge, not any downstream mood-2/3 stage.

A newer 120-track read-only replay, using the same cohort before and after the
production low-level integration, reports exact/within-four/within-eight
boundary F1 improving from `0.5245/0.6348/0.6855` to
`0.6182/0.6842/0.7137`. All 120 tracks completed. Mood, phrase count, count
error, and end beat are unchanged; kind agreement among within-four matches
improves from `61.23%` to `61.80%`. A stable hash-held 37-track audit subset
independently improves from `0.5735/0.6726/0.7273` to
`0.6401/0.7154/0.7524`.

An isolated committed-HEAD comparator measured the initial non-empty phrase
stage at `+56 ms` (`+0.29%`) over 100 tracks. Samply attributed
`0.35–0.74%` of representative-track CPU to phrase analysis, almost entirely
to the scalar bar-feature scan. The live pipeline now overlaps that scan with
waveform/key work and hoists filter coefficients outside the bar loop.
Allocator samples never intersected a phrase stack. `target-cpu=native`, fat
LTO/one codegen unit, and their combination were `2.44–3.41%` slower than the
portable default on the same pinned workload, so release codegen remains
portable.

A 2026-07-29 Samply pass on the current exactness-heavy pipeline localized the
largest controllable block to waveform generation. Native loud-preview scratch
storage and detector events are now reused, pending samples are copied in
batches, and the two independent AArch64 loud filters share one NEON pair.
One-thread Auto batches also defer the unit-envelope phase until the linked
candidate is actually Dynamic or Normal fails; multi-thread single-track
analysis keeps the parallel path. The 100-track corpus still selects 97 Normal
and three Dynamic tracks, and all 300 generated DAT/EXT/2EX files are
byte-identical. Wall time fell from a stable `21.32–21.45 s` to `19.99 s`
(`204.07 s` aggregate user CPU), about five tracks/second and `1,540x` real
time. Twelve processes beat 16/20/24. Thin LTO remained within thermal noise;
`target-cpu=native`, Reth-style fat LTO/one-CGU, representative-corpus PGO,
and alternate allocators did not justify changing the portable system-allocator
release.

The recovered low-pass chain initially added about `104 ms` to a representative
397-second track. A 1 kHz Samply profile localized `95 ms` of CPU to the
eight-section `/32` filter. Its beat-independent envelope is now computed in
parallel with waveform, rhythm, and key analysis. Across eight alternating
debuginfo-release runs, median backend time changed from `1094.8 ms` with the
serial dependency to `989.2 ms`, statistically level with the `991.0 ms`
pre-integration baseline. The scheduled and serial implementations emitted
byte-identical DAT, EXT, and 2EX files.

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

- MPEG-2/2.5 Layer III, Layer I/II, and nonzero VBRI seek-table parity have no
  local Rekordbox oracle yet. VBRI sample-count trailers are implemented from
  the validated header, while its 400 offsets remain conservatively zero.
- Song structure is implemented as a deterministic beat-synchronous baseline.
  Exact proprietary phrase boundaries, mood family, phrase kinds, auxiliary
  variant/internal-beat fields, and fill placement remain differential gaps.
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
  `0.999989/0.999978/0.999944`; its complete PWV4 payload is byte-exact.
- `PWV2` is exact on all 162 synthetic preview fixtures and `PWAV` is exact on
  151; the residual synthetic misses are height-only amplitude ramps/sweeps.
  Across 106 aligned real sources, `PWAV` height/color exactness is
  `99.9033%/99.8868%` and `PWV2` exactness is `99.9906%`.
- Syncopated Normal meter inference, isolated source/oracle alignment
  outliers, exact phrase semantics, and unsupported MP3 seek variants remain
  high-value differential work.

Clean output is a protocol-compatible baseline suitable for import and
connected-player testing, not a representation of proprietary Rekordbox DSP.
The release gate remains strict: only the clean-room crate/binary may be
packaged. The reference helper, Rekordbox application bytes, generated cache,
captures, and local goldens stay outside release artifacts.

The npm package's explicit `files` allowlist excludes `vendor/`, and the helper
build script compiles `rust/bin/djbooth-rs` and its clean-room analyzer dependency. A
release therefore
does not require or copy the local reference rehost.

Universal helper builds place `LICENSE` and `THIRD_PARTY_LICENSES.md` beside
the executable. Symphonia 0.6.0 is MPL-2.0; the latter notice identifies the
exact corresponding source and both files must remain with any distributed
helper binary.
