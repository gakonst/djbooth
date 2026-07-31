# Porting log

This file is the durable project journal: source pins, compatibility scope, decisions, milestones, and verification results.

## Source pins

- `dylanljones/pyrekordbox`: `f695541827cc488af267d6ca8a8e0052598d85a0` (2025-12-24)
- `wevm/incur`: `4c0fc4b15b4e0b72136f30b0a0ad25cc35e0a84b` (2026-07-10), npm `0.4.13`
- `Holzhaus/rekordcrate`: `e8574896b099d8b9e68b389a738e5872cdc8b5b2` (empty legacy Device Library scaffold and independent format reference)
- `fragmede/rekordbox-pdb-rs`: `b9896c4e279f2ffd5a8eee1f05a7a0282fe44f35` (independent generated-output verification)
- `Noelo-Lab/kuna`: `5834b3009cbcec3f3bddf1d5cafe50bb03e15474` (agent-oriented native decompiler used for Stems recovery)
- `deezer/spleeter`: v1.4.0 `4stems.tar.gz`, SHA-256 `3adb4a50ad4eb18c7c4d65fcf4cf2367a07d48408a5eb7d03cd20067429dfaa8` (public model provenance check)
- `ssmall256/mlx-audio-separator`: PyPI 0.1.5, source commit `0ddc8cf5507906b52ac45a9cd9e6d26e881a93f8` (MLX-native separation and checkpoint conversion)
- `SYH99999/MelBandRoformer4StemFTLarge`: `62371baf060e8205915b4e6e3f9459fc016b6dd1`, checkpoint SHA-256 `590358e6abe3255d87d7173ca2e4005de082f14cbb466ea4c5ffedbcc3964506` (Apache-2.0 four-source model)

The Python source at the pinned revision is the behavioral specification. Tests are ported or replaced with equivalent fixtures as each area lands.

## Compatibility matrix

| Area                         | TypeScript API | CLI             | Parity tests | Status                      |
| ---------------------------- | -------------- | --------------- | ------------ | --------------------------- |
| Configuration discovery      | implemented    | `config show`   | 4 tests      | complete                    |
| Utility functions            | implemented    | n/a             | 6 tests      | complete                    |
| Rekordbox XML                | implemented    | `xml ...`       | 6 tests      | complete                    |
| ANLZ files                   | implemented    | `anlz ...`      | 5 tests      | complete                    |
| My Settings files            | implemented    | `settings ...`  | 7 tests      | complete                    |
| Smart playlists              | implemented    | `smartlist ...` | 7 tests      | complete                    |
| Master database              | implemented    | `db ...`        | 5 tests      | complete                    |
| Master DB registry/aux files | implemented    | via `db ...`    | 1 test       | complete                    |
| Device Library Plus          | implemented    | `device ...`    | 4 tests      | complete                    |
| Legacy Device Library PDB    | implemented    | `music usb ...` | 9 tests      | hardware validation pending |

## Decisions

### 2026-07-30 — stacked deck checkpoint

- The production two-deck dock now places Deck A above Deck B, retaining one narrow mixer that
  spans both rows. Compact waveform, metadata, cue, live-stem, and rotary EQ controls remain visible
  while returning horizontal space to each track.

### 2026-07-29 — acquisition status and live deck stem mixing

- Hosted playlist rows now expose Download/Syncing/Ready/Retry state and durable item progress; the
  selected playlist adds explicit retry/stop controls and explains the verified-file reuse policy.
  Disabling a running subscription cancels its active worker without deleting completed media.
  Re-enabling coalesces active jobs, then relies on the shared Tracks artifact preflight and
  `resume-fast-path`: valid canonical recordings cause no downloader call, while invalid duration,
  identity, or media still repairs safely. The latest job lookup is indexed by provider/playlist.
- Completed MLX four-source jobs now attach same-origin streaming media elements to the playing
  deck's Web Audio graph. Orig/All/V/D/B/O controls switch or mute synchronized parts through short
  gain ramps, follow play/pause/seek/rate/volume, and correct drift without full-file decoding.
  Low/mid/high/trim controls are rotary vertical-drag sliders with complete keyboard semantics and
  double-click reset. The separate full audition dialog remains available for detailed comparison.

### 2026-07-29 — zero-stall provider reads and release-payload pass

- Converted expired hosted playlist and track cache reads to stale-while-revalidate. Known data
  returns immediately, one single-flight provider refresh updates memory and the bounded SQLite
  cache, failures retain stale rows with a short retry window, and mutation invalidation prevents
  an older in-flight refresh from repopulating a changed playlist. Warm bootstrap process display
  state is cached for one second; every write still takes a fresh process snapshot immediately
  before commit. Packaged warm `/api/bootstrap` requests measured `0.58–0.94 ms`, down from roughly
  `35 ms`; 100-track pages remained `12.9–17.9 ms`.
- Interactive compatible stems requests now coalesce over a 50 ms window and call
  `separateStemsBatch`, retaining one 3.76 GB MLX model load across the burst. Different output
  selections remain serialized separately, cached outputs short-circuit before inference, and the
  CPU analyzer lane remains independent.
- Release preparation strips the copied macOS Node 22 sidecar after validating it, removes 21.8 MiB
  of source maps/type declarations, and prunes runtime-dead native-addon build sources and
  browser-only YouTube bundles while retaining licenses. Thin LTO, one codegen unit, abort-on-panic,
  and symbol stripping apply to the small Tauri release shell, reducing it from 12.1 to 7.1 MiB.
  The final real app bundle measured 168 MiB versus 242 MiB at the previous checkpoint: 74 MiB
  removed (`30.6%`). Packaged encrypted-SQLite queries, YouTube extractor imports, Node 22 startup,
  and read-only Rekordbox status all passed after pruning.

### 2026-07-29 — automatic acquisition and agent-controllable dual decks

- Opening any Spotify or SoundCloud playlist now enables its durable acquisition subscription.
  The workbench delegates to the existing music-ts pipeline: provider metadata identifies the
  recording, Soulseek/native fallback acquires independent local media, and each verified file
  enters bounded clean analysis immediately. Provider streams are neither captured nor described
  as downloads. Hosted metadata freshness increased from five to 30 minutes while retaining the
  seven-day persistent stale/offline fallback and immediate local-state invalidation.
- Added two simultaneous local decks with streaming ANLZ waveforms, independent low/mid/high
  biquads, trim, equal-power crossfader gains, and 2–32 second smooth transitions. A provider track
  switches to the local content ID as soon as acquisition resolves; Spotify embeds remain outside
  the Web Audio mixer. Context actions load Deck B, and visible per-deck Stems controls enqueue the
  existing MLX path.
- Nanocodex now receives bounded deck state and typed tools for loading the selected local track,
  setting EQ, positioning the crossfader, and starting a timed transition. The agent can operate
  the mixer but is explicitly prohibited from claiming it heard or judged the output.
- Interactive processing deduplicates identical queued/running jobs, reuses complete stem files,
  and separates CPU analysis from the serialized MLX GPU lane so one of each may overlap. Production
  source maps are no longer shipped, and HLS loads only when SoundCloud needs it. The client bundle
  fell from 6.9 to 3.3 MiB; initial JavaScript fell from 948 to 460 KiB. Browser-only packages no
  longer duplicate into the Node sidecar, reducing the release app from 324 to 242 MiB. Browser
  smoke loaded two real library tracks into A/B with no runtime/player errors; all 173 package tests
  passed.

### 2026-07-29 — Tauri workstation and browser-WASM Nanocodex consumer

- Wrapped the existing local-first React library workstation in a Tauri 2 macOS shell. Release
  builds bundle a Node 22 sidecar and pnpm-deployed production tree, preserving the proven encrypted
  SQLite/native-addon boundary without requiring Node on the destination machine. The app bundle
  also carries the clean analyzer and uv; Python/MLX/model artifacts remain in the existing cache.
- Embedded the published `nanocodex/browser` Rust/WASM binding in a dedicated Worker with one
  persistent session. A loopback same-origin WebSocket relay consumes and atomically refreshes the
  standard Codex `~/.codex/auth.json` ChatGPT session, including account and FedRAMP headers; the
  webview/WASM worker never receives a token. An environment API key remains fallback-only. The
  full-height assistant rail shows user/assistant turns, reasoning/tool progress, typed execution
  receipts, and background analyzer/stems work. Its generated JavaScript Code Mode cells can fan
  out independent typed tool calls inside the dedicated Worker; the Worker receives neither OAuth
  tokens nor a direct database handle. Synthetic WebSocket close codes are normalized before relay,
  avoiding the packaged-backend crash observed with browser code `1005`.
- Collapsed Spotify/SoundCloud sections now remember their expansion state. Remote playlist and
  track metadata uses a bounded SQLite-backed cache (30-minute freshness, seven-day stale/offline
  fallback, 512 entries, 8 MiB per value) so app restarts and provider outages do not force repeat
  web fetches. Explicit downloads remain the durable cache for complete recordings; transient
  byte-range playback is still streamed rather than silently duplicating media.
- SoundCloud's confidential-client refresh requirement no longer breaks Finder-launched bundles.
  Interactive login opts into retaining the locally supplied app secret beside its rotating tokens
  in the existing atomic mode-`0600` session; old sessions migrate after one authenticated refresh.
  Environment values still override the saved value when non-empty, and secrets never enter the
  browser or repository.
- Added bounded local processing jobs for selected library tracks. Analysis and stems outputs are
  isolated under `~/Music/Rekordbox Derived/`; four-source results can be auditioned against the
  original on one Web Audio clock before any explicit library-import workflow is introduced.
- Split literal catalog search from semantic discovery. Mood, energy, occasion, warm-up, and
  set-building requests now inspect bounded local genre/BPM facets, retrieve quality-ranked and
  artist-diverse playable candidates, and resolve a model-curated 3–50 ID sequence into an
  in-memory temporary crate. The model never receives local paths, cannot invent unresolved IDs,
  and does not mutate Rekordbox while exploring a recommendation.

### 2026-07-29 — library-scale MLX model reuse and selected stem output

- Added `separateStemsBatch` and `stems playlist`. The playlist command opens the discovered
  Rekordbox 6/7 database read-only, resolves regular or smart playlist audio paths, deduplicates
  repeated memberships, and keeps one 3.76 GB model instance resident across serial track jobs.
- Replaced uv's per-command isolated environment with a lock-synchronized Python 3.12 environment
  under the stems cache. A warm `doctor` invocation dropped from `0.49 s` to `0.14 s`; the npm
  package remains free of Python wheels and the checked-in uv lock remains authoritative.
- Added repeatable `--stem` selection for acapella and part workflows. The model still predicts all
  four sources, preserving model behavior, while only selected compatible WAVs are written and
  hashed. Existing-output checks happen for the selected files before model loading.
- On the M2 Max, two swapped-order runs of identical 10-second vocals-only jobs took `1.77–1.79 s`
  in one batch and `2.23–3.41 s` as independent invocations (`1.26–1.91x` throughput). All generated
  vocal files were byte-identical (`a3fc9a5d...ba8d`). Writing vocals only reduced output bytes by
  75%; an earlier same-state gate showed inference-bound wall time effectively unchanged versus
  writing all four sources (`3.78 s` versus `3.87 s`).

### 2026-07-29 — local synchronized stems audition UI

- Added a dependency-free local Web Audio player for the 45-second London Grammar example. It
  keeps the reference mix and all four Mel-Band-RoFormer outputs on one audio clock, supports
  instant original/stem-sum switching, seeking, mute/solo, channel gain, and keyboard controls.
- The local Node server binds only to `127.0.0.1`, serves bounded known paths with WAV byte ranges,
  and accepts another complete four-stem directory through `--audio-dir`. The npm package includes
  the UI source but not audio or model artifacts.
- Retained the Python 3.12 + MLX runtime. A Rust binding port was deliberately deferred: MLXcel was
  only acceptable with a measured runtime advantage, and the existing Python path already runs the
  selected model faster than real time on the target M2 Max.

### 2026-07-29 — clean Apple Silicon Mel-Band-RoFormer stems backend

- Added `stems doctor`, `stems setup`, and `stems separate` plus matching TypeScript exports. The
  optional Python 3.12 environment is locked with uv and pins `mlx-audio-separator` 0.1.5. The npm
  package ships only the adapter and lockfile; model/runtime artifacts remain in the user's cache.
- Selected the public Apache-2.0 `MelBandRoformer4StemFTLarge` checkpoint: four 44.1 kHz stereo
  outputs, 384-wide/8-layer Mel-Band-RoFormer, 4,096 FFT, and a published MUSDB18 average SDR of
  8.9923 dB. The first setup authenticates the 3,764,030,874-byte checkpoint, then saves reusable
  MLX safetensors (SHA-256 `9d2817f7f0f5b002a89dcc4d0d50b9469d3acb92fab2cdfd869523945a2d4f86`).
  Inference itself does not execute PyTorch.
- Restored the checkpoint's `skip_connection: true` transformer schedule in the adapter. The MLX
  package supports multi-source output but omits that config flag and adds an untrained terminal
  normalization; the patched forward follows the pinned ZFTurbo source and leaves checkpoint weight
  naming/conversion unchanged.
- Default output deliberately matches the recovered Rekordbox wrapper: `bass + other` becomes
  instrumental, vocals pass through, and drums are derived from the mixture residual. The explicit
  `four-stem` layout publishes drums/bass/other/vocals directly.
- On the 12-core M2 Max/32 GB host, a one-second stereo float smoke test took 2.62 seconds on the
  first warm-up and used 3.92 GB maximum resident memory. The 10.88-second Spleeter demo then took
  1.49 seconds of measured model-load/inference/write time with 3.96 GB maximum resident memory.
  All outputs were 44.1 kHz stereo float WAVs; Rekordbox-layout reconstruction measured
  `8.35e-9` RMS and `5.96e-8` peak error on the music demo.
- Compared all four one-second outputs against the original pinned PyTorch architecture and the
  same checkpoint. Aggregate relative L2 error was `0.001046`, correlation was at least `0.9897`
  per source, and the maximum absolute error was `7.84e-4`; the largest per-source relative error
  belonged to a near-silent synthetic drums output. This is numerical backend parity, not a claim
  of exact samples or Rekordbox/Spleeter model parity.

### 2026-07-29 — Rekordbox 6 Stems model-boundary recovery

- Used Kuna's load-once Mach-O analysis against Rekordbox 6.8.2.0018's x86_64
  `libSpleeter.dylib`, then checked the recovered ABI by calling the exported C
  separator API under Rosetta. The reference-only `stems-probe` command loads
  TensorFlow 2.8 and the model from a user-supplied Rekordbox app, feeds bounded
  synthetic stereo PCM, and emits finite-count, RMS, peak, mean, SHA-256, and
  reconstruction diagnostics without opening a library database or user audio.
- The SavedModel accepts `mix_stft:0` as complex64 with shape
  `[-1, -1, -1, 2]` and exposes `mul:0`, `mul_1:0`, `mul_2:0`, and `mul_3:0`
  as vocals, drums, bass, and other. The native wrapper requests vocals, bass,
  and other; its published outputs are instrumental (`bass + other`), vocals,
  and drums (`mixture - instrumental - vocals`). It intentionally derives drums
  as a residual instead of publishing the model's drums tensor.
- Recovered a 4,096-sample periodic-Hann STFT, 1,024-sample hop, 512-frame model
  windows, and a 507-frame/519,168-sample inference stride. Each channel receives
  4,096 leading zero samples, and reconstructed output is read after the same
  4,096-sample offset. Added clean-room chunk planning and source recombination
  primitives with focused tests.
- Rekordbox initializes the wrapper as
  `separatorInitialize(modelPath, 0, 0, parallelAnalyze)`. Its production path
  is `separatorPreOperation` → repeated `separatorOperationAtIndex` →
  `separatorPostOperation`; each indexed call accepts stereo input and emits
  three stereo pairs in instrumental/vocals/drums order. The private reference
  helper now exercises this production path and differentially checks it against
  the exported `separatorOperationAtOnce` convenience path. All six 44,100-frame
  synthetic outputs matched bit-for-bit.
- A 44,100-frame differential probe completed successfully with all 264,600
  output samples finite. Summing all three outputs reproduced the two input
  channels within `2.97e-10/2.34e-10` RMS and `1.49e-8` peak error. Clean code
  currently covers only the wrapper/DSP contract; Rekordbox's bundled model and
  TensorFlow runtime remain local oracle inputs and are neither copied nor
  distributed.
- Deezer's public v1.4.0 `4stems` release and Rekordbox contain byte-identical
  checkpoint payloads: data SHA-256
  `3823e0ef50835cca3907c386dc9667a6a9af77b40a20c3ab845a8d6c9592255d`
  and index SHA-256
  `99ea41b3ef9bfbc6a34520409427af5ba7a883173e57ea25d6c487584b891b18`.
  Rekordbox therefore uses the stock public Spleeter weights behind its custom
  streaming wrapper; no retrained AlphaTheta/Pioneer model was found.
- Added `stems-reference REKORDBOX_APP AUDIO OUTPUT_DIR` to the private x86_64
  helper. It decodes one track to stereo 44.1 kHz float PCM with ffmpeg, invokes
  the recovered operation, refuses existing outputs, writes float WAV files for
  instrumental/vocals/drums, and reports bounded hashes plus reconstruction
  error. Deezer's 10.88-second Creative Commons demo completed with 479,832
  frames in each output through the recovered production ABI. This full-memory
  command is a differential oracle, not the final clean inference runtime.

### 2026-07-29 — Bidirectional, differential CDJ USB synchronization

- Make `music usb sync <mounted-root> --write` the normal round-trip boundary. Import all unseen
  legacy history tables before replacing `export.pdb`, create one root-level
  `DJ Set YYYY-MM-DD` normal playlist per history, preserve ordered duplicate plays, increment
  `DJPlayCount` once per imported history occurrence, then reconcile the complete active
  master-library track and playlist set back to the USB.
- Persist a versioned ownership marker with a stable media ID, per-generation ID, master content
  ID to DeviceSQL track-ID mapping, stable `/Contents/...` path, source file fingerprints, ANLZ
  output sizes, and imported-history receipts. Never guess track identity for histories on an
  unowned or version-1 export.
- Keep DeviceSQL track IDs and media paths stable across library additions and metadata changes.
  Reuse unchanged audio and rewritten ANLZ files, atomically replace only changed files and
  `export.pdb`, and remove only obsolete paths recorded in the previous ownership marker.
- Treat a history import as one guarded master-database mutation: use the shared cross-process
  lock, require Rekordbox and rekordboxAgent to be stopped, take a durable checksummed backup,
  commit all playlists/memberships/play counts once, then reopen read-only for SQLite integrity,
  foreign-key, exact playlist-order, and exact counter verification.
- Derive a deterministic playlist UUID from media generation plus complete ordered history
  content. This is the database-side idempotency receipt. Atomically checkpoint the corresponding
  USB receipt before compiling histories out of the fresh PDB, so retries are exact even if the
  database commit, marker checkpoint, and outbound media update are interrupted independently.
- Keep the current configfs appliance LUN read-only. Mounted physical media can complete this
  round trip now; accepting CDJ writes through the Orange Pi gadget requires a separate exclusive
  writable-partition handoff and must never dual-mount the deck-owned filesystem.

### 2026-07-28 — SQLite-to-CDJ-3000 legacy Device Library compiler

- Keep Rekordbox `master.db` SQLite authoritative. A front-USB export is disposable compiler output:
  copied audio, rewritten DAT/EXT/2EX analysis, a materialized playlist tree, and
  `PIONEER/rekordbox/export.pdb`. Do not route this workflow through Device Library Plus
  `exportLibrary.db`.
- Build fresh DeviceSQL pages from the documented legacy page, heap, row-directory, presence-mask,
  and string encodings. Start from rekordcrate's unchanged empty export scaffold so standard color,
  column, and menu rows stay deck-compatible; verify its byte length and SHA-256 before every use.
- Support MP3, M4A, FLAC, WAV, and AIFF with explicit legacy file-type values. Fail closed on missing
  local audio, missing DAT analysis, over-4-GiB files, unsupported formats, invalid playlist
  hierarchy, and incomplete generated row counts.
- Rewrite every copied ANLZ `PPTH` tag to its exported `/Contents/...` path and parse the result
  again before publication. Preserve regular-playlist order and duplicate memberships; materialize
  smart playlists through the existing master-database selector.
- Stage the complete output on the target volume and swap only the exporter-owned `Contents`,
  `PIONEER/USBANLZ`, and `export.pdb` paths. Refuse replacement without the prior export's ownership
  marker, and roll back renamed paths if installation fails.
- Verify 500-track page growth and full SQLite-to-filesystem exports in Vitest. Independently parse
  a generated Unicode/FLAC/playlist database with pinned `rekordbox-pdb-rs`; actual CDJ-3000
  enumeration and browsing remain a hardware gate.

### 2026-07-29 — clean-room song-structure baseline

- Replaced the empty `PSSI` placeholder with deterministic beat-synchronous
  phrase analysis. The clean writer reproduces the native 32-byte header,
  24-byte records, mood/end-beat fields, contiguous phrase indices, phrase
  kinds, `k1/k2/k3`, Up3 `b`/internal beats, and optional fill markers.
  The structured analyzer result now includes a bounded song-structure summary
  (reader rate/mix, mood, count, end beat, and first twelve phrase records), so
  CLI/agent consumers do not need to decode binary EXT data for basic audits.
- Binary inspection of Rekordbox 6.8.2 recovered the linked analyzer's
  streaming stereo-combination boundary, 44.1/48 kHz rate routing, staged
  song-structure pipeline, and exact `PSSI` packing contract. The clean
  frontend now consumes signed-16-bit stereo as 99% left/1% right at the
  routed reader rate. The remaining DSP stays independent: six bar-level
  energy/rhythm/spectral features, standardized novelty, a duration-prior
  decoder, and energy/change-based labels.
- Phrase boundaries after the leading record follow actual `beat == 1` grid
  labels instead of assuming that beat index zero is a downbeat. Across 113
  native references, `99.59%` of native post-leading boundaries use those
  labels; a phase-shifted synthetic regression test pins the behavior.
- On the 110 decodable-track differential, mood family matches `90.0%`.
  Native/clean phrase counts average `18.164/17.664` with `2.482` mean absolute
  count error. Boundary F1 is `0.5749` exact, `0.6914` within four beat-grid
  entries, and `0.7362` within eight; first/last phrase-kind agreement is
  `99.09%/87.27%`, and micro/macro kind agreement on boundaries matched within
  four entries is `61.93%/61.59%`. This is valid non-empty protocol output,
  not proprietary segmentation or label parity.
- Rejected a first/last-segment bias after a complete replay: exact F1 moved
  only `+0.0016`, while four/eight-entry boundary F1 regressed
  `-0.0024/-0.0067` and label agreement regressed `-0.0040`.
- Rejected a downbeat-relative meter phase because exact F1 fell from `0.5496`
  to `0.5058`. Boundary-prior sweeps instead showed that the duration model
  already supplied the useful metrical evidence; removing the redundant
  per-boundary bonus raised corrected-input exact/within-four F1 by
  `+0.0169/+0.0239`.
- A further complete sweep reduced local novelty weight to `0.75`, improving
  exact/four/eight-entry F1 by `+0.0084/+0.0081/+0.0129` with mood, count, and
  end-beat metrics unchanged. High-mood Down now requires a real
  greater-than-one-standard-deviation energy drop; removing the unvalidated
  positive-delta Up override raised matched-label micro/macro agreement from
  `45.73%/45.61%` to `61.93%/61.59%`.
- Recovered and implemented all three linked phrase frontend paths. Four
  zero-state direct-form-II-transposed Butterworth sections feed each
  decimator: high-pass `Fs/2` at `0.275Fs`, low-pass `Fs/8` at `0.05Fs`, and
  low-pass `Fs/32` at `0.0125Fs`, with native damping constants and
  `factor - 1` output phase. `generate_phrase_multirate` exposes the clean
  primitive without changing production labels. A full replay correctly
  rejected substituting only `/8` into the independent bar model (`33.64%`
  mood accuracy, `0.3584` exact F1).
- Recovered the native consumers after that frontend and exposed them through
  `extract_native_phrase_features`. The diagnostic trace matches one-based
  constant-tempo windows and emits low/middle/divided sums, low/middle/all
  maxima, four quarter-beat low/raw-power records, and eight high-band peak
  records. It uses the linked `LP150/5`, `HP500/5`, `LP100/5`,
  `BP400–1000/10`, and `BP5000–7000/10` chains with exact Butterworth damping
  and native rounding.
- Routed only the two strongest recovered families, `lowLevel` and
  `dividedLowLevel`, into production boundary evidence after a complete
  coefficient sweep. On the same 120-track read-only cohort, exact/four/eight
  beat-entry F1 improved from `0.5245/0.6348/0.6855` to
  `0.6182/0.6842/0.7137`; all tracks completed. Mood, phrase count, count
  error, and end beat are unchanged, while within-four matched-kind agreement
  improves `61.23% → 61.80%`. A stable 37-track hash audit independently
  improves `0.5735/0.6726/0.7273 → 0.6401/0.7154/0.7524`.
- Added `extractPhraseFeatures()` and
  `rekordbox analyze phrase-features AUDIO REFERENCE_DAT`. The command
  canonicalizes both read-only inputs, verifies the clean helper identity,
  reconstructs the native phrase reader mix/rate, validates every finite
  feature, and pages at most 4,096 beat records with self-consistent metadata.
  The generated Music/Rekordbox skill now exposes the command directly.
- Added bounded per-phrase feature evidence: all at-most-38 records in the
  clean log and the first twelve in `analysis.json`. Records include the six
  standardized features, duration, energy delta, and transition distance.
  Track-grouped validation improved mood-2/3 kind accuracy only
  `29.55% → 31.96%`; deeper trees overfit, so no learned relabeler was shipped.
- Extended the private x86_64 reference tracer to schema 16 across the native
  high-mood boundary chain: `VerseHookJudge_LowPeak`, `BreakFind`,
  `BigChangeFind`, `IrregularJudge`, `VerseHookJudge_All`, and
  `CandidateAdjust`. Bounded snapshots retain every input feature family,
  marker array, intermediate scalar/span, seed list, merged list, and adjusted
  list. Runtime traces corrected decompiler-only assumptions: the seed-offset
  priority is `32, 64, 16, 96, 48, 80`; the shared integer is the one-based
  feature origin; and `CandidateAdjust` consumes four-way-expanded
  `allLevel`/`lowLevel` bars before excluding the last four bars.
- A ten-track high-mood audit exercised zero and nonzero `BigChangeFind`
  outputs and attributed every inserted candidate through the full chain.
  The first fixture moved from eight low-peak seeds to eleven judge candidates
  and ten adjusted candidates. Mood 2/3 bypass this chain.
- Extended schema 17 over the separate mood-2/3 chain:
  `VerseHookAnaData23`, both `VerseHookJudge23` callsites, all three sub-judge
  calls, and `VerseHookAdd_genre23`. Live mood-2 and mood-3 traces had zero
  warnings and byte-identical DAT/EXT/2EX. The judge scans overlapping
  22-value windows every 16 bars; the audited judge/add stages expanded
  `25 → 31` and `20 → 22` boundaries.
- Ported the exact `VerseHookAnaData23` change-feature primitive. Four-beat
  averaging, guard-tail normalization, `0.003` ratio substitution,
  directional `next/current`, and symmetric `max(r, 1/r)` replay three native
  groups exactly and the averaged group within `3.3e-16`. Producer traces map
  the judge families to bar-aligned `lowPeak`, `lowLevel`, and `middlePeak`;
  dynamic-grid window parity and seed construction remain gated.
- Ported `VerseHookJudge23Sub` as
  `judge_native_phrase_change_window`. Stable ranking, adjacent-pulse
  suppression, adaptive mean thresholds, primary-maximum handling, future
  windows, absolute bar mapping, and the native three-zero cleanup limit match
  `114/114` captured calls from two mood-2 runs and one mood-3 run.
- Ported the complete top-level `VerseHookJudge23` wrapper as
  `judge_native_mood_23_phrase_boundaries`: native seed cleanup, overlapping
  windows, three-family deduplication, consecutive-run collapse, weighted
  score suppression, protected bars, and beat remapping. Full Rust replay from
  the nine captured feature arrays matches mood 2 at `25/25` twice and mood 3
  at `20/20`.
- Extended the phrase tracer through schema 20 with internal
  `findpeaks_ex` and vocal-candidate sort probes. Ported
  `ShortBreakDetection`, `SnareFillinDet`, and `VocalInDetection`, then
  composed all four detector helpers as
  `add_native_mood_23_genre_candidates`. Eight native mood-2 traces replay
  exactly at every helper and at the final beat list. The positive
  short-break fixtures emit bars 138 and 54. The snare port preserves the
  native overwritten-lower-quantile scratch behavior. Upstream seed
  generation and dynamic-grid feature-window parity now remain as the
  production gates.
- Added `REKORDBOX_ANALYZER_TRACE_SCOPE=phrase`. It installs only the six
  high-mood plus mood-2/3 phrase-stage hooks, leaving analyzer outputs byte-identical while
  reducing a representative trace from `32.8 MB` to `147 KB` (`223×`) and
  eliminating unrelated trace warnings. Full tracing remains the default.
  Repeated capacity warnings in the full tracer are now deduplicated.
- A valid committed-HEAD comparator measured initial phrase generation at
  `+56 ms/+0.29%` for 100 tracks. Samply placed representative phrase CPU at
  `0.35–0.74%`, almost all in the scalar feature scan. Phrase work now overlaps
  waveform/key analysis and filter coefficients are hoisted per track.
  Allocator samples never intersected phrase stacks. Native CPU codegen and fat
  LTO/one-CGU variants were `2.44–3.41%` slower, so portable release defaults
  remain intentional.
- Samply localized the new low-family cost to `95 ms` in the native `/32`
  filter on the 397-second Science Fiction fixture. Precomputing that
  beat-independent envelope beside waveform/rhythm/key work removed it from
  the critical path. Eight alternating debuginfo-release runs measured
  `1094.8 ms → 989.2 ms` median backend time, level with the `991.0 ms`
  pre-integration baseline. Serial and overlapped DAT/EXT/2EX outputs are
  byte-identical.

### 2026-07-29 — exact linked-rhythm boundary closure

- Recovered the native `Analyzer::setSample` boundary: truncate each stereo
  channel independently through signed 16-bit PCM, then average them while
  retaining the possible half-LSB midpoint. Direct PCM probes match
  `99.913%` of native float words; Dynamic analysis now consumes this signal
  independently of Normal rhythm, key, phrase, and waveform mixes.
- Added schema-23 tracing for `UnitEnvelopeMaker::analyze` and bounded
  `pcm-probe`/`unit-envelope --stages` diagnostics. The native strong-envelope
  detector emits a pending positive peak when its falling confirmation sample
  is exactly zero. The clean extractor now preserves that boundary.
- Recovered the fixed-history startup rule in `BeatSensor`: its first complete
  four-period candidate counts the current interval and requests one
  zero-initialized predecessor before the five real stored peaks. On a fresh
  Funkytown trace, all `1,850` accepted candidate updates match band, peak,
  period, and support exactly, and both implementations retain `13,177`
  hypotheses.
- A fresh 113-input Dynamic replay produced the same three malformed-media
  failures and exact results on all 110 valid references: F1 `1.0`, exact beat
  count, exact beat numbering, and median p95 timing error `0`. Mean p95 is
  `0.120518 ms`; the only nonzero p95 rows are Rapture (`0.229 ms`), Adam Ten
  Intro Mix (`12.426 ms`), Another Dimension (`0.227 ms`), and The Power
  (`0.375 ms`).
- Reused the half-LSB rhythm buffer when deriving monochrome waveform input,
  removing one full-track allocation and traversal without changing generated
  bytes. A same-state 100-track Auto comparison improved from `22.24 s` at
  committed HEAD to `20.78 s`; a representative single track improved from
  `1.386 s` to `1.334 s`. `target-cpu=native` remained neutral on the single
  track (`1.341 s` versus `1.338 s`) and slower under a hot batch
  (`25.92 s` versus `25.17 s`), so the portable release stays the default.

### 2026-07-29 — source-reader detail-count closure

- Closed the three residual `PWV3`/`PWV5`/`PWV7` count mismatches without
  track-specific metadata. The native analyzer uses JUCE's Core Audio reader;
  JUCE copies `kExtAudioFileProperty_FileLengthFrames` directly into
  `lengthInSamples`.
- For MPEG-1 Layer III `Info` streams whose encoder field begins with `LAME`,
  Core Audio computes the CBR duration as
  `(XingBytes - InfoFrameBytes) * 8 / bitrate`, then rounds
  `duration * sampleRate / 1,152` upward. On Rhythm In Motion and U So Fine
  this advertises one nonexistent packet. Direct `AudioFileReadPacketData`
  probes return zero packets at that final index, proving the waveform reader
  sees 1,152 logical zero frames rather than decoded audio. Controlled
  CRC-correct mutations from `LAME` to `Lavc`, and from `Info` to `Xing`,
  remove the extra packet; revision, method, and music-length mutations do not.
- FLAC preserves the previously recovered one-maximum-STREAMINFO-block
  extension after safely skipping leading ID3v2 metadata. This recovers Little
  Kitty's 4,608 logical zero frames.
- Fresh real-file analysis now exactly matches all three detail counts:
  `56,908`, `57,020`, and `51,868` entries in each of PWV3/PWV5/PWV7.
  Tiga, Crystalised, and The Power remain exact at `34,908`, `30,158`, and
  `48,747`. A 113-input replay matched counts on all 110 decodable references;
  the remaining three retain their pre-existing malformed-media decode errors.

### 2026-07-29 — native MP3 length and PVBR closure

- Recovered `FileReadMp3::FrameAnalyzer`, `checkXingVbri`, and `updateLength` from the linked
  Rekordbox 6.8.2 binary and checked the result against fresh stock analyses. `Info`, unmarked CBR,
  and VBRI files keep 400 zero seek offsets, but their final `PVBR` word is a native reader sample
  span rather than zero.
- The CBR path excludes the metadata-only `Info` frame and an end-of-file ID3v1 tag. At 44.1 kHz
  family rates it divides the remaining byte span by the exact floating-point nominal frame size;
  otherwise it uses the first frame's integral size. Validated VBRI headers use their declared frame
  count.
- Dam Swindle's complete 1,620-byte `PVBR` tag now matches a fresh Rekordbox oracle byte-for-byte:
  11,501 frames and 13,249,152 samples. The same rule independently predicts the malformed Darshan
  oracle's 19,094 frames and 21,996,288 samples despite its stale 18,759-frame `Info` declaration.
  Synthetic tests pin Info, unmarked, ID3v1, and VBRI behavior.

### 2026-07-29 — release code-generation benchmark

- Benchmarked the portable release, `-C target-cpu=native`, fat LTO with one codegen unit, and both
  options together on an M2 Max. All variants emitted byte-identical analyzer artifacts.
- On a controlled 100-track, 8.55-hour batch, the portable baseline won at `19.955 s` median.
  Native CPU was `1.17%` slower, fat LTO `4.66%` slower, and the combined build `8.13%` slower.
  Single-track results were likewise neutral or slower. Fat LTO reduced binary size by `31.6%`,
  but not analysis time.
- A fresh 1 kHz Samply profile attributes only `0.19%` leaf and `0.35%` inclusive CPU to allocation.
  Keep the portable release profile and system allocator; host-specific instructions, LTO, and an
  alternate allocator do not justify additional build complexity on this workload.

### 2026-07-29 — native PWV3 monochrome-detail closure

- Recovered the independent `ZoomViewMaker` path instead of deriving monochrome detail from the
  RGB waveform. It consumes the truncating signed-16-bit stereo midpoint, keeps native
  44.1/48 kHz input, and emits exactly 150 columns per second from 294/320-sample frames.
- Reproduced the continuous 150 Hz second-order Butterworth low-pass, raw and filtered peak
  truncation, eight 1/8-width whiteness thresholds, track-global peak normalization, squared
  height scale, and `(whiteness << 5) | height` packing. Silence correctly emits `0xe0`.
- Tiga and Crystalised now match all `34,908` and `30,158` PWV3 height/whiteness entries
  byte-for-byte. Science Fiction matches all `59,528` whiteness entries and all but two 1-LSB
  height entries. Its complete PWV4 remains byte-exact.
- A fresh 113-input Dynamic replay produced the expected 110 analyses and the same three
  malformed-media failures. Median per-track PWV3 exact fraction and MAE are `100%` and `0` for
  both components. Excluding the known mismatched Adam Ten source/reference pair, corpus-wide
  exact fractions are `99.97246%` height and `99.96583%` whiteness; 58/109 and 61/109 tracks are
  entirely byte-exact. Three source-reader boundaries retain `-4/-4/-15` entry-count deltas.
- The replay preserves the frozen beat result: all 110 tracks remain above `0.99` F1, phase is
  exact on 110/110, numbering is exact on 108/110, and mean p95 timing error is `0.834 ms`.
  Nightly formatting and 125 unit tests plus one intentional diagnostic ignore pass.

### 2026-07-29 — native waveform-reader and PWV4 closure

- Recovered the waveform reader's exact signed-16-bit stereo boundary. Each channel is multiplied
  by 32,768, clamped, truncated, and normalized by 32,767. Channels within `0.001` absolute
  magnitude select the stronger one, with right-channel tie breaking; other frames average.
  Rate-converted files resample left and right independently before quantization and mixing.
- Waveforms retain native 44.1/48 kHz input. Other rates select 48 kHz for the 8 kHz family and
  44.1 kHz otherwise. FLAC reader length includes one validated STREAMINFO maximum block before
  the final target-frame subtraction. This recovers Crystalised's 96→48 kHz path and the exact
  Tiga/Crystalised tail lengths.
- Removed the fitted PWV4 green/blue path. All six lanes now come from the recovered 1 kHz legacy
  bank, with native dominance, saturation, centered maxima, and phase reduction. Science Fiction,
  Pleasure from the Bass, and Crystalised are byte-exact in all 18/18 PWV4 lanes
  (21,600/21,600 payload bytes); all three PWV6 payloads are also byte-exact.
- Across the 110 valid reference tracks, every PWV4 lane has median correlation `1.0`, median MAE
  `0`, and median exact fraction `100%`. PWV5 median RGB correlations are
  `0.9999995/0.9999945/0.9999981`, with `99.99916%/99.99795%/99.99723%` exact entries. PWV6 is
  median byte-exact; PWV7 median correlations are `0.9999984/0.9999975/0.9999922`.
- Replayed every final output against the frozen candidate. All 110 grids retain F1 `1.0`, zero
  p95 timing movement, exact phase, exact numbering, and exact beat count. The three malformed
  media inputs continue to fail closed.
- Removed the obsolete fitted-filter work. Representative release analyses complete in `0.790 s`
  (Science Fiction), `0.400 s` (Pleasure from the Bass), and `0.722 s` (Crystalised). Nightly
  formatting, 123 unit tests plus one intentional ignored diagnostic, strict Clippy, the
  121-test package validation, and complete root `pnpm validate` pass.
- Built and ad-hoc signed the universal packaged analyzer, regenerated the three Dynamic
  reference/clean pairs, and replaced only the clean rows in playlist `103599839`. A stopped-library
  backup preceded the write. All nine installed ANLZ files parse, `PRAGMA quick_check` returns
  `ok`, foreign-key check is empty, and the alternating playlist order is unchanged.

### 2026-07-28 — second profile-guided analyzer performance closure

- Reprofiled the fully recovered Auto analyzer with Samply 0.13.1 at 1 kHz. Across five
  Science Fiction runs, process CPU fell from `9,873 ms` to `8,980 ms` (`9.0%`) while retaining
  byte-identical DAT/EXT/2EX output.
- Replaced ten heap-backed scalar BeatSensor stages with four bit-exact AArch64
  two-lane biquad pairs plus the two dependent mid-band stages. The BeatSensor leaf fell from
  `1,683 ms` to about `1,142 ms` across five runs.
- PWV7 finite followers now evaluate two independent detail columns per NEON vector. Tracks with at
  least four scheduling slots also split the ordered pairs across Rayon; one- and two-slot workers
  avoid nested-parallel contention. The follower leaf fell from `587 ms` to `277 ms`.
- Replaced per-output wide integer division in the 48-to-44.1 kHz linear path with an equivalent
  quotient/remainder phase accumulator. Reference-formula tests cover five rate families, and the
  sampled resampler cost fell from `450 ms` to `181 ms`.
- Replayed all 110 valid Dynamic corpus tracks at two threads each and compared every DAT, EXT, and
  2EX file against the frozen pre-optimization candidate: `330/330` files are byte-identical. Scalar
  versus NEON unit tests also pin BeatSensor, PWV7 followers, and every existing waveform filter.
- A paired ten-run Science Auto check retains the eight-thread default at a `793 ms` median
  (`798 ms` at twelve). The 100-track, 8.55-hour Auto corpus now completes in `14.62–14.78 s`
  (`6.79–6.86 tracks/s`), down from `15.88–15.92 s`. Twelve processes/24 slots remain optimal:
  12/12 measured `15.06 s`, 12/16 `15.68 s`, 12/32 `15.29 s`, 10/24 `14.64 s`, and 16/24
  `16.01 s`.

### 2026-07-28 — final Dynamic, waveform, and scheduling closure

- Replayed 113 read-only corpus entries after the final input-boundary and waveform work. Three
  malformed media inputs still fail closed. All 110 valid same-mode Dynamic comparisons pass at
  `>=0.99` F1; mean F1 is `0.999918881`, mean p95 timing error is `0.834 ms`, aligned phase is exact
  on 110/110, and beat numbering is exact on 108/110. Sixty tracks have zero median, p95, and maximum
  aligned timestamp error.
- Recovered fragmented DASH AAC presentation semantics from ISO BMFF `ftyp/trak/tkhd/edts/elst`.
  Symphonia's decoded stream is trimmed by the positive edit-list media time plus Core Audio's
  512-frame AAC delay. Life Is Hard therefore discards `1,600 + 512 = 2,112` frames and now matches
  all 717 stock beats, labels, and phase. Ordinary `M4A ` edit lists stay untrimmed because their
  stock grids prove a different backend contract.
- Removed the false generic 2,047-target-frame tail. WAV and other readers advertise decoded length;
  FLAC advertises decoded length plus validated STREAMINFO maximum block size. Conversion exposes
  `ceil(advertised * target/source) - 1` frames. This retains Power's exact 15,598,860-frame boundary
  and restores seven formerly missing FLAC endpoint beats. The native SRC accepts 8–200 kHz.
- Conga and Chopin are the only remaining internal Dynamic transition differences. Both first
  diverge at adjusted section origin/expansion, before generic gap repair and numbering. The
  disassembly-backed rule remains Rafael-exact; no track-shaped correction was accepted without
  native per-track BeatSensor survivor traces.
- Recovered the legacy PWV4/PWV5 filter, 1 kHz bucket, dominance, centered-window, reduction,
  nonlinear color, and height paths. Across 110 tracks, PWV5 median RGB correlations are
  `0.99722/0.98962/0.97689`, median MAE is `0.0242/0.0455/0.1240`, and median exact fractions are
  `98.21%/96.48%/93.03%`. PWV4 amplitude/bottom/red median correlations are
  `0.99930/0.99999/0.99999`. PWV6/PWV7 stayed byte-identical through this pass.
- Samply moved waveform CPU from 35.45% to 30.79%. Profile-guided cleanup removed ten obsolete
  fitted filter lanes and packs the 13 legacy plus five three-band biquads into bit-exact AArch64
  NEON pairs. Science Auto retains exact DAT/EXT/2EX hashes and measures `0.887 s` median; Power
  Dynamic measures `1.31 s` at eight threads versus `2.27 s` at one.
- The final 100-track, 8.55-hour Auto batch measures `15.88–15.92 s` with 12 analyzer processes
  sharing 24 Rayon slots (`6.28–6.32 tracks/s`). Twelve slots measure `16.12–16.68 s`, while 24
  one-thread processes measure `16.20 s`; extra scheduling slots help modestly, extra processes do
  not. Keep process concurrency bounded to host parallelism and 12. Apple Silicon defaults to two
  scheduling slots per core; small batches remain capped at eight threads per track.

### 2026-07-28 — Samply profiles and adaptive clean scheduling

- Profile the optimized, debuginfo-enabled Rust release with Samply 0.13.1 at 1 kHz. A five-run,
  491-second M4A scalar profile attributes 23.6% of CPU to decode, 23.4% to waveform generation,
  22.9% to beat spectral flux, 18.6% to key chroma, and 10.3% to beat post-processing. Stateful
  waveform biquads are the largest leaf at 21.3%.
- Single-track scaling plateaus at four native threads: medians are 1,456.7 ms at one thread,
  705.5 ms at four, 704.9 ms at eight, and 721.8 ms at twelve. Default clean single-track wrappers
  to four threads while preserving explicit overrides.
- Prefer independent process parallelism for batches. A cold 100-track, 8.55-hour corpus improves
  from 16.09 seconds at four processes to 11.33 seconds at twelve (29.6% lower wall time);
  an initial 24-process run reaches 11.23 seconds. Rotated repeats put 12 and 24 at effectively
  identical 11.402/11.401-second medians, while 32 reaches 11.503 seconds. Aggregate analyzer RSS
  peaks at 0.60 GiB at four processes, 1.60 GiB at twelve, 3.02 GiB at twenty-four, and 4.10 GiB at
  thirty-two on the 12-core/32-GiB profiling host.
- Default clean batch concurrency to `min(12, availableParallelism, threadBudget, uncachedTracks)`.
  Preserve explicit concurrency and thread budgets, ordered results, isolated processes, and
  deterministic worker-budget division. Both explicit limits remain available through 64 for
  deliberate oversubscription.

### 2026-07-26 — Composed CLI runtime

- Pin Incur `0.4.13` across every package mounted by `@gakonst/music`. Clean consumers must not
  resolve structurally incompatible Incur copies for parent and child CLI definitions.
- Restore the hardware-proven periodic UDP/50002 `LINK_REPLY(0x06)` media
  announcement in the vendored DJ Link server. A live USB replug changed the
  Mac link-local address; after rebinding, all three CDJ-3000 keepalives arrived
  but no status/query/ACK traffic returned until the compatibility beacon was
  restored.

### 2026-07-13 — Long-lived database sessions

- Expose explicit identity-map expiry for services that retain an open SQLite connection. Reject
  expiry while changes are staged or flushed so transaction rollback never loses its row state.
- Collect Rekordbox and rekordboxAgent PIDs from one operating-system process snapshot at commit
  guards, preserving the existing individual process lookup APIs for compatibility.

### 2026-07-12 — Analyzer distribution boundary

- Do not publish the repository's analyzer helper or any AlphaTheta/Rekordbox binary in the public
  npm package. Analysis discovers an explicit `analyzerBinary`, `REKORDBOX_ANALYZER_BINARY`, a
  `rekordbox-analyzer` on `PATH`, a user-local helper, or the repository-built development helper.
- Database, ANLZ parsing, locking, metadata, and web-library orchestration remain TypeScript-owned.

### 2026-07-10 — Runtime and packaging

- Require Node.js 22, matching incur's supported runtime.
- Use ESM, strict TypeScript, declaration output, pnpm, Vitest, Oxlint, and Oxfmt.
- Publish from one package with explicit format subpath exports and a `rekordbox` binary.

### 2026-07-10 — API parity policy

- Preserve the important upstream class names (`RekordboxXml`, `AnlzFile`, `MasterDatabase`, `DeviceLibraryPlus`) and semantics.
- Use idiomatic camelCase for the primary TypeScript API. CLI command names use kebab-case.
- Preserve lossless binary/XML round trips wherever pyrekordbox does. Mutating operations must never silently discard unknown data.
- Treat database write commands as opt-in and make dry-run/read-only behavior easy to select.

### 2026-07-10 — Dependencies

- Use `better-sqlite3-multiple-ciphers` for synchronous SQLite and SQLCipher-compatible access. The synchronous model maps closely to pyrekordbox's session-oriented API and incur command handlers.
- Use `fast-xml-parser` for low-level XML tokenization/serialization, wrapped by domain models so the public API is not coupled to the parser.
- Implement Rekordbox binary structures explicitly with `Buffer`/`DataView` instead of adopting an unmaintained Python-Construct analogue.

### 2026-07-10 — XML representation

- Keep the parser's ordered node representation internally so unknown attributes, elements, and their ordering survive a read/write round trip.
- Correct the upstream parsed-document ID bug by seeding auto-increment from the maximum existing track ID, preventing accidental ID reuse.
- Expose source-preserving writes in the library and optional output destinations in mutation commands; overwriting a source file remains explicit in the command invocation.

### 2026-07-10 — Binary preservation

- Keep original ANLZ tag bytes until a supported mutation occurs. This preserves unknown tags and retains the original garbled PSSI representation while exposing a deobfuscated parsed view.
- Bound large waveform/beat-grid CLI output by default and expose offset/limit controls through incur.

### 2026-07-10 — Database safety and mapping

- Introspect physical SQLite schemas at runtime and wrap all 37 upstream models with typed, mutation-tracked row classes. This tolerates schema additions across Rekordbox releases without discarding unknown columns.
- Open databases read-only by default. CLI mutations additionally require `--write`, and commits refuse to run while Rekordbox is open unless explicitly overridden.
- Use SQLCipher legacy mode 4 for Rekordbox's encrypted database and a logical schema/data export for plain-SQLite copies because native page backup cannot cross cipher formats.

### 2026-07-12 — Master playlist commit boundary

- Replace `masterPlaylists6.xml` atomically through a same-directory exclusive temporary file, file sync, and rename. Failed writes retain the original source path and modified state while cleaning temporary output.
- Mark the SQLite transaction closed immediately after `COMMIT`. Accept committed row state even when the subsequent companion-file save fails, so the original sidecar error propagates and `close()` cannot mask it with a second rollback error.
- Advance the global local-USN counter for delete events without assigning a field on models already marked deleted; physical playlist and membership deletions can now commit without violating row lifecycle guards.

### 2026-07-10 — Shared database engine

- Reuse the validated schema/query/transaction implementation for Device Library Plus through a composed internal engine. Keep `MasterDatabase` and `DeviceLibraryPlus` as distinct public types because identically named helpers such as `getContent` return different row families.
- Preserve SQLite autoincrement IDs on newly flushed rows, and recognize Device Library Plus's timezone-bearing date columns even though its declared SQLite storage type is `TEXT`.
- Apply the same read-only default and explicit CLI `--write` acknowledgement to exported device libraries. Support the separate upstream default SQLCipher key and `REKORDBOX_DEVICE_DB_KEY` override.

### 2026-07-10 — Compatibility naming

- Keep idiomatic camelCase as the primary TypeScript convention while exporting upstream ANLZ handler names (`PQTZAnlzTag` through `PWVCAnlzTag`), configuration aliases, `toDict`, and the deprecated `Rekordbox6Database` migration class where names carry compatibility value.
- Model SQLAlchemy session features with synchronous callbacks: lifecycle events, `noAutoflush`, registry value access, and temporary/persistent USN tracking controls.

### 2026-07-10 — Global CLI installation and CI

- Treat the database API as the primary product path; collection XML remains a supported interchange format rather than the default local-library interface.
- Install `rekordbox` as the canonical global command and `rekordbox-ts` as an explicit alias. Build `dist` during package creation so published archives do not require committed build artifacts.
- Require pnpm 10's explicit `--allow-build=better-sqlite3-multiple-ciphers` acknowledgement for global installs. This preserves pnpm's native-script security model while enabling the SQLCipher binding needed by database commands.
- Run validation on Node 22 across Linux, macOS, and Windows. Package/global-install CI additionally invokes both command names and queries a real plain SQLite fixture, preventing a command-shim-only false positive.

### 2026-07-10 — Adversarial hardening

- Treat row identity and transaction state as explicit invariants: newly inserted rows retain their lifecycle across autoflush/rollback/delete, default-only inserts use SQLite's `DEFAULT VALUES`, and primary-key changes atomically rekey the identity map.
- Reject invalid runtime values even when TypeScript callers would normally prevent them. This covers query directions and limits, playlist positions and hierarchy cycles, smart-list flags/IDs/numbers, impossible datetimes, and CLI JSON shapes.
- Convert every truncated known ANLZ tag into a domain `AnlzLengthError`, and run 1,000 deterministic mutation cases to prevent native buffer-range exceptions or unstable successful rebuilds.
- Enforce repository-wide coverage floors in a dedicated CI job. Process-level CLI tests exercise incur dispatch, both human/agent command discovery and JSON output, real plain-SQLite queries, malformed arguments, and the write-safety gate.

### 2026-07-10 — Full programmability parity

- Treat SQLAlchemy's open-ended engine/session as a capability requirement, not merely its high-level helpers. Expose parameterized arbitrary SQL, selected-column queries, streaming iteration, the native SQLite connection, explicit model construction, schema metadata, and matching registry hooks.
- Mirror the complete master and Device Library relationship graphs, including writable to-one relationships, association proxies, mutable relationship collections, tree parents/children, and SQLAlchemy's playlist delete cascade.
- Generate master-model physical-column augmentations from the exact pinned Python model source. The checked-in generated declarations give TypeScript consumers the same complete schema surface while runtime introspection continues to tolerate newer Rekordbox columns.
- Match ANLZ's mutable Construct-container capability with raw and parsed byte editors for every tag, automatic PSSI re-obfuscation, complete PQT2 mutation, reparsing/length validation helpers, and CLI byte patching.
- Expose arbitrary SQL for both database families and every new binary/settings operation through incur while retaining read-only defaults, bounded output, parameter binding, and explicit write acknowledgement.

## Progress

### 2026-07-10

- Inspected the complete pyrekordbox source/test tree (11,345 source lines, 2,617 test lines) and current incur API.
- Established source pins, project conventions, package exports, runtime dependencies, and the compatibility matrix.
- Created the initial TypeScript package and test/build scaffolding.
- Created and pushed the private `gakonst/rekordbox-ts` GitHub repository.
- Ported utility primitives, including byte-for-byte-compatible zlib/XOR/base85 obfuscation.
- Ported settings/options parsing and cross-platform Rekordbox 5/6/7 installation discovery.
- Added the incur `config show` command and 11 total tests.
- Ported the complete Rekordbox XML domain model: tracks, typed attributes, beat grids, position marks, playlist folders, playlists, key modes, mutation, serialization, and unknown-field preservation.
- Added read and mutation commands under `xml`, verified them against both Rekordbox 5/6 fixtures, and reached 17 passing tests.
- Ported all four My Settings binary formats with symbolic enum values, opaque-byte preservation, strict validation, and CRC-16/XMODEM generation.
- Differentially verified lossless parsing and mutation against all 155 upstream per-setting fixtures; the durable suite now has 24 passing tests.
- Added `settings list`, `show`, `set`, and `create` incur commands, including allowed-value discovery.
- Ported all 15 supported ANLZ tag types, including beat-grid/path mutation, cue lists, PSSI deobfuscation, VBR indices, and monochrome/color/three-byte waveforms.
- Differentially parsed, expanded, and byte-for-byte rebuilt 48 real upstream DAT/EXT/2EX fixtures; the durable suite now has 29 passing tests.
- Added bounded `anlz scan`, `info`, `tag`, `set-path`, and `set-beat-grid` commands.
- Ported smart-playlist XML, condition/operator validation, signed playlist-ID conversion, and parameterized SQLite compilation for all mapped properties.
- Added `smartlist parse`, `build`, and `sql` commands; the durable suite now has 36 passing tests.
- Ported the master database across 37 models: schema introspection, typed relationships, queries, search, staged mutations, rollback/commit, USN assignment, playlists, metadata/content creation, ANLZ coordination, and plain-SQLite export.
- Ported `masterPlaylists6.xml` mutation/synchronization and verified both encrypted and unencrypted upstream databases. The durable suite now has 42 passing tests.
- Added read, generic row, content, playlist, and explicit-write commands under `db`.
- Ported all 22 Device Library Plus models, typed columns, relationship and association-proxy traversal, all upstream query/add helpers, content search, transactions, JSON export, and SQLCipher/plain database access.
- Added `device info`, `table`, `search`, `copy-unlocked`, generic row mutations, content creation, playlist workflows, and My Tag workflows. The durable suite now has 46 passing tests.
- Audited public classes and methods across every pinned Python module, restored compatibility aliases and registry/session hooks, documented the TypeScript and incur interfaces, and prepared version `0.1.0`.
- Completed coordinated CLI coverage for master-library metadata, playlist deletion/rename/reordering, and content/ANLZ filename updates. The generated incur manifest contains 58 executable commands.
- Passed the final `pnpm validate` gate (lint/format, 46 tests, strict typecheck, declaration build), produced a 63-file/121.3 kB npm package, and installed it into a clean temporary project. Root and all format subpath imports plus the installed `rekordbox` binary passed on Node 22.
- Re-ran built CLI commands against upstream Rekordbox XML, My Settings, ANLZ, and encrypted `master.db` fixtures. Also copied the encrypted database to a temporary plain database and verified real metadata/playlist commits through the CLI.
- Confirmed `gakonst/rekordbox-ts` is private, uses `main`, and is synchronized with GitHub.
- Added GitHub Actions CI, source/package build lifecycles, globally installable `rekordbox` and `rekordbox-ts` commands, and database-level global-install smoke coverage. Reworked the README around `MasterDatabase` as the main API flow.
- The first live CI run exposed Windows CRLF checkout behavior in the formatter gate; added repository-wide LF attributes and upgraded to the current official action majors before rerunning the matrix.
- The Windows rerun then exposed POSIX-only XML path assertions. The implementation already matched pyrekordbox's platform-native `normpath`; made the parity tests assert native normalization on Windows as well.
- Completed an adversarial API/CLI audit and fixed transaction lifecycle, identity-map, bounded-count, default-insert, checksum-state, hierarchy-cycle, cross-playlist, runtime-validation, and truncated-binary edge cases.
- Expanded the durable suite from 46 to 56 tests, including 1,000 deterministic ANLZ mutations and subprocess-level CLI coverage. Added enforced V8 coverage floors and made the global package job depend on both cross-platform validation and adversarial coverage.
- Audited every public class method and top-level function in the pinned Python source with AST-generated inventories. Closed the remaining query/session, schema metadata, relationship read/write/cascade, model-construction, PQT2, arbitrary ANLZ mutation, settings reset, and XML return-value gaps.
- Added generated typings for every master.db physical column and new incur commands for arbitrary parameterized master/device SQL, PQT2 editing, raw/parsed ANLZ byte patching, and settings reset. The expanded suite passes 64 tests before differential fixture verification.
- Re-ran the pinned Python project itself under Python 3.12: all 278 upstream tests passed. Then expanded every tag from and byte-for-byte rebuilt all 48 real upstream ANLZ files, rebuilt all 169 My Settings fixtures, round-tripped both Rekordbox 5/6 collection XML fixtures, and sampled every mapped table from the encrypted upstream master database.

### 2026-07-12

- Hardened the direct master-database playlist commit boundary with atomic companion-file replacement and regression coverage for post-commit save failures, original-error propagation, cleanup, and close behavior.

## Next

The pinned pyrekordbox port and incur CLI are complete. Future work should track new upstream pyrekordbox or Rekordbox format revisions rather than expand the pinned scope.

## Native analyzer checkpoint

- Added a narrowly scoped Rust rehost helper containing only Rekordbox backend discovery/cache and
  native analysis code. The private package includes the same provenance-tracked minimal Rekordbox
  6.8.2.0018 runtime payload used by `djskills`; build caches and full application resources remain
  excluded.
- Added `analyzeTrack` plus `rekordbox analyze doctor|track`, producing parseable DAT/EXT/2EX files,
  an atomic JSON summary, and native log.
- Added `MasterDatabase.installContentAnalysis` and
  `rekordbox db content install-analysis` to copy verified artifacts into the UUID-derived share path,
  rewrite PPTH to the permanent content path, and update Rekordbox analysis fields.
- Extended installation to schema-validate `analysis.json`, bind its source fingerprint to the exact
  content audio path, persist tempo as integer BPM hundredths, normalize analyzer keys to canonical
  Camelot names, and resolve the corresponding active `djmdKey` row before commit. Added
  `MasterDatabase.syncContentAnalysisMetadata` and
  `rekordbox db content sync-analysis-metadata` for metadata-only repair without recopying ANLZ files.
- Strengthened set-import postverification to compare the reopened `djmdContent.BPM`, `KeyID`, and
  active key name with the analyzer summary. A warm checkpoint with installed analysis files but
  missing or mismatched BPM/key now enters the same backed-up transaction repair path instead of
  being accepted from `AnalysisDataPath` and `Analysed` alone.
- Verified native analysis against Rekordbox 6.8.2.0018 and database installation against a decrypted
  temporary copy of the live schema; the live library was not modified.
- Historical private builds included a vendored runtime. Public package verification now rejects
  AlphaTheta/Rekordbox binaries and requires an explicit or locally discovered analyzer helper.

## Playlist inspection checkpoint

- Added `MasterDatabase.listPlaylists` as the shared active-hierarchy inventory for the Rekordbox CLI
  and local library workbench. It filters soft-deleted and unsupported rows, batches regular-playlist
  membership counts, returns folder/regular/smart types with stable parent and sequence metadata, and
  preserves smart-count failures without failing the complete inventory.
- Added `rekordbox db playlist list`, returning the complete active hierarchy in Rekordbox tree order
  as an aligned table by default. `--type playable` selects regular and smart playlists, `--limit`
  and `--offset` opt into reported pagination, and `--json` adds canonical `pathSegments` and `idPath`
  alongside the presentation-only display path.
- Added `MasterDatabase.getPlaylistTracks`, a single joined query that preserves membership
  duplicates and orders regular playlists by `djmdSongPlaylist.TrackNo`. Smart playlists compile
  relation-aware criteria into one joined query with deterministic content ordering; unsupported
  criteria fail closed instead of widening the selection.
- Added `rekordbox db playlist show <exact-name>`, defaulting to Incur's aligned Markdown table and
  returning complete, chainable track metadata with `--json`. Exact-name ambiguity fails with
  candidate playlist and parent IDs; `--parent-id` and `--id` provide explicit scoping.
- Covered joined artist/key metadata, BPM hundredths, nullable duration, file formats, pagination,
  playlists over 100 tracks, duplicate memberships, smart criteria, JSON, Markdown, packed CLI/MCP,
  and ambiguity behavior with plain-database fixtures, then verified both output modes read-only
  against the encrypted live Adam Ten playlist.

## Native analyzer performance checkpoint

- Profiled one 6:25 M4A with Xcode 26 Time Profiler. The original wrapper took 18.14 seconds wall;
  the optimized wrapper takes 8.65 seconds wall with identical 124.999776 BPM, F key, and parseable
  DAT/EXT/2EX output. Native completion is 8.31 seconds; backend setup fell from about 0.50 seconds
  to 0.06 seconds and template preparation from about 0.67 seconds to below timer resolution.
- Removed cache-hit codesigning, recursive 44,000-file template scans, full 101 MB binary hashing,
  and full-image offset validation from the per-track hot path. Cold cache creation and `doctor`
  still hash every source artifact; the hot path trusts the sized provenance manifest and validates
  the known function signatures with bounded file reads.
- Replaced one-second polling and a fixed two-second delay with 25 ms polling plus output stability.
  Treat `.2EX` as a newly created file, use monotonic deadlines, report explicit timeouts, and guard
  callback state with a mutex instead of racing Rekordbox's callback thread.
- Time Profiler places the remaining CPU time in Rekordbox AAC decode, beat, waveform, vocal, and
  song-structure analysis. The wrapper does not have another material CPU hotspot.
- Added `analyzeTrackAsync`, bounded `analyzeTracks`, and `rekordbox analyze tracks`. Each concurrent
  track uses an isolated x86_64 process because Rekordbox has singleton/global analyzer state and the
  rehost redirects process-global stdout/stderr. Four real Brunello-set tracks completed in 9.10
  seconds wall with four workers; serial execution would take roughly 35 seconds. A later full-set
  profile measured 26 real tracks at 60.02 seconds with four workers, 32.23 seconds with eight, and
  28.83 seconds with twelve. A 64-default stress run completed 27 compatible real artifacts in 23.85
  seconds at effective concurrency 27 and 1.13 tracks/second; two other files reproduced a native
  `startAnalyze` incompatibility at concurrency one and were excluded. The original reference-engine
  default was four workers; the batch result reports preflight time, analyzer time, cache hits, and
  throughput. A warm 26-track cache validation took 11.65 ms.
- Packaged sanitized DAT/EXT seed shapes and made them the fallback when a local Rekordbox analysis
  library is absent. Build and packed-package smoke checks now fail if either seed is missing. An
  extracted npm tarball analyzed the same track with an empty HOME and no prebuilt runtime cache in
  14.58 seconds cold, producing the same valid DAT/EXT/2EX, BPM, and key result.

## Analyzer scheduler/cancellation checkpoint (2026-07-14)

- Historical Codex sessions and the benchmark above showed that a blanket 64-worker default
  oversubscribed interactive hosts. Batch analysis initially defaulted to four process-isolated
  workers; the 2026-07-28 clean-engine profile replaces that with a bounded CPU-adaptive default.
- Batch analysis exposes structured cache/start/completion/failure/cancellation progress. The Incur
  CLI renders it on stderr by default for humans and agents, with `--progress never` available.
- Progress callbacks are observational; callback exceptions are isolated from analyzer workers.
- A mixed-success batch throws `AnalyzeTracksError`, which carries indexed failure classes and the
  ordered partial result. Successful summaries stay durable and become cache hits on resume.
- A cancelled batch throws abort-compatible `AnalyzeTracksCancelledError` with the ordered sparse
  partial result and exact cancelled count, so callers can checkpoint completed/cache-hit work.
- Async analysis accepts an `AbortSignal`; SIGINT/SIGTERM abort active native children, escalate to
  SIGKILL after one second, and stop scheduling queued tracks. The synchronous single-track wrapper
  can reject an already-aborted signal but cannot interrupt `spawnSync()` after launch.
- The exact native `startAnalyze` status `-1` on Unicode-heavy paths retries through byte-identical
  ASCII input/output staging. Validated DAT/EXT/2EX/log artifacts move atomically to the canonical
  output path and the persisted summary is rewritten to the original source/output paths. Both real
  Brunello “Duel” variants completed through this compatibility path; unrelated failures do not
  trigger it.

## Content cue checkpoint (2026-07-13)

- Audited the pinned pyrekordbox declarations, the current Rekordbox 7 manual, PCOB/PCO2 parser,
  and a live database read-only. Confirmed `djmdCue.Kind = 0` for memory cues and `1..16` for Hot Cue
  slots A through P; `OutMsec = -1` distinguishes a point from a loop; memory ordering is temporal,
  not a stored sequence column; and master-library cue edits have a denormalized `contentCue.Cues`
  JSON mirror. No live database was modified.
- Added typed `ContentCuePoint`, `ContentCueInput`, `HotCueSlot`, and coordinated
  `getContentCues`, `upsertContentCue`, `deleteContentCue`, and `setContentCues` APIs. Mutations
  validate ownership, duration, millisecond quantization, cue/loop shape, active-loop use, comment
  and color bounds, ten-memory-cue capacity, unique Hot Cue slots, and canonical replacement order.
- Cue mutations stage the physical frame/time fields, increment `djmdContent.CueUpdated`, and sync
  the active `contentCue` JSON mirror in the same SQLite transaction. New arbitrary-time cues use
  Rekordbox's observed zero/null physical-field mode. Metadata-only edits preserve native MPEG,
  microsecond, beat-loop, and seek fields; moving a cue consistently downgrades those fields to the
  zero/null mode rather than creating a hybrid row. PCOB/PCO2 ANLZ tags remain byte-preserving and
  read-only until the binary writer can safely update every redundant cue representation.
- Added Incur `db content cues`, `set-cue`, and `delete-cue`. Mutations require explicit `--write`,
  reject the general `--allow-while-running` bypass, canonicalize real/relative/symlink database
  paths onto the shared `.tracks-ts.lock`, serialize stale-lock reclamation, verify the lock inode
  and UUID ownership token before release, require both Rekordbox processes stopped, create a
  checksummed pre-write database/companion backup and durable outcome journal, commit once, then
  reopen read-only for SQLite integrity and exact semantic verification. Update-by-ID uses patch
  semantics so omitted Hot Cue loop, comment, and color fields are preserved.
- Added copied plain-SQLite fixture coverage for reads, row classification, creation, slot upsert,
  deletion, exact replacement, mirror synchronization, physical field values, ordering, limits,
  malformed input, cross-content ownership, guarded backup/journal receipts, process refusal, and
  canonical-lock contention, mirror-field corruption, and exact CueUpdated verification. The
  package suite passes 98 tests.

## Pro DJ Link protocol/network checkpoint (2026-07-26)

- Imported the provenance-tracked `djskills` Rust server into `@gakonst/djlink`; the TypeScript
  bridge projects completed Tracks manifests into bounded RemoteDB/NFS libraries and exposes
  managed `music djlink doctor|start|status|devices|load|monitor|stop` commands.
- Wrote a versioned protocol map with pinned Beat Link, Dysentery, and prolink-connect references.
  Added golden keepalive, CDJ status, load-command, and load-ack packets from the proven CDJ-3000
  capture set. Replaced keepalive byte-offset parsing with typed frame/header/body codecs.
- Restored macOS interface fidelity lost during the async actor port. Every DJ Link UDP socket now
  uses `IP_BOUND_IF`; outbound TCP side channels bind the same interface and source address. A
  dedicated blocking actor exclusively owns the BPF descriptor for MAC-directed packets and
  1,500-byte IPv4 fragmentation, without holding a mutex across an async suspension point.
- Kept the kernel socket as the primary path. Link-local route failures and oversized NFS replies
  fall back to raw Ethernet/IPv4/UDP; broadcast failures use the interface broadcast MAC. Strict MAC
  parsing and reassembly tests cover the observed 64,512-byte NFS response ceiling.
- The focused Rust suite passes 88 tests. Live verification remains gated on renewed CDJ
  announcements; no unverified transport command or automatic PLAY action is enabled.

## Pro DJ Link source/pcap lab checkpoint (2026-07-26)

- Kept the provenance-tracked Rust implementation in `packages/djlink/native` and made direct
  `cargo run -p music-djlink` the protocol iteration path. Added `audit-pcap` for bounded JSON
  packet-shape reports, mandatory source-discovery gates, reference diffs, and exact static-payload
  checks against `/Users/gakonst/github/gakonst/djtools/rb-tracks.pcap`
  (`519c84fe225d5b310e7ab73c84bc2333c0ee7c048b32a5d3f11f9d519baf1845`).
- Added a source-owned `--wire-pcap` sink at the raw-BPF writer. It records only Ethernet frames
  successfully injected by the server, closing macOS's observability gap where a second BPF
  consumer does not see injected frames. External interface capture remains authoritative for
  deck replies.
- Promoted the real Rekordbox `0x16`, `0x29`, `0x06`, and `0x47` payloads plus the CDJ-3000
  `0x46` trigger into typed golden codecs. The real and formerly working captures prove
  `0x05→0x06` and `0x46→0x47` are unicast, response-gated exchanges; removed the rewrite's
  non-faithful periodic `0x06` broadcast.
- A live source capture passes the keepalive/link-init/mixer-status gates and matches the real
  Rekordbox `0x16` and `0x29` bytes exactly. The wired interface remains frozen at 480 inbound
  packets and the daemon sees zero decks, so hardware load verification is still gated below the
  parser by absent switch/deck ingress. The current Rust suite passes all 95 tests; the complete
  `@gakonst/djlink` validation also passes.

## Pro DJ Link RemoteDB cursor checkpoint (2026-07-26)

- Recovered the original native Rekordbox `rb-tracks.pcap` from git object
  `123e84e` and decoded it independently from the stale checked-in report. Native next-track
  renders at offsets 1 and 2 return `MENU_HEADER [1,1]` and `[1,2]`; the failing live server trace
  returned the correct track rows and file data but wrapped both in `MENU_HEADER [1,0]`.
- Changed render responses to echo the requested offset in the menu header. This is the concrete
  wire delta associated with the physical CDJ-3000 `NOW LOADING`/Back-button failure.
- Removed the per-deck-IP actor cache that guessed render menus by key and row count across TCP
  connections. Each spawned RemoteDB connection now owns only its last prepared menu, matching the
  protocol's request-then-render transaction model and isolating concurrent browse/metadata
  sessions without mutexes or reconnect recovery.
- Added regression coverage for nonzero native header offsets, last-request replacement, exact
  `r:m:s:t` matching, total-count rejection, parallel connection isolation, and stale-device
  expiry. Focused tests pass; the full Rust workspace passes 110 tests.
- Extended `audit-pcap` to reassemble every TCP direction, decode typed RemoteDB messages, correlate
  RENDER/MENU_HEADER pairs by transaction, and gate on at least one nonzero cursor. The immutable
  native capture passes all 25 renders; the prior broken live capture fails exactly three nonzero
  renders with header offset zero. Exact transaction `0x1883` request/response bytes are golden
  fixtures.
- Changed `music djlink rekordbox` with no track into one validate → start/resume → discover flow;
  refreshed Incur hints, retry metadata, CTAs, the canonical/plugin/global Music skill, and the
  generated global `music-djlink` skill. The complete root `pnpm validate` passes. Live repeated
  physical TRACK SEARCH verification remains the final hardware gate.
- Fixed actor-owned discovery expiry to enforce Beat Link's 10-second maximum announcement age and
  clear stale link/status/load state. A fresh restart now reports no devices instead of three
  14-minute-old false positives; player 3 still answers ARP but is not currently emitting DJ Link
  keep-alives, so the final gate awaits a physical wake.

## Pro DJ Link live load parser checkpoint (2026-07-26)

- Reconnected three physical CDJ-3000s and restarted the server on the adapter's renewed
  `169.254.147.145` link-local address. Added raw unicast fallback for macOS
  `EADDRNOTAVAIL` (`os error 49`) during link-local address churn.
- Verified the cursor change on player 3: a real Track Search render at offset 1 returned
  `MENU_HEADER [1,1]`, and the typed capture auditor reported 78 matching render/header pairs with
  no mismatch or missing header.
- Re-derived the remaining Back-button stall from the raw TCP capture. A `WAVEFORM_PREVIEW`
  request advertises five argument types but deliberately omits its final zero-length blob. The
  parser's blocking `peek()` waited for the first byte of the next request, so Back or the deck's
  15-second retry accidentally released the previous load.
- Replaced that heuristic with the RemoteDB length invariant: when a blob's immediately preceding
  length is zero, synthesize an empty blob without reading another byte. A regression test replays
  the exact 45-byte CDJ request while keeping the connection open and proves parsing completes
  without a follow-up request. The live server replay now returns the 948-byte waveform response in
  1.49 ms.
- Matched native Rekordbox artwork behavior by decoding, center-cropping, and caching 240×240 JPEG
  thumbnails instead of serving 500–800 px originals. The native capture contains only 240×240
  JPEGs (maximum 20,966 bytes); the old server sent images up to 105,957 bytes. RemoteDB sockets now
  enable `TCP_NODELAY`, check every load-path response write, and log response byte counts or exact
  errors rather than discarding `write_all` results.
- Verified the complete fixed path against physical CDJ-3000 player 3 with track `79496558`. The
  deck requested mount data after 4.8 ms, received its waveform-preview reply in 197 µs, began NFS
  FLAC reads after 293 ms, and reported the track paused/cued after 433 ms. Its artwork was a
  native-sized 15,639-byte JPEG and no response write failed. Nightly formatting and all 113 Rust
  workspace tests pass; the complete root `pnpm validate` also passes on Node.js 22.
- Verified a second consecutive hardware load without Back: player 3 acknowledged track `24490981`
  (`Glue`), completed metadata, analysis, artwork, waveform, and NFS requests, then reported it
  paused/cued after 536 ms. The final capture contains 13 matching RemoteDB render/header exchanges,
  zero mismatches, zero missing headers, and no TCP sequence gaps. The earlier physical Track
  Search capture remains the cursor gate: 78 matching exchanges including offset 1.

## Pro DJ Link search checkpoint (2026-07-27)

- Added an end-to-end loopback regression for the native CDJ Search flow. It fragments the
  documented packed `r:m:s:t,sort,len,query,zero` request across TCP writes, requires a bounded
  success response, and asserts the exact loadable title-and-artist row plus menu header/footer.
  It then issues a second split-context artist Search and packed render on the same connection,
  proving the prepared menu advances without Back or reconnect.
- Precomputed normalized title, artist, album, canonical-name, and metadata search documents when
  the server loads the Rekordbox snapshot. The 14,929-track live library's `SCIENCE` query dropped
  from 232.7 ms to 9–18 ms with identical results; an intentionally broad one-character query
  dropped from 81.9 ms to 31.4 ms after removing per-comparison title allocations.
- Added bounded, read-only `music djlink search <query> --mode track|artist|album` diagnostics over
  the protected control socket. It uses the exact prewarmed matcher and RemoteDB row builder served
  to CDJs, separating local index/result failures from a deck that never sends `SEARCH(0x1300)`.
  Updated CLI hints, README, canonical Music skill, and bundled plugin guidance.
- Removed the stale unsolicited `LINK_REPLY(0x06)` broadcaster. The native Rekordbox capture has
  one unicast `0x05 -> 0x06` exchange; the live corrected source likewise answered one startup
  query per deck and emitted no periodic media reply. The existing request handler remains
  byte-exact against the captured Rekordbox packet.
- Two bounded player-3 captures contained status traffic but no TCP/1051 data, Search status menu,
  or `SEARCH(0x1300)` request because no physical Search submission occurred during their windows.
  Final physical Search UI activation/result/load proof remains open.
- A subsequent trace captured the missing CDJ-3000 path: keyboard edits emitted `0x1500` requests
  (`R`, `RA`, `RAF`, `RAFA`) with packed context, sort, UTF-16 byte length, and string, but the
  server returned `INVALID_REQUEST(0x4003)`. The deck closed and rediscovered RemoteDB after each
  rejected keystroke. Added `0x1500` as incremental Search using the same prewarmed matcher,
  connection-local pending menu, and loadable row builder as legacy `0x1300`; pinned the captured
  `RAFA` request as a golden fixture and extended the no-Back same-socket Search/Render regression.
  Nightly format and all 112 `djtools-link` tests pass. Physical result/render/load proof is pending.

## Clean-room analyzer checkpoint (2026-07-27)

- Split a releasable `native/rekordbox-analyzer-core` crate from the private Rekordbox rehost. The
  core has no Rekordbox/JUCE bytes, loader offsets, patched application cache, or native framework
  dependency.
- Added a strict PMAI/tag parser and writer that preserves unknown headers, repeated/unknown tags,
  and opaque payload bytes. Added semantic builders for the complete Rekordbox 6.8.2 DAT, EXT, and
  2EX shapes: paths, VBR index, beat grids, all waveform families, and PWVC. Non-empty cues and the
  obfuscated song-structure payload remain losslessly opaque.
- Re-ran the same local audio through the 6.8.2 reference rehost. All three outputs matched the
  retained analysis byte-for-byte, establishing that the proprietary implementation is a stable
  exact oracle. The Rust semantic writer then rebuilt its 9,054-byte DAT, 188,324-byte EXT, and
  182,358-byte 2EX byte-for-byte.
- Added a structured `diff` gate with SHA-256, ordered-tag, length, and first-different-byte reports,
  plus `rebuild-anlz` for serializer parity. Unit tests cover malformed lengths, unknown-byte
  retention, DAT/2EX semantic round trips, checked-in sanitized DAT/EXT templates, and differential
  localization.
- Static symbols show that JUCE supplies orchestration, strings, threads, and audio I/O, while
  `BA_*` and `peakss::*` implement proprietary beat, waveform, and key analysis. Release-ready DSP
  parity remains open: audio framing/resampling, waveform quantization, VBR indexing, beat
  detection/post-adjustment, key detection, and phrase analysis must be re-derived against
  synthetic oracle probes. The vendor helper and Rekordbox runtime remain local-only references and
  must never enter release artifacts.

## Clean DSP and physical incremental-search checkpoint (2026-07-27)

- Completed a clean Rust audio-to-ANLZ path: Symphonia decode, deterministic mono/44.1 kHz
  resampling, all seven waveform families, spectral-flux/autocorrelation rhythm analysis,
  tuning-aware chroma/HPCP key detection, MP3 VBR indexing, and atomic DAT/EXT/2EX plus
  helper-compatible summary output persisted as `analysis.json` by the TypeScript wrapper. Nightly
  format, 25 passing unit tests, two end-to-end integration tests, and strict
  all-target/all-feature Clippy pass.
- Differential-tested three real recordings without mutating the library. Tempo error was
  0.105–0.177%; key matched D, Bm, and Gm; detailed monochrome waveform correlation was
  0.985–0.999; release analysis took 0.52–0.98 seconds per track. Downbeat phase, three-band
  normalization, phrase `PSSI`, and proprietary DSP byte parity remain open and are reported
  explicitly. Semantic EXT rebuilds preserve FLAC `PVB2` sections byte-for-byte.
- Re-derived `PWV7` packing from 114 local 6.8.2 2EX oracles (5,279,881 entries) plus deterministic
  pure-tone probes: bytes are 7-bit low/mid/high, not 8-bit mid/high/low. Correcting only those two
  proven fields raised aligned three-track band correlations from 0.158–0.782 to 0.533–0.937 and
  cut mean per-band absolute error from 31.58–48.12 bytes to 9.50–12.78 bytes. The overlapping
  filters, stateful envelope, and channel-specific nonlinear normalization remain open.
- Re-derived MPEG-1 Layer III `PVBR` from 44 paired local Rekordbox 6.8.2 analyses: 36 CBR inputs
  retain the native zero table, while eight `Xing` VBR inputs match all 3,200 oracle entries using
  first-data-frame-relative offsets and an eight-frame decoder preroll. The Science Fiction
  generated `PVBR` tag now matches its oracle SHA-256 exactly. Unsupported MPEG/VBR variants fail
  conservatively to the zero table rather than emitting guessed byte offsets.
- Re-derived FLAC `PVB2` as 400 big-endian
  `{sample index, first-frame-relative byte offset, frame block samples}` entries. Targets use
  `i * floor(totalSamples / 400)` and select the last CRC-8/CRC-16-validated FLAC frame at or before
  each target. The clean 8,032-byte tag matches three independent Rekordbox 6.8.2 FLAC oracles
  byte-for-byte; malformed, discontinuous, oversized, and non-FLAC inputs omit this optional EXT
  tag instead of emitting guessed offsets.
- Made clean analysis the TypeScript and one-shot Tracks default. Added explicit
  `clean|reference` engine selection, engine-safe caches, helper/runtime separation, and
  `import-set` analyzer binary/cache/timeout plumbing. An identity handshake rejects the legacy
  proprietary helper before clean audio analysis; the clean doctor and a full Crystalised CLI run
  pass without loading Rekordbox.
- Changed the analyzer build to produce only the clean universal Rust helper outside `vendor`.
  Package release files exclude the tracked private reference helper and the 102 MiB Rekordbox
  runtime; those remain local differential oracles. The helper build now places the required
  MPL-2.0 Symphonia source/license notice beside every universal binary.
- Hardened write boundaries after adversarial audit: input/log/artifact aliases and non-file
  targets fail before decode, semantic rebuilds reject in-place output and never write a non-exact
  candidate, temporary files are unique and synced, PQT2 uses the observed first/last beat anchors,
  and a 12-second synthetic D-major/120-BPM fixture gates deterministic full DAT/EXT/2EX output. A
  real Crystalised FLAC EXT containing `PVB2` and its 2EX both rebuild byte-for-byte. TypeScript
  `--force` now removes only the five known analyzer artifacts, preserves unrelated output-directory
  files, and rejects any output path that aliases the source recording.
- Serialized same-process database guard commands through a per-library promise lane. A 32-way
  stale-guard acquisition plus 32-way release stress gate eliminates the prior replacement-unlink
  race while retaining the on-disk cross-process guard.
- Replayed 20 fragmented CDJ-3000 `0x1500` keyboard edits with interleaved artwork, waveform, and
  one-row renders over one TCP connection. Every render uses the full result count and succeeds
  without Back or reconnect. The physical deck independently exercised repeated incremental
  searches and result renders on the running server, confirming the patched path is working.

## Bounded analyzer parallelism checkpoint (2026-07-27)

- Added one explicit Rayon pool per clean analysis. Waveform, rhythm, and key
  branches run concurrently; rhythm and key FFT frames use deterministic
  ordered partitions without changing the original global reduction order.
  The public Rust API and raw helper accept a validated `1..=64` thread budget,
  including `REKORDBOX_ANALYZER_THREADS`.
- Thread counts 1, 2, 3, 4, 8, and 12 retained exact DAT/EXT/2EX hashes and
  summary semantics across three real recordings and one 502-second recording.
  On the 12-core test host, automatic 12-thread medians improved by 1.74–2.38x
  over the pre-parallel scalar baseline while RSS remained stable.
- Added `rekordbox analyze track(s) --threads`, `tracks analyze-existing
--threads`, and `tracks import-set --analysis-threads`. Multi-track and
  streaming workflows interpret this as a total CPU budget and divide it
  deterministically across active analyzer processes/slots. A 12-thread,
  four-track batch improved from 1.86 seconds sequential to 0.81 seconds with
  worker budgets `[3, 3, 3, 3]`, without nested oversubscription.
- Kept the release boundary clean: Rayon and its permissive transitive
  dependencies are listed in `THIRD_PARTY_LICENSES.md`; the npm package
  allowlist excludes `vendor/`; and the native build compiles only the
  clean-room crate. No reference rehost or Rekordbox/JUCE bytes are needed in a
  release.

## Clean RGB waveform checkpoint (2026-07-27)

- Re-derived `PWV4` and `PWV5` as separate DSP paths from 31-frequency
  pure-tone outputs, 0 to -60 dB ladders/ramps, and three matched-PCM
  real-track references. `PWV4` now uses linear peak/filter amplitudes plus
  the nonzero inverse luminance byte instead of peak-power and a constant
  opacity byte.
- Made `PWV5` color amplitude-invariant spectral hue: continuous Butterworth
  band filters, 294-sample band RMS divided by broadband frame RMS, and
  independent three-bit RGB quantization. Kept the already-correlated
  peak-power height path separate. Exact tone hues now match at 80 Hz
  (`7/0/0`), 500 Hz (`0/7/1`), and 4 kHz (`0/2/7`) through -60 dB.
- Science Fiction visible mean RGB improved from `3.59/2.04/0.90` to
  `6.27/1.36/1.67`, against Rekordbox `6.59/0.98/1.84`. Its PWV4 fields now
  correlate `0.968/0.999/0.993/0.824/0.755` for amplitude/bottom/red/green/blue;
  RGB detail MAE is `0.63/0.79/1.21`, while height correlation remains
  `0.993`. Crystalised and Pleasure remain held-out parity gates rather than
  bundled fixtures.

## Clean beat-grid checkpoint (2026-07-27)

- Re-derived PQT2 from 1,745 paired real entries: each two-byte payload is the
  big-endian `0..=999` microsecond remainder of its PQTZ floor-millisecond
  timestamp. The word at offset 44 is the wrapping sum of
  `beat + bpm_hundredths + time_ms` across every PQTZ entry. The full synthetic
  audio pipeline now gates both facts.
- Replaced independent onset snapping with a deterministic continuous grid,
  FFT-center correction, low-band onset/meter evidence, reduced octave
  harmonic bias, and hierarchical sub-frame tempo/phase refinement. Science
  Fiction, Crystalised, and Pleasure now have exact native beat counts and bar
  labels, 70/100 ms F1 of `1.0`, and median timing error of
  `3.088/6.196/4.032` ms. The final grid integrator uses `f64`, limiting
  precise straight-grid interval quantization to one microsecond without
  widening the `f32` spectral-analysis path.
- Added `rekordbox-analyzer beat-grid-diff`: bounded monotonic
  insertion/deletion alignment plus precise endpoint, drift, tempo, downbeat,
  and 70/100 ms match reports. Tests cover an inserted beat, allocation bounds,
  nonzero PQT2 residuals/checksum, and one-microsecond straight-grid
  continuity.
- Kept variable-tempo tracking open instead of adding a corpus-regressing
  heuristic. James Brown live/remix and Chopin heldouts demonstrate the gap;
  Lenny Kravitz also retains a syncopated phase ambiguity and Michael Jackson a
  one-beat meter rotation/endpoint miss. The distributable remains solely the
  clean Rust helper; vendored Rekordbox/JUCE code and local oracle files are not
  runtime or release dependencies.

## Variable-tempo and phase audit (2026-07-27)

- Re-derived the native tempo-run structure across nine real PQTZ grids.
  Every run is at least four beats and the median is four beats. Ants, Get Up,
  and Chopin contain `176/73/22` runs over `107.25–108.59`,
  `146.88–151.06`, and `81.90–154.24` BPM respectively; nearly every short
  run is bar-aligned.
- Evaluated windowed local autocorrelation, confidence/distance-constrained
  snapping, unsmoothed and median-smoothed barwise integration, and
  overlap-added predominant local pulse phase evidence. The designs follow
  [Ellis (2007)](https://www.ee.columbia.edu/~dpwe/pubs/Ellis07-beattrack.pdf),
  [Wu et al. (2011)](https://ismir2011.ismir.net/papers/PS2-4.pdf), and
  [Chiu et al. (2023)](https://arxiv.org/abs/2308.10355).
- Ants' strongest barwise candidate moved median error/F1 from
  `53.496 ms, 0.579/0.641` to `34.986 ms, 0.592/0.650`, but p95 regressed
  from `251.856` to `267.531` ms. Get Up moved from
  `37.344 ms, 0.683/0.725` to `27.671 ms, 0.686/0.743`, but p95 regressed
  from `184.841` to `242.8` ms. Chopin's local-period search retained
  octave/subdivision ambiguity with `21.245/73.385` BPM median/p95 error.
- Rejected a track-specific Lenny phase shift. Its clean `35.4`-frame onset
  phase scores `0.685`; the native `50.861`-frame phase scores `0.312`, and
  integrated one-/three-/five-second pulse evidence selects `34.15` frames.
- Shipped no analyzer change: no candidate improved both variable-tempo
  targets while preserving timing tails plus Science Fiction, Crystalised,
  Pleasure from the Bass, Ana Tijoux, Michael Jackson, and Lenny Kravitz.
  Removed the diagnostic-only corpus tests and retained no private audio,
  oracle, or proprietary runtime dependency.

## Semantic beat-grid CLI surface (2026-07-27)

- Exposed the Rust `beat-grid-diff` oracle as the typed
  `compareBeatGrids()` API and `rekordbox analyze beat-grid-diff` command.
  The wrapper resolves both directories canonically, verifies the clean-room
  helper identity, applies a bounded timeout, validates the complete structured
  report, and rejects mismatched paths or malformed output.
- Added command help, public types, fake-helper failure coverage, Music CLI/MCP
  guidance, the bundled Music skill workflow, README usage, and packed-install
  smoke checks. Future parity passes can now use one discoverable structured
  command instead of invoking a hidden native helper or comparing raw ANLZ
  hashes.

## 110-track beat-grid and waveform differential (2026-07-28)

- Matched 113 local recordings to 115 Rekordbox 6.8.2 reference directories
  and completed read-only differentials on 110 valid decodes. Three malformed
  or truncated media inputs failed closed without partial output.
- Strengthened the center-tempo prior and blended 35% body-band onset evidence
  into phase scoring. The tempo change fixed all 26 observed 2:3 subharmonic
  selections while preserving all 78 formerly correct choices; body evidence
  fixed two additional half-beat phase errors. Mean F1 at 70 ms moved from
  `0.664846` to `0.752310`, and tracks at `>=0.99` moved from 59 to 79 of 110.
  Rejected a narrower low-band candidate that fixed three but regressed ten.
- Rebuilt `PWV6` as a mean reduction of encoded `PWV7` detail with
  independently gated low/mid preview calibration. Weighted low/mid/high MAE
  moved from `52.011/36.540/15.041` to `4.834/5.142/5.647`; all 110 tracks
  improved, with median correlations `0.8973/0.8128/0.9023`. On 77 independent
  tone/level/transient fixtures, 73 improved; the high path retained exact
  mean reduction to preserve the four non-regression cases.
- Kept PWV7 detail unchanged. A global calibration reduced aggregate error but
  regressed ten real tracks, confirming that the remaining gap is the
  overlapping stateful filter/envelope detector rather than a safe global
  gain. PWV3 remains at `0.99868` median correlation and `0.586` weighted MAE.
- Added native `waveform-diff`, typed `compareWaveforms()`, and
  `rekordbox analyze waveform-diff`. The bounded report decodes every supported
  waveform family into semantic components and returns counts, exact
  fractions, correlation, means, MAE, percentiles, extrema, and signed bias.
  Public docs, Music agent guidance, fake-helper tests, deterministic pipeline
  tests, and packed-install smoke contracts cover the new surface.

## Multi-band phase and metrical-tempo checkpoint (2026-07-28)

- Expanded the read-only release gate from the 110-track differential to 849
  independently sampled, decodable tracks with complete Rekordbox DAT/EXT/2EX
  references from the 16,071-track master library. The prior analyzer passed
  694/849 (`81.7%`) at 70 ms; failures separated into half-beat phase,
  metrical-tempo, and variable-grid classes.
- Added kick (`108–258 Hz`), cumulative bass (`<=258 Hz`), and mid-band
  (`710–1,378 Hz`) onset envelopes to the existing STFT pass. A phase can move
  to the opposite basin only when whole-track gain, at least eight 16-beat
  windows, and independently optimized bass evidence agree. A second mid-band
  gate requires both mean and squared-energy gains while rejecting candidates
  contradicted by kick evidence.
- Added a second autocorrelation tempo prior and retained it only for validated
  metrical lag-ratio families near `1/2`, `2/3`, `4/5`, and `4/3`. This avoids
  the three regressions produced by applying the stronger center prior
  globally while fixing the constant-grid subdivision errors.
- Production validation moved the original differential from 79/110 to 85/110
  tracks at `>=0.99` F1, with mean F1 `0.752310 → 0.803211` and mean p95 timing
  error `73.445 → 61.530 ms`. No formerly passing track regressed. On the
  independent library, the complete 64-track switch set produced 59 new
  passes, 63 improvements, and zero regressions, projecting `694 → 753/849`
  (`88.7%`) while every non-switch candidate retained the prior path.
- Kept the hot path bounded: the extra envelopes reuse the existing FFT,
  segment voting is allocation-free, and alternative tempo ranking spans only
  the existing lag range. Five real-track release runs averaged `466.68 ms`
  versus `459.51 ms` before the pass (`+1.56%`).
- Added synthetic gates for bass-supported kick consensus, off-beat-bass
  rejection, mid-band evidence with kick veto, and accepted/rejected metrical
  tempo families. Variable-tempo grids and contradictory/manual duplicate
  analyses remain explicit open cases rather than track-specific exceptions.

## Energy and time-domain phase consensus checkpoint (2026-07-28)

- Added non-flux STFT power envelopes for the kick band (`108–258 Hz`) and
  cumulative bass (`<=258 Hz`) without another transform. Opposite-phase
  selection requires at least eight 16-beat segments, 75% segment consensus,
  1.25x kick power, nondecreasing bass power, and 1.20x kick concentration
  relative to the cumulative bass gain.
- Added an independent 512-sample time-domain pass with broadband RMS,
  `250 Hz–4 kHz` mid RMS, `>4 kHz` high RMS, and peak envelopes. The selector
  accepts an opposite phase only for strongly separated broadband or mid-band
  evidence, or when broadband peaks and high-frequency energy agree. Both
  selectors evaluate the same previously selected phase; the stricter
  non-flux candidate takes precedence so overlapping evidence cannot flip a
  phase twice.
- Exact production replay moved the original differential from 85/110 to
  89/110 tracks at `>=0.99` F1, with mean F1 `0.803211 → 0.839553` and mean
  p95 timing error `61.530 → 53.546 ms`. IDs 39, 40, 74, and 108 became
  passes; none of the prior 85 passes regressed.
- A complete fresh replay of all 849 independent references moved
  `753 → 772/849` passes. Twenty tracks improved, nineteen became new passes,
  no track worsened, mean F1 reached `0.923541`, and mean p95 timing error
  reached `40.228 ms`.
- Reusing the FFT kept the non-flux path effectively free. Fifteen alternating
  five-track runs measured `349.77 ms` mean for the combined analyzer versus
  `357.46 ms` for the prior release, treated as no measurable slowdown rather
  than a claimed speedup.
- Added synthetic coverage for kick concentration and bass support,
  broadband RMS, mid-band squared energy, high-frequency/peak consensus, and
  high-frequency peak contradiction. Alternate Apathy and Conga copies retain
  half-beat-opposed Rekordbox references; those contradictory/manual analyses
  remain explicit corpus conflicts rather than track-specific exceptions.
- Audited HFC, SuperFlux, complex-domain, centroid, and power novelty
  envelopes against the 110 + 849 corpora. Two centroid consensus rules fixed
  residual IDs 17 and 109, but a frozen replay on 613 additional disjoint
  decodes selected already-correct tracks and flipped two from parity to zero
  F1. Rejected both rules and retained none of the diagnostic-only second FFT
  path.

## Barwise drift and residual consensus checkpoint (2026-07-28)

- Added one conservative `3:2` tempo escape for cases where both existing
  autocorrelation priors choose the same lag and the faster competing family
  retains at least 93% of its score. It selected only differential ID 5:
  `105.80 → 158.70 BPM`, 607/607 native beats, correct downbeat phase,
  `0.401186 → 1.0` F1, and `35.949 ms` p95 error. The gate selected no track
  in the 848 currently available held-out references.
- Added final body-band phase consensus after the existing flux, power, and
  time-domain selectors. A half-beat move requires a near-tied global grid,
  at least 15% kick gain and 60% segment support, bounded `1.5–5.0x` body
  gain, and noncontradictory mid/bass evidence. It selected only ID 17:
  `0 → 1.0` F1 with `18.264 ms` p95 error. The implementation reuses existing
  envelopes and performs no additional FFT.
- Added a guarded bar-boundary Viterbi tracker following the dynamic-programming
  structure in [Ellis (2007)](https://www.ee.columbia.edu/~dpwe/pubs/Ellis07-beattrack.pdf)
  and the barwise tempo-state model in
  [Krebs et al. (2015)](https://ismir2015.uma.es/articles/239_Paper.pdf).
  Quarter-frame offset states span `±0.48` global periods, transitions carry a
  quadratic tempo-change penalty, and selected offsets are linearly integrated
  into four-beat tempo runs. The variable grid is emitted only with at least
  `0.36` onset-emission gain, no transition above `0.75` frame, at least ten
  frames of accumulated forward drift, and no backward excursion below two
  frames.
- The tracker selected only differential ID 32. Its timing moved from
  `0.806266 → 0.999478` F1 and `113.321 → 10.182 ms` p95 error while emitting
  139 local tempo changes against the reference's 153. A full 849-track
  held-out replay selected no variable grid and preserved all prior outputs.
- Combined production replay reached 92/110 tracks at `>=0.99` F1, up from
  89/110, with mean F1 `0.839553 → 0.855844` and mean p95 error
  `53.546 → 49.187 ms`. Exactly IDs 5, 17, and 32 changed; all improved and no
  prior pass regressed. The held-out result remains 772/849.
- An additional disjoint screen completed 609 currently available recordings
  from the frozen 613-track fresh cohort. Neither new tempo path activated;
  four source recordings had moved or disappeared. The five adversarial
  controls that defeated the broader centroid rule remained byte-identical.
  Five paired ID-32 runs measured `1.404 s` mean for the tracker build versus
  `1.428 s` for the prior binary, treated as no measurable slowdown.
- Rejected a local-RMS phase rule despite two held-out fixes because it changed
  one exact held-out pass from `1 → 0` F1. Also rejected SuperFlux,
  complex-bass, and HFC combinations that failed the fresh controls. ID 12 and
  alternate Apathy/Conga copies retain contradictory half-beat annotations;
  no track-specific exception was added.

## Peak-cadence and backward-drift checkpoint (2026-07-28)

- Added a final time-domain cadence gate for residual half-beat errors. A phase
  can move only when at least eight complete 16-beat windows, bounded
  whole-track peak gain, reduced top-half peak saturation, and independent
  locally normalized low-band mean and segment votes agree. The low envelope
  reuses the existing `250 Hz` one-pole state; no transform or proprietary
  runtime was added.
- The first peak-only candidate correctly fixed both `I Never Knew` versions
  but incorrectly selected Jay Vegas' `Come Soon`, whose prior grid already
  scored `0.998588` F1. Low-band cadence voted `43–0` against that move, while
  the two valid corrections voted `28–1` and `37–1` for it. Requiring
  cross-band vote consensus retained both fixes and made `Come Soon`
  byte-identical again.
- Extended the existing barwise Viterbi selector with a symmetric
  negative-basin branch. It accepts only at least `0.24` emission gain,
  `<=2`-frame bar transitions, `>=20` frames of total drift, a
  `-10..=8`-frame basin, and at least `0.70` absolute Pearson correlation
  between bar index and selected offset. This adds only linear arithmetic over
  the already-computed state path.
- The backward branch changed only the two James Brown variable-tempo tracks.
  `I Got Ants In My Pants` moved from `0.579242 → 0.732132` F1 and
  `251.275 → 214.855 ms` p95 while emitting 140 local tempo changes against
  175 native changes. `Get Up Offa That Thing` moved from
  `0.682652 → 0.899859` F1 and `184.260 → 133.190 ms` p95 with 64 changes
  against 72 native changes.
- Combined exact replay changed only differential IDs 58, 61, 106, and 110.
  Tracks at `>=0.99` F1 moved from `92 → 94/110`; mean F1 moved from
  `0.855844 → 0.877391`, and mean p95 timing error from
  `49.187 → 44.088 ms`. Both `I Never Knew` versions reached `1.0` timing F1
  and `4.165/3.527 ms` p95. Their native grids retain a two-beat meter-label
  rotation, so downbeat numbering remains a separate open problem.
- Final selectors changed `0/848` available held-out DATs and `0/609`
  additional disjoint DATs. The three held-out paths admitted by the broader
  backward-drift superset had trend correlations of only
  `0.060/0.204/0.406` and remained byte-identical under the final gate.
  Forty alternating five-track runs measured `1.299 s` candidate versus
  `1.291 s` baseline median (`+0.60%`), with no failures.

## Residual-trend variable-grid refinement checkpoint (2026-07-28)

- Diagnosed the two remaining selected variable grids beat by beat. Both
  accumulated residual timing error against the native dynamic grid while the
  first-pass Viterbi path saturated at its `±0.48`-period state boundary. The
  existing activation predicate remains unchanged; refinement runs only after
  the already-screened coherent negative-basin gate accepts a track.
- Added one isolated second pass. A negative residual trend expands the
  zero-centered state lattice to `±0.96` period. A positive residual trend
  estimates one bounded period correction from the per-bar path slope,
  recenters a regular grid between the global and first-pass phases, and
  searches `±0.84` period. Refined timing is mapped back to the first-pass
  meter offset so the second pass cannot silently rotate beat labels.
- `I Got Ants In My Pants` moved from `0.732132 → 0.805469` F1 and
  `214.855 → 172.226 ms` p95 timing error, with `145` local tempo changes
  against `175` native changes. Its existing `0.377335` beat-label accuracy
  was preserved exactly; downbeat p95 changed by `+0.972 ms`, an explicit
  remaining meter gap rather than a hidden phase trade.
- `Get Up Offa That Thing` moved from `0.899859 → 0.926554` F1 and
  `133.190 → 96.337 ms` p95 timing error. Beat-label accuracy improved from
  `0.765537 → 0.798867`, downbeat p95 improved from
  `403.980 → 392.972 ms`, and both native and generated grids contain 354
  beats.
- Full 110-track replay changed exactly IDs 106 and 110; the other 108 DATs
  remained byte-identical. The `>=0.99` count remains `94/110`, while mean F1
  moved from `0.877391 → 0.878300` and mean p95 timing error from
  `44.088 → 43.365 ms`.
- Because refinement is strictly downstream of the unchanged selector, the
  prior `0/848` held-out and `0/609` disjoint activation proofs compose with
  this pass. Direct replays of the three closest held-out near misses and the
  fresh cadence adversary were also byte-identical. Thirty-two alternating
  four-track runs measured a `+0.10%` median runtime difference, treated as no
  measurable overhead. The release remains clean-room Rust with no Rekordbox,
  JUCE, FFmpeg, or proprietary runtime dependency.

## Pipelined SIMD analyzer checkpoint (2026-07-28)

- Replaced the long-track decode-then-analyze barrier with a bounded five-second
  pipeline. Symphonia decode publishes one shared PCM batch to independent beat,
  key, waveform, and time-domain consumers. Stateful consumers remain ordered;
  command delivery uses scoped Rayon work plus bounded channels, with no
  hot-path mutex.
- Enabled Symphonia's architecture SIMD, reused FFT plans and scratch buffers,
  fused spectral passes, added deterministic AArch64 NEON waveform filters, and
  avoided a copy/resample for already-valid 44.1 kHz mono PCM. Short,
  resampled, and one-thread inputs retain the simpler buffered path.
- A paired ten-run, eight-thread benchmark on a 491-second AAC/M4A moved from
  `720.22 ms` to `347.16 ms` median: `2.07x` faster and about `1,415x` real
  time. A final Samply profile averaged `3.48` occupied cores. The serial AAC
  decoder, about `315 ms` of process CPU in that profile, is now the critical
  path rather than the parallel DSP stages.
- Six and eight threads were effectively tied on AAC; eight won the mixed-codec
  check, while twelve regressed from topology and cache pressure. The
  single-track default is now eight. More threads cannot shorten the
  temporally dependent codec path.
- A cold 100-track, 8.55-hour corpus completed in `9.46 s` median with both 12
  and 16 one-thread processes, `9.65 s` with 20, and `9.51 s` with 24. The
  adaptive batch default remains 12, now `17.0%` faster than the prior
  `11.402 s` median without the extra memory pressure of oversubscription.
- Streamed versus buffered analysis produced 300/300 byte-identical artifacts.
  The 110-track beat-grid oracle remained at 94/110 tracks with `>=0.99` F1,
  mean F1 `0.878300`, and mean p95 `43.365 ms`. Codec SIMD versus the frozen
  scalar build changed 9/300 files only: maximum beat drift `0.174 ms` and one
  quantization level in each of two waveform values.

## Linked analyzer stage-trace checkpoint (2026-07-28)

- Added a private x86*64 callsite tracer around the local 6.8.2 reference
  rehost. Every patch verifies the original opcode, relative target, branch
  bytes, range, and page protection before installation. The trace records
  selected `BA*\*` engine, streamed frames, raw beat list, constant-grid
  adjustment input/output, final PQTZ, and semantic stage parity. It remains
  outside the distributable clean-room crate.
- Recovered four distinct beat engines: constant and variable tempo at 44.1
  and 48 kHz. `BeatAnalyzeReq` byte zero selects the family. The existing
  explicit reference workflow requests variable mode, while constant mode
  alone runs `UnitBeatAdjust`.
- A linked Science Fiction run selected 48 kHz variable mode and returned 839
  raw beats. All 839 sample-frame positions, meter labels, and BPM-hundredths
  matched final PQTZ after exact integer floor-millisecond conversion. This
  pins tempo-family, local timing, and meter decisions inside the proprietary
  `peakss::BeatInfoAnalyzer`, not the outer ANLZ writer.
- Forcing the same input through constant mode exposed the isolated
  postprocessor: `126.99882 → 126.99982 BPM`, `839 → 840` beats, one prepended
  boundary beat, and a global `+376`-frame (`7.83 ms`) phase shift.
  `UnitBeatAdjust` downsamples stereo by four, averages int16 channels, applies
  2 kHz high-pass then absolute value then 1 kHz low-pass, searches a
  `±50 ms` aggregate pulse basin, and refines a regular 70–180 BPM grid.

## Linked three-band waveform parity checkpoint (2026-07-28)

- Recovered the complete 6.8.2 PWV6/PWV7 path from the linked implementation.
  Source-rate mono feeds Butterworth biquads at `LP300`,
  `HP250 → LP1200`, and `HP3000 → LP9000`; each band is max-pooled into exact
  1 ms buckets and truncated to signed-16 amplitude.
- PWV6 uses 1,200 track-relative windows with different overlaps
  (`duration/1000`, `2*duration/3000`, and `duration/3000`), balances total
  band energy, then applies one shared peak constraint. The resulting
  low/mid/high gains are serialized in PWVC. PWV7 reconstructs finite peak
  histories of `300/200/100 ms` with `0.99/0.98/0.97` decay; low and mid are
  linear while high uses `64 * (1 - cos(pi*x/32768))`.
- Ported the verified path to clean Rust, preserving the decoded source sample
  rate before the rhythm/key 44.1 kHz resample. On Science Fiction, PWVC now
  matches exactly at `[80, 172, 147]`. PWV7 correlation is
  `0.999989/0.999978/0.999944`, MAE is
  `0.0144/0.0178/0.0220`, and `97.94–98.57%` of band bytes are exact. PWV6
  MAE is `0.0042/0.0092/0.1092`.
- A fresh 110-track read-only replay improved every PWV6 and PWV7 result
  against the frozen baseline, with zero regressions. Median PWV7 correlation
  is `0.999991/0.999977/0.999809`; median MAE is
  `0.0123/0.0169/0.0474`. The two material detail outliers are an explicitly
  mismatched reference/audio identity and one M4A with a seven-column decoder
  duration difference. No proprietary code or oracle asset enters release
  output.

## Linked variable-tempo decoder checkpoint (2026-07-28)

- Extended the private x86_64 reference tracer through
  `peakss::BeatInfoAnalyzer::analyze`, `segAdjust`, and both `gapCorrect`
  overloads. Schema v2 records the detector candidates both before and after
  native pruning, the tempo-section vector on both sides of phase adjustment,
  every boundary repair, and the final raw beat list. The outer writer still
  performs no rhythm decisions.
- Recovered the front-end topology used by the linked analyzer. Six synchronous
  paths use a `283 Hz` low-pass, `150 Hz` wide band-pass (`Q=1.5`), a
  `283–7,900 Hz` band-pass, a `7,900 Hz` high-pass, and two through paths.
  Peak histories propose interval/phase candidates; simultaneous candidates
  are voted first at integer BPM and then at `0.1 BPM` resolution.
- The native state decoder treats intervals as compatible when their direct,
  half-time, or double-time distance is within `min(4%, 20 ms)`. It retains
  independent tempo families, removes values without at least eight
  consecutive observations, creates one section per surviving family, and
  runs a separate phase search over each section. This is categorically
  different from the clean analyzer's current one-global-period tracker.
- Four linked traces isolate the failure modes. `Luv Techniques` reduced
  `12,085 → 1,422` detector candidates and produced one `125 BPM` section.
  `The Power (dub)` reduced `1,393 → 473` candidates and preserved a
  `145.50 → 108.40 BPM` transition; boundary repair moved only two beats.
  `Rafael – ID` reduced `968 → 182` candidates and preserved
  `117.05 → 108.80 → 165.81 BPM`; boundary repair removed two beats and
  rewrote the transition. `Get Up Offa That Thing` reduced
  `3,700 → 332` candidates and emitted one section whose four-beat intervals
  continue to track the live drummer.
- The linked return BPM is the dominant/longest section, not necessarily the
  first or arithmetic mean. Section phase adjustment searches nearby detected
  peaks with a tolerance no smaller than one-eighth of the candidate interval,
  scores multiple pulse spacings, then stores a section origin, pulse count,
  and subdivision. Gap correction is a separate, narrow boundary operation;
  it is not server-side recovery or a general post-hoc grid repair.
- Remaining clean-room work is now sharply bounded: reproduce the six-path
  peak candidate stream, port the two-stage tempo histogram plus minimum-run
  state decoder, synthesize each retained section independently, and port the
  observed boundary rules. The existing barwise Viterbi path remains useful
  inside one tempo family but cannot solve missing `3:2`, `4:3`, or unrelated
  section families by construction.

## Linked BeatSensor front-end checkpoint (2026-07-28)

- Extended the private reference tracer to the real
  `peakss::BeatSensor::create` callsite. Schema v3 snapshots its object, all six
  filter and peak-detector records, and every nested IIR stage immediately
  after construction. Four linked runs at 44.1 and 48 kHz completed without a
  trace warning; repeated tracks at one sample rate differed only in pointers
  and track length.
- The runtime call is exactly
  `create(sampleRate, 0, totalFrames, 8, 6)`. Each path is averaged over eight
  input samples. The independent paths are two identical `LP283` biquads, two
  identical `BP150/bandwidth=1.5` biquads, alternating `HP283/LP7900` biquads, and two
  identical `HP7900` biquads. Coefficients are double precision and now
  captured bit for bit for both native sample rates.
- The apparent fifth and sixth through-filter paths are not raw full-band
  detectors. After filtering and absolute value, path 4 copies the `LP283`
  envelope, subtracts a `max(2, round(sampleRate * 0.001))` moving average, and
  clamps at zero. Path 5 does the same to the `HP7900` envelope with
  `max(2, round(sampleRate * 0.0002))`. Their observed history lengths are
  `44/48` and `9/10` samples at 44.1/48 kHz.
- Every path uses the same `0.29 s`, `1.70 s`, and approximately `1.30 s`
  peak-detector windows. Construction stores exact scalar state
  `0.001/0.75/0.5/0.5`; sample-index state remains 64-bit. This front end is
  causal time-domain DSP, not the clean analyzer's current STFT spectral-flux
  onset curve. In particular, the two derived envelope-onset paths explain why
  a generic local tempogram failed to recover the linked `145 → 108 BPM` and
  `117 → 109 → 166 BPM` sections.
- Public Pioneer tempo-detection material independently describes voting
  periodic peaks across frequency components, but the linked runtime trace is
  the implementation oracle. Next porting unit: reproduce the six scalar
  streams and peak events, compare their emitted candidate records against
  schema-v2 survivor traces, then connect the already recovered section
  decoder.

## Linked peak voting and BeatListSignal checkpoint (2026-07-28)

- Extended the private tracer to schema v5 by replacing the real
  `BeatListSignal::changeStat` virtual-table slot. Each callback now records
  its chosen period, detector path, support, generation boundary, vector
  counts, and exact `PeakBuffer` ring history. A complete linked
  `Science Fiction` run captured 2,148 callbacks and 17,287 pre-pruning
  `BeatInfo` records without warnings.
- Ported the six causal filter paths, adaptive peak detector, 32-entry
  `PeakBuffer`, tempo-family selector, and `BeatListSignal` expansion as
  clean-room Rust. On the native 48 kHz MP3, the Rust front end emits all
  3,919 linked peak events with identical per-band counts; 3,889 positions are
  frame exact. It reproduces 2,114/2,148 selected callbacks exactly and emits
  17,249 hypotheses versus 17,287 linked, with 16,964 exact
  position/period/band matches. The first callback divergence is a high-band
  local-maximum tie at frame 567,320 versus 567,448; the linked and Symphonia
  decoded PCM differ slightly before filtering.
- `selectBand` is a cumulative 256-bin period histogram. It bins
  `round(60000 / periodMs)`, adds
  `max(1, trunc(4 / (errorMs + 1.0)))`, requires three votes, and retains
  direct/double/half-period families. The pending candidate with the smallest
  error supplies the family prior; incompatible pending paths are cleared
  before callbacks.
- Each callback backfills `support + 2` recent peaks, quantizes each interval
  to quarter periods, and inserts a 24-byte semantic record in peak-position
  order. The low byte of a 256-aligned generation counter controls replacement.
  Nearby period variants intentionally coexist; exact 0.1-BPM metrical matches
  and conflicting families take the replacement branch. Replaying all schema-v5
  callbacks through this recovered expansion reproduces all 17,287 linked
  records exactly, including order and every semantic field.
- This path remains diagnostic and is not yet substituted into the production
  beat-grid writer. Remaining work: isolate the linked MP3 decode/resample
  boundary for the 30 near-tie maxima, close the few `PeakBuffer` endpoint
  decisions, then feed the now-compatible pre-pruning vector into the recovered
  `BeatInfoAnalyzer` section decoder.

## Linked BeatInfoAnalyzer pruning checkpoint (2026-07-28)

- Extended the private reference tracer to schema v6 with exact snapshots after
  the native continuous-region, minimum-run, tempo-family, and near-value
  stages. Debug output is redirected to a temporary stream and never enters the
  generated files. `Science Fiction` changes
  `17,287 → 17,264 → 17,264 → 17,264 → 1,395`; the large collapse is therefore
  the near-value stage, not tempo-family rejection.
- Repeated the staged trace on four structurally different references.
  `Luv Techniques` reaches `12,041 → 1,422`; `The Power (dub)`
  `1,336 → 473`; `Rafael – ID` `907 → 182`; and
  `Get Up Offa That Thing` `3,666 → 332`. The minimum-eight stage removes
  `0/8/8/27` records respectively, while tempo-family rejection removes no
  additional records on this five-track corpus.
- Recovered the near-value algorithm exactly. For each tempo section, it uses a
  strict one-eighth-beat source-frame window:
  `trunc(float(sampleRate) * periodMs * 0.000125)`. Nearby hypotheses compete
  by the low byte of their generation, which is the originating
  `BeatListSignal` callback's `support + 2`; larger support replaces the current
  hypothesis and ties retain the earlier one. The window recenters when a later
  hypothesis wins.
- Added the linear clean-room `suppress_nearby_hypotheses` primitive. Replaying
  the linked pre-stage hypotheses and tempo sections reproduces every surviving
  24-byte semantic record in exact order on all five traces:
  `1,395/1,395`, `1,422/1,422`, `473/473`, `182/182`, and `332/332`.
  Remaining section-decoder work is the preceding section-anchor/period builder
  plus the already isolated phase and boundary adjustment stages.

## Linked provisional tempo-section checkpoint (2026-07-28)

- Extended the private reference tracer to schema v7 with snapshots of the
  analyzer-local tempo-section vector before and after fine refinement. The
  five-track corpus produces `1/1/2/4/1` provisional sections and
  `1/1/2/3/1` refined sections; the fourth Rafael section is deliberately
  merged during refinement.
- Recovered provisional construction exactly. Every source hypothesis starts
  an inclusive eight-second forward histogram, contributes one vote to its
  rounded integer-BPM bin, and lower BPM wins count ties. Direct, double, or
  half-time windows remain continuous within `min(4%, 20 ms)` of the preceding
  window's winner.
- A family change has a non-obvious split source: anchor position, period
  ratio, generation, and detector band come from the first metrical-family
  match, while period comes from the first exact integer-BPM-bin match. This
  explains the previously anomalous Power and Get Up records.
- Ported the builder as a linear sliding histogram. Replaying the native
  hypothesis vectors reproduces every provisional section field on Science
  Fiction, Luv Techniques, The Power (dub), Rafael, and Get Up Offa That Thing.
  Remaining decoder work is fine `0.1 BPM` refinement/merge, per-section phase
  synthesis, and the narrow boundary repairs.

## Linked fine tempo-section checkpoint (2026-07-28)

- Extended the private tracer to schema v8 with the real coarse/fine histogram
  winner, vote counts, source span, and repeated refinement passes for every
  section. Five traces completed without warnings.
- Each provisional span votes once per hypothesis into a 400-bin integer-BPM
  histogram. Its winner constrains a 4,000-bin `0.1 BPM` histogram to
  `[coarse - 1, coarse + 1) BPM`; strict-greater scans retain the lower bin on
  ties. The refined period is exactly `float(600000.0 / tenthBpm)`.
- Adjacent refined sections use the same direct/double/half compatibility and
  `min(4%, 20 ms)` tolerance. A match removes the later section, then re-runs
  the preceding section over its enlarged source span. Rafael therefore runs
  five refinement passes for four provisional sections: `163.1` and `164.9`
  merge, then the combined span is recomputed to `164.9 BPM` with 52 votes.
- Ported refinement and iterative merge/recompute as clean Rust. Dynamic
  winners are exactly `127.0`, `125.0`, `145.5 → 108.4`,
  `116.6 → 108.6 → 163.1 → 164.9 → 164.9`, and `149.9 BPM` across the corpus.
  Remaining section-decoder work is per-section pulse/phase synthesis,
  downbeat numbering, and boundary repair.

## Linked pulse/phase synthesis checkpoint (2026-07-28)

- Extended the private tracer to schema v10 by wrapping all six native
  `BeatInfoAnalyzer::findNearPos` callsites. The trace records one bounded
  summary per search block rather than hundreds of thousands of individual
  calls, including exact section bounds, candidate period, tolerance, trial
  count, and strict-greatest winning trial.
- Recovered section bounds exactly. A transition finds the last surviving
  hypothesis at or before the next refined anchor, then uses the preceding
  hypothesis plus `trunc(candidatePeriodFrames / 8)`. The result is clamped
  between the adjacent refined anchors. The first section starts at frame zero
  and the last ends at the native total-frame count.
- Each section tests period corrections in `0, +1, -1, +2, -2 ms` order.
  Every candidate sweeps four-, two-, and one-beat pulse spacings across one
  complete pulse interval in fixed 96-source-frame phase steps. Predictions
  recursively continue from the nearest snapped survivor. The nearest search
  retains the earlier position on equal distance and contributes
  `tolerance - absoluteError` per hit, where tolerance is
  `max(sampleRate / 20, trunc(periodFrames / 8))`.
- Pulse scores are compared as `fourBeatRaw * 4`, `twoBeatRaw * 2`, and
  `oneBeatRaw`; all comparisons are strict, preserving the earlier phase,
  wider pulse, and period correction on ties. A candidate exits early once
  its normalized score exceeds
  `tolerance * ((upper - lower) / 2) / periodFrames`. The stored origin is the
  first snapped peak with whole periods removed relative to the section lower
  bound; that quotient is the native `unknown10` field.
- Ported the full search as clean Rust `adjust_tempo_section_phases`. A
  182-survivor Rafael fixture reproduces all three linked descriptors exactly:
  `6677 / 512.5798 / 16 / 128`,
  `3717967 / 551.4862 / 16 / 16`, and
  `13171054 / 361.85687 / 8 / 79`. The final section is the important close
  case: its normalized two-beat score beats the four-beat candidate by only
  716 points.
- Static follow-through confirms no hidden mutation between fine refinement
  and this stage. After phase synthesis, the linked analyzer constructs a
  constant six-band millisecond correction table
  `[-30, -20, -3, -3, -20, -3]`; later beat expansion applies it by detector
  band. Remaining decoder work is expanded beat emission/downbeat numbering,
  those per-band corrections, and the narrow inter-section gap repair.

## Linked rolling-grid and gap-repair checkpoint (2026-07-28)

- Extended the private tracer to schema v11 by wrapping all nine grid-expansion
  `findNearPos` callsites. Rafael records 859 bounded probes: three initial
  section anchors, 531 per-beat observations, and 325 pulse snaps. The added
  trace is development-only and contains no Rekordbox code or runtime asset.
- Recovered the native production fit as `16 history + 4 stride + 12 future =
32 beats`, represented by 129 quarter-beat scratch slots. Predictions advance
  recursively from pulse snaps. Fit endpoints apply the exact six-band
  `[-30, -20, -3, -3, -20, -3] ms` offsets; an unsnapped endpoint uses the
  maximum table value, `-3 ms`.
- The first local period is `(correctedRight - correctedAnchor) / 32`. Every
  later fit advances four beats and uses an already-truncated emitted left
  endpoint. Its interval metadata takes effect after 16 history beats plus the
  four-beat stride. Four-beat chunk boundaries deliberately restart from an
  integer source-frame position; the final 12-beat tail does not. These
  quantization details explain the prior one-frame drift.
- Ported the complete expansion as clean Rust `expand_tempo_sections`,
  including the native overlap sentinel before each section, detector-band
  provenance, section flags, and local `f32` periods. The 182-survivor Rafael
  fixture matches all 1,079 pre-repair records exactly; a semantic FNV digest
  covers every position, period bit pattern, band, and anchor flag.
- Ported the generic four-record `gapCorrect` state machine. Its `0.9/1.1`
  outer-gap tests can snap a boundary, split a span into thirds or quarters,
  insert copied metadata, or remove one duplicate. Rafael reproduces both
  native transition repairs exactly, reducing `1,079 → 1,077`.
- The linked downbeat stage is not a musical classifier. It binary-searches the
  last emitted beat at or before the first selected phase anchor, then numbers
  the complete grid modulo `max(configuredStride, 4)` so that anchor is beat
  one. Numbering occurs before the inclusive `[0, totalFrames]` trim. Clean
  `finalize_expanded_beats` reproduces all 1,077 Rafael positions, local tempo
  bits, detector bands, section flags, and beat labels exactly.
- Remaining integration work: feed the clean BeatSensor survivor stream through
  the recovered decoder in the production rhythm path, replay the complete
  five-track linked corpus, and resolve the few PCM-dependent BeatSensor
  endpoint ties before selecting it as the default grid.

## Linked hypothesis-run pruning checkpoint (2026-07-28)

- Recovered the two missing source-vector pruning passes from first principles.
  The continuous pass first constructs a sparse period timeline indexed by
  `generation >> 8`. A previously empty generation is backfilled only when its
  period matches the next populated generation directly, at half time, or at
  double time within the strict `min(4%, 20 ms)` reference window.
- Empty generations are erased as complete generations. One- and
  two-generation islands are always erased; three- through eight-generation
  islands are erased when the following generation reconnects to the preceding
  retained family. The clean implementation preserves the native rewind after
  erasure and its asymmetric `f32` comparisons.
- The second pass operates on source-position order. Runs of at most eight
  records are removed. Runs of nine through 32 records are also removed when
  the next record reconnects to the preceding family; a 33-record run is kept.
  This exactly explains Power's two four-record removals, Rafael's leading
  eight-record removal, and Get Up's 27-record bridge removal.
- Ported both state machines as `prune_discontinuous_hypotheses` and
  `prune_short_hypothesis_runs`. A separate Rust replay matches every semantic
  record after both stages on all five traces:
  Science `17,287 → 17,264 → 17,264`,
  Luv `12,085 → 12,041 → 12,041`,
  Power `1,393 → 1,344 → 1,336`,
  Rafael `968 → 915 → 907`, and
  Get Up `3,700 → 3,693 → 3,666`.
- Corrected the earlier interpretation of the nominal `tempoFamily` trace
  boundary. Variable-tempo analysis builds an analyzer-local section-candidate
  vector and jumps directly to section refinement; it bypasses the
  constant-tempo dominant-family source-vector filter. The identical
  minimum/tempo source snapshots are therefore control-flow invariants, not a
  five-track coincidence.
- Remaining integration work is PCM-dependent rather than decoder-dependent:
  close the small BeatSensor endpoint/tie differences, then route its exact
  survivor stream through these passes and the already recovered
  section/phase/grid pipeline.

## Production Dynamic rhythm checkpoint (2026-07-28)

- Connected the clean source-rate mono `BeatSensor` to the complete recovered
  variable-tempo decoder in the production analyzer. The ordered path is
  causal peak detection, continuity/run pruning, provisional and refined tempo
  sections, near-value suppression, pulse/phase selection, rolling expansion,
  gap repair, numbering, and track trim.
- Corrected three trace-derived edge cases. `selectBand` uses
  `4 / (errorMs + 1.0)`, not the earlier `+0.5` interpretation. A terminal
  tempo section with fewer than 32 beats uses its available span rounded up to
  the native loop's whole-beat endpoint. Phase expansion also continues when
  near-value suppression removed the original section anchor; the native
  implementation does not require that anchor to survive.
- The six difficult fixtures now produce usable Dynamic grids without failure.
  Rafael, I Got Ants In My Pants, and Get Up Offa That Thing match the
  reference beat timestamps exactly. Luv Techniques and Science Fiction have
  F1 `1.0`; The Power (dub) has F1 `0.995885`.
- A fresh 110-track Dynamic replay has zero analyzer failures, 110/110 tracks
  at F1 `>=0.99`, mean F1 `0.999828616`, and mean p95 timing error
  `1.620 ms`. The previous static tracker reached 94/110, mean F1
  `0.878300174`, and mean p95 `43.365 ms`.
- A separate 849-track held-out replay exposed an analysis-mode boundary, not
  one interchangeable quality ladder. All 14 references containing local
  tempo changes pass under Dynamic, including an exact recovery where Normal
  has F1 `0`. The other 835 references are static Normal grids; Normal passes
  759 while forced Dynamic passes 606. Corpus comparisons must therefore use
  the same Rekordbox analysis mode.
- Renamed the public policy to `normal`, `dynamic`, and `auto`. Normal remains
  the low-level default. Auto is a clean convenience policy: ignore isolated
  local-BPM outliers and choose Dynamic only when the p05-p95 tempo span is at
  least `0.75%` of the median. Requested and selected modes are emitted in
  `analysis.json`, included in cache identity, and persisted by Tracks
  workflows. The one-shot `tracks import-set` and `analyze-existing` workflows
  default to Auto.
- Binary control-flow tracing localized the remaining Dynamic downbeat-label
  rotation to `UnitEnvelopeMaker::analyze`. Variable mode always skips
  `UnitBeatAdjust`; the latter is a separate constant-grid finishing path.
  This isolated the finishing stage for the clean-room recovery below.

## Reference rhythm selector checkpoint (2026-07-28)

- Binary Ninja inspection mapped the first `BeatAnalyzeReq` byte copied to
  `CBeatAnalyzeThread+0x1b8` to Rekordbox's constant/variable rhythm selector.
  The rehost had hard-coded that request byte to one, so every freshly
  generated reference fixture was Dynamic regardless of the wrapper option.
- The local reference helper now maps explicit `normal` to zero and `dynamic`
  to one, emits the requested/selected mode, and rejects `auto`. Auto remains a
  clean convenience policy rather than a claimed Rekordbox 6.8.2 mode.
- A live same-file check produced the expected distinct stock grids: Science
  Fiction Normal has 840 fixed-`127.00 BPM` beats, while Dynamic has 839 beats
  spanning `126.91–127.05 BPM`. New parity runs can therefore control both
  engines directly instead of comparing clean Dynamic against stored Normal
  library artifacts.

## Native FLAC PVB2 checkpoint (2026-07-28)

- Re-derived the FLAC frame chain from RFC 9639: metadata boundaries,
  STREAMINFO properties, fixed/variable coded numbers, block-size/sample-rate
  forms, UTF-8-style frame numbers, and header CRC-8 are validated without an
  external decoder or `ffprobe`.
- The clean analyzer emits Rekordbox's canonical 8,032-byte `PVB2`: 32-byte
  header plus 400 20-byte entries containing the floor-selected frame sample,
  byte offset relative to the first audio frame, and frame block size.
- Three independent real FLACs—The Power (dub), I Got Ants In My Pants, and
  Get Up Offa That Thing—match every stock Rekordbox 6.8.2 `PVB2` byte. The
  production EXT assembly now includes that exact table for validated FLAC
  streams and safely omits it when the frame chain cannot be proven.
- Samply localized the initial 119 MiB FLAC scan at roughly 400 ms CPU. An
  eight-byte slicing CRC-16 table reduced the same exact scan to 114 ms CPU,
  pinned against the FLAC `123456789 → 0xfee8` check and the scalar algorithm
  over every prefix of an 8,193-byte fixture. Seek-table construction now
  overlaps decode in the existing bounded Rayon pool. Four-worker wall time on
  The Power fell from 1.58 to 1.19 seconds in Normal and from 1.86 to 1.48
  seconds in Dynamic; DAT/EXT/2EX remained byte-identical.

## UnitEnvelope finishing checkpoint (2026-07-28)

- Recovered the Dynamic finishing path without linking the Rekordbox runtime:
  low-frequency filter/envelope extraction, mean-thresholded peak retention,
  four-way weighted phase scoring, first-grid numbering branch, complete-grid
  modulo-four numbering, and the native one-beat boundary repair.
- Recovered the all-nonpositive score branch directly from control flow. It
  maps the first retained strong peak to the nearest grid entry modulo four;
  this is not a corpus-specific phase correction. Five zero-score fixtures now
  reproduce their native rotations exactly.
- A fresh 110-track Dynamic replay completed without analyzer failures. All
  110 tracks reached F1 `>=0.99`, mean F1 was `0.999866028`, and mean p95
  timing error was `1.269 ms`. Exact beat numbering improved from 24/110
  before UnitEnvelope to 107/110. This checkpoint preceded the DASH AAC
  priming and format-derived reader-length closure recorded above.
- Life Is Hard localized the remaining rotation to presentation input rather
  than scoring. The later positive edit-list plus Core Audio AAC-delay
  recovery fixed it without a track-specific phase fallback.
- Auto now overlaps independent Normal and Dynamic candidates with
  `rayon::join` inside the same bounded thread pool. Source-rate three-band
  extraction also overlaps the independent 44.1 kHz resample. On Science
  Fiction the steady-state Auto median fell from 1.019 to 0.849 seconds, a
  16.7% wall-time reduction, with byte-identical DAT/EXT/2EX output and
  unchanged selection.

## Noncanonical-rate rhythm input checkpoint (2026-07-28)

- Native tracing shows that 44.1 and 48 kHz input pass through unchanged.
  Other sources select 48 kHz when their rate is divisible by 8 kHz and
  otherwise 44.1 kHz before entering `BeatSensor`.
- The Power (dub) is a 96 kHz FLAC. Rekordbox analyzes 15,598,860 frames at
  48 kHz. Linear decimation and generic platform resamplers moved its
  variable-tempo transition in the wrong direction and were rejected.
- Clean-room disassembly identifies a Kaiser-windowed polyphase converter with
  29 taps per phase for 96→48 kHz, cutoff `0.47`, beta `10`, and a 28-frame
  zero prefix. The clean converter also reproduces native rate-family
  selection, accumulation order, and i16 boundary quantization. At the
  converter boundary, both stereo channels match all 15,598,860 native Power
  frames bit-for-bit before and after i16 quantization. Production still mixes
  decoded channels before conversion.
- Production Dynamic now applies this path only to non-44.1/48 kHz sources.
  Power moves from 607 to 608 clean beats: all 608 align, F1 is `1.0`, first
  beat/downbeat/labels are exact, and p95 timing error is `0.375 ms`. The full
  110-track replay has no regressions and improves mean p95 from `1.620` to
  `1.269 ms`. The later format-derived reader-length pass improves it again to
  `0.834 ms` and restores seven additional FLAC endpoints.

## Native PWAV/PWV2 preview checkpoint (2026-07-29)

- Extended the private differential tracer to cover `LoudView::analyzePeak`,
  all five normal/dot peak-detector callsites, raw batch state, and final
  preview arrays. The tracer remains a local oracle only; no Rekordbox/JUCE
  code or runtime asset enters the clean crate or release.
- Recovered the 75 Hz preview pipeline: one held terminal sample, native
  signed-16 channel rounding and exact stereo half-sum, low-band double
  150 Hz/Q0.9 band-pass, shared 7.9 kHz fourth-order TPT Linkwitz-Riley
  crossover, double 283 Hz high-pass on the mid branch, three persistent peak
  detectors, low-triggered raw batches, 400-column mapping, and the fixed
  height/color tables. The legacy 100-column dots use the paired 900 detector
  and native minimum level two.
- Corrected two non-obvious state bugs. A delayed raw batch that remained
  inside its current output column was being multiplied by the track
  normalization twice. The color input also incorrectly selected a dominant
  channel for nearly equal magnitudes; the native reader instead rounds each
  channel to signed 16-bit and preserves the exact half-LSB stereo average.
  On a traced AAC recording, 999/1,000 frame maxima and all 97 captured
  high-band event frames now match the native implementation.
- The 162-fixture tone/ramp/phase/stereo corpus now has exact `PWV2` on
  162/162 fixtures. Complete `PWAV` is byte-exact on 151/162; aggregate height
  and color exactness are `99.2701%` and `99.9877%`. The remaining 11 are
  height-only amplitude-ramp/sweep threshold probes.
- A fresh read-only 110-track replay gives aggregate `PWV2` exactness
  `99.9909%`. Excluding one known source/reference mismatch and the three
  known decoder-length outliers, `PWAV` height/color exactness is
  `99.9033%/99.8868%`, with MAE `0.00325/0.00229` levels. Science Fiction is
  byte-exact in both preview tags; Tiga is exact in `PWV2` and differs in only
  two one-level `PWAV` height entries.
- Removed the redundant generic per-frame feature accumulator from streaming
  waveform generation. The native monochrome accumulator already supplies
  the exact detail count, eliminating one full extra scan and its unbounded
  feature vector.

## Dynamic transition residual checkpoint (2026-07-29)

- Captured fresh schema-15 native stage traces for Conga and Chopin, then
  re-derived the residual transition path from the Rekordbox 6.8.2
  `BeatInfoAnalyzer::analyze` control flow. Chopin's clean and native streams
  are identical through near-value suppression, section refinement, and phase
  adjustment; its first difference was the initial short-section grid fit.
- The native expansion loop is unrolled by four quarter-steps and tests the
  section boundary only after the complete beat. Its first out-of-section
  whole-beat endpoint, rather than the last in-range quarter-step, supplies
  both the fit span and corrected right position. The clean loop now preserves
  that endpoint. Chopin moves from 691 to the exact 692 beats, with exact
  labels and tempo changes, zero p95 error, and only `0.068 ms` maximum error
  across three truncation-sensitive transition entries.
- Conga's clean MP3 front end produces two extra near-transition survivors
  (`1,468` versus native `1,466`) after two native-only BeatList callbacks
  shift the generation timeline. Both extra survivors sit inside the
  one-eighth-beat exclusion zone immediately before the next section anchor.
  Section-bound construction now enforces that upstream survivor-spacing
  invariant before applying the native one-eighth-beat offset. This is a
  general transition guard, not a fitted track correction. All four clean
  Conga phase descriptors then match native exactly; the result is the exact
  867-beat count, F1 `1.0`, exact labels, and `0.862 ms` p95 error.
- A fresh frozen 110-track Dynamic replay changed nine tracks and regressed
  none. Eight missing terminal beats and Conga's extra transition beat were
  corrected. Exact beat counts improve from `100/110` to `109/110`, exact
  numbering from `108/110` to `110/110`, mean F1 from `0.999866028` to
  `0.999985758`, and mean p95 error from `0.833718` to `0.677055 ms`.
  All 110 remain at F1 `>= 0.99`; 109 are F1 `1.0`. The sole count residual is
  the existing Funkytown source/reference mismatch.

## Mood-2/3 native phrase-judge checkpoint (2026-07-29)

- Recovered and ported the complete `VerseHookJudge23` path: seed cleanup,
  overlapping 22-bar windows, all three feature-family sub-judges, candidate
  scoring, protected-bar rules, adjacent suppression, and beat remapping.
  Clean replay matches two mood-2 captures at `25/25` boundaries each and one
  mood-3 capture at `20/20`.
- Traced every `VerseHookAdd_genre23` helper. The clean
  `SouonChangeDet` port exactly reproduces the captured mood-2 bars
  `[2, 225, 226]` and the empty mood-3 result. The final
  `CandidatesAdjustment` port exactly expands the two judge outputs from
  `25→31` and `20→22` boundaries.
- Added schema-20 internal probes for `findpeaks_ex` and the vocal candidate
  sort. Clean ports of `ShortBreakDetection`, `SnareFillinDet`, and
  `VocalInDetection` now reproduce every stage across eight native mood-2
  traces. Positive short-break references produce bars 138 and 54; all
  negative cases remain empty. The snare implementation preserves the native
  overwritten-lower-quantile scratch quirk.
- `add_native_mood_23_genre_candidates` composes all detector stages and the
  final adjustment. Full Rust replay matches all eight final native beat
  lists exactly. Production routing is now gated on dynamic-grid
  feature-window parity and upstream seed construction.

## Native phrase window and intro/end checkpoint (2026-07-29)

- Added schema-21 phrase-only probes for `BeatsSamplesCalcFX` and
  `IntroEndJudge_main`. The first probe records all three stream lengths/rates,
  the internal constant BPM/first-beat pair, and every generated one-based
  boundary. The second records four feature inputs, two integer arrays, the
  selected beat, and the success flag before and after the native call.
- Corrected the recovered mixed-register ABI and the two scalar tail
  arguments. Fresh Mapoch, Fire, and Uncle John's Band runs complete with no
  warnings; DAT, EXT, and 2EX remain byte-identical to their frozen schema-20
  outputs.
- Native window parameters are `120.0/375 ms`, `153.6/105 ms`, and
  `136.4/143 ms`. Fire's first PQTZ tempo is `153.59`; Uncle's is `137.02` and
  later varies through `173.65`. Phrase analysis nevertheless uses the single
  internal values above. The existing Rust boundary formula is exact; using
  the first PQTZ tempo in the diagnostic was the remaining feature drift.
- Confirmed the production seed boundary: the BPM is `BeatAnalysis.bpm`, while
  the offset is the first integer `PQTZ.time_ms`. Native does not add the
  `PQT2` microsecond residual or substitute the first beat's local BPM. The
  clean phrase frontend now follows that rule. A fresh 120-track replay
  completed without failures and retained
  `0.6182/0.6842/0.7137` exact/four/eight-beat F1; the removed residual was too
  small to change a final PSSI decision in that cohort.
- Mapoch and Fire now supply the exact native seed from their clean grids.
  Uncle remains upstream: native starts `137.02 BPM @ 143 ms`, while the clean
  Dynamic grid starts `134.77 BPM @ 411 ms`, despite matching the native
  `136.4` global phrase BPM. This is a BeatSensor/section-grid input mismatch,
  not a phrase-window recovery rule.
- `IntroEndJudge_main` transforms seed arrays `[128]`, `[0]`, and `[0]` into
  `[4]`, `[49,45,5,0]`, and `[35,35,15,7]`, selecting beats `4`, `5`, and
  `35`. This isolates the remaining production gate to the inner intro/end
  judge and the upstream constant-grid seed rather than the already exact
  mood-2/3 judge and genre stages.

## Exact waveform and Auto batch performance pass (2026-07-29)

- Reprofiled the current exactness-heavy analyzer with Samply 0.13.1 at 1 kHz.
  Waveform generation was the largest controllable block: native loud preview,
  legacy RGB, monochrome detail, and three-band accumulation. The native loud
  path now reuses frame/band storage, appends detector events directly, batches
  pending input copies, and evaluates its two independent `f64` filters in one
  AArch64 NEON pair. A scalar-vs-NEON bit-exact test covers 44,100 samples.
- One-thread Auto analysis now decodes the linked tempo candidate before
  computing the unit-envelope phase. The phase pass runs only when Dynamic is
  selected or Normal fails; multi-thread single-track analysis retains the
  original parallel schedule. The 100-track corpus still selects 97 Normal and
  three Dynamic tracks, with 300/300 DAT/EXT/2EX files byte-identical.
- On the M2 Max 100-track, 8.55-hour corpus, the pre-pass portable release was
  stable at `21.32–21.45 s` wall and `214.51–222.98 s` user CPU. The exact
  post-pass run completed in `19.99 s` and `204.07 s` user CPU: about five
  tracks/second, `1,540x` real time, and a `6.5–6.7%` reduction. Twelve
  one-thread processes remain optimal; 16/20/24 measured
  `21.70/22.79/22.89 s`.
- Re-tested Reth-style codegen variants. Thin LTO remained inside thermal
  noise; `target-cpu=native` (resolved to `apple-m2`) and fat LTO with one
  codegen unit regressed. A representative-corpus PGO build was byte-identical
  but did not produce a stable win. Samply still shows no allocator hotspot,
  so portable release codegen and the system allocator remain the defaults.
