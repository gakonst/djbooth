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
native/rekordbox-analyzer/target/debug/rekordbox-analyzer \
  diff REFERENCE_DIR CANDIDATE_DIR
```

`diff` compares all three files, SHA-256 hashes, lengths, ordered tags, and the
first differing byte. It exits nonzero on any mismatch.

`rebuild-anlz INPUT OUTPUT` performs a semantic clean-room rebuild for the
known Rekordbox 6.8.2 DAT/EXT/2EX shapes. All three real golden files rebuild
byte-for-byte. This proves the serializer and field mapping, not the DSP.

## Implemented exact binary surface

The PMAI envelope and every tagged section are parsed losslessly. Unknown tags,
repeated tags, header bytes, and payload bytes survive a general parse/build
round trip.

The semantic writer currently covers:

| File | Semantically rebuilt | Opaque but preserved |
| --- | --- | --- |
| DAT | `PPTH`, `PVBR`, `PQTZ`, `PWAV`, `PWV2`, empty cue scaffolding | non-empty `PCOB` entries |
| EXT | `PPTH`, `PWV3`, `PQT2`, `PWV4`, `PWV5` | `PCOB`, `PCO2`, obfuscated `PSSI` |
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
waveform quantizers, key detector, phrase detector, VBR seek construction, and
post-processing such as first-bar/half-double-tempo adjustment.

## Next vertical slices

1. Generate small, redistributable synthetic WAV probes (impulses, ramps,
   isolated bands, click grids) and capture oracle DAT/EXT/2EX goldens.
2. Recover exact sample framing and BA structure layouts from the unstripped
   functions, starting with fixed-width PWAV/PWV2 because their output space is
   smallest.
3. Implement audio decode/resample in clean Rust and match waveform probes one
   byte at a time.
4. Port beat detection and post-adjustment against click-grid and tempo-change
   probes.
5. Recover key and phrase analysis last; neither value is sufficient to make
   CDJ-loadable waveform/beat-grid files.

The release gate is simple: only the clean-room crate/binary may be packaged.
The reference helper, Rekordbox application bytes, generated cache, and local
goldens remain outside release artifacts.
