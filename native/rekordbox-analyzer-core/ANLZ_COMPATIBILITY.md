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
```

`diff` compares all three files, SHA-256 hashes, lengths, ordered tags, and the
first differing byte. It exits nonzero on any mismatch.

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
- PQT2 words at offsets 12, 16, 20, 44, 48, and 52;
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
  monochrome/RGB packing match the public ANLZ layouts. Local corpus and
  pure-tone probes establish that each three-band entry is 7-bit
  low/mid/high, despite older public notes describing a different order.
- Rhythm analysis uses STFT spectral flux, bounded autocorrelation, tempo
  candidate scoring, and a deterministic phase/grid pass.
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
DAT/EXT/2EX persistence, PQT2 first/last anchors, optional `PVB2` preservation,
byte-identical artifact comparison, and clean ANLZ parsing. No user library or
proprietary fixture is mutated or packaged.

## Three-track differential

Release builds were run against three existing recordings and compared
read-only with their Rekordbox 6.8.2 oracle artifacts:

| Track | Reference BPM | Clean BPM | Error | Reference/clean key | Beat count |
| --- | ---: | ---: | ---: | --- | ---: |
| Science Fiction | 126.998379 | 126.788952 | 0.165% | D / D | 839 / 838 |
| Crystalised | 123.424746 | 123.295469 | 0.105% | Bm / Bm | 413 / 413 |
| Pleasure from the Bass | 126.983124 | 126.758357 | 0.177% | Gm / Gm | 493 / 491 |

Wall time was 0.52–0.98 seconds per track on the test machine. The detailed
monochrome waveform (`PWV3`) correlations were 0.998, 0.985, and 0.999; color
detail height (`PWV5`) correlations were 0.993, 0.913, and 0.986. Peak-power
quantization also brought clean/reference `PWV3` means within 0.14, 0.34, and
0.26 of one another.

This is not a byte-parity claim. The clean first downbeats were 137 ms early,
1,279 ms late, and 1,633 ms late. Two decoder/framer boundaries differed by 8
and 14 detail entries; the MP3 track matched its 59,528-entry oracle count
exactly.

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
- Unknown `PQT2` entry words use deterministic zero baselines and `PWVC` uses
  the observed fixed configuration. These values are not reverse-engineered
  DSP parity.
- Beat phase/downbeat post-adjustment and three-band filter/envelope/normalization
  remain the highest-value differential work.

Clean output is a protocol-compatible baseline suitable for import and
connected-player testing, not a representation of proprietary Rekordbox DSP.
The release gate remains strict: only the clean-room crate/binary may be
packaged. The reference helper, Rekordbox application bytes, generated cache,
captures, and local goldens stay outside release artifacts.

Universal helper builds place `LICENSE` and `THIRD_PARTY_LICENSES.md` beside
the executable. Symphonia 0.6.0 is MPL-2.0; the latter notice identifies the
exact corresponding source and both files must remain with any distributed
helper binary.
