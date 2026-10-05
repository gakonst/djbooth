# Ableton Headless Capability and Knowledge Checklist

Snapshot: 2026-08-09. This is the working definition of “all Ableton capabilities from Rust, without the Live UI.” Refresh runtime truth with:

```sh
pnpm djbooth produce ableton capabilities --format md
pnpm djbooth produce ableton audit-device-graphs --format json
pnpm djbooth produce ableton audit-engine --format json
pnpm djbooth produce ableton audit-presets --all --format json
```

## Status at a glance

- [x] Index 3,588 installed Core Library assets.
- [x] Identify 75 device families and their real headless execution mechanism.
- [x] No device family is completely blocked.
- [x] Twelve families are end-to-end complete.
- [x] Real native rendering exists for the important instrument/effect surface; no replacement DSP is used.
- [~] Sixty-three families are usable but have at least one integration gap.
- [x] Parse ADV/ADG devices, nested graphs, preset values, macro mappings, chain zones, and mixer metadata.
- [x] Import ALC MIDI/drum clips and inspect AGR grooves.
- [x] Render declarative multitrack arrangements, occupied clip regions, cached post-effect clips, stems, and a stereo master.
- [x] Run serial real-Ableton effect chains on samples and pre-rendered plugin audio.
- [x] Run supported Ableton instruments directly from MIDI notes or reusable MIDI clips.
- [x] Pass a 44.1 kHz sidechain audio file into supported native processors.
- [ ] Execute every ADG rack exactly, including arbitrary parallel chains, selectors, nested mixers, sends, and returns.
- [ ] Automate arbitrary device parameters and macros over the arrangement timeline.
- [ ] Route graph tracks directly into native sidechain inputs without an intermediate audio file.
- [ ] Run real native Ableton effects on the master bus; the current master supports gain and Max-based processing only.
- [ ] Complete every Max for Live device dependency/API/render audit.
- [ ] Demonstrate every family with an audible dry/wet or MIDI-in/audio-out fixture.
- [x] Build a queryable tutorial knowledge base covering every capability family, production role, source, and timestamped action window.
- [~] Turn broad tutorial coverage into executable, tested recipes for every musical role and device family.

Current runtime totals:

| Metric | Current |
|---|---:|
| Installed library assets | 3,588 |
| Device families | 75 |
| Compiled Ableton Max DSP objects discovered | 67 |
| Standalone native bundles | 7 |
| Complete families | 12 |
| Partial families | 63 |
| Blocked families | 0 |

Current knowledge-base totals:

| Metric | Current |
|---|---:|
| Tutorial videos | 304 |
| Tutorial duration | 99.71 hours |
| Official Ableton articles | 357 |
| Transcript-backed videos | 287 |
| Timestamped action windows | 7,225 |
| Targeted visual frames | 2,701 |
| Capability families with tutorial evidence | 49 |
| Synthesized production principles | 19 |
| Production-role playbooks | 11 |
| Current declarative recipes | 20 |

The generated encyclopedia and evidence index live in [`ableton-knowledge-base/`](ableton-knowledge-base/). Query them with `node examples/production/query-ableton-knowledge-base.mjs "<production question>"`.

“Partial” usually means the device and installed ADV presets already render through Ableton’s DSP, while exact rack composition, automation, sidechain, scheduler, or polyphonic behavior remains unfinished.

## Definition of done for each device family

Every family must pass all of these gates:

- [ ] Asset discovery: every installed ADV/ADG/AMXD is indexed and attributed to the correct family.
- [ ] State recovery: preset parameters, samples, mappings, zones, and dependencies are recovered.
- [ ] Native boot: the real Ableton processor, bundle, or compiled Max object loads without Live’s UI.
- [ ] Isolated behavior: MIDI or audio produces finite, repeatable output at supported sample rates.
- [ ] Preset fidelity: installed presets produce verified parameter and audio differentials.
- [ ] Serial use: the device works before/after other real devices in a graph track.
- [ ] Routing: sidechains, stereo topology, and relevant extra inputs/outputs work.
- [ ] Modulation: tempo sync, parameter automation, macro mapping, and modulation work.
- [ ] Rack use: nested/parallel chains, selectors, sends, returns, and mixers preserve Live semantics.
- [ ] Knowledge: at least one authoritative manual/tutorial map exists.
- [ ] Recipe: at least one tutorial-derived use is represented declaratively with provenance.
- [ ] Audition: a small dry/wet or MIDI-in/audio-out example proves the intended musical result.

## Complete families (12/75)

These currently have no recorded headless blocker:

- [x] Amp — standalone native bundle, exact presets.
- [x] Beat Repeat — native three-part composite with exact ADV mapping.
- [x] Cabinet — standalone native bundle, exact presets.
- [x] Collision — standalone native instrument with exhaustive ADV renders.
- [x] Corpus — standalone native bundle with hash-matched preset state.
- [x] Hybrid — native Hybrid Reverb processor with exhaustive ADV and rack rendering.
- [x] LoungeLizard / Electric — standalone native instrument with recovered preset permutation.
- [x] MultiSampler / Sampler — Core Library sample zones and native rack/sample importer.
- [x] OriginalSimpler / Simpler — Core Library sample zones and native rack/sample importer.
- [x] Spectrum Analyzer — transparent native analysis tap.
- [x] StringStudio / Tension — standalone native instrument with exhaustive ADV renders.
- [x] UltraAnalog / Analog — standalone native instrument with exhaustive ADV renders.

## Partial families with real native audio rendering (41/75)

Every family below already renders through Ableton’s processor and has exhaustive installed-ADV render coverage unless noted. The shared unfinished work is exact composite-rack behavior, automation, tempo changes, and/or sidechain routing.

- [~] Auto Filter
- [~] Auto Filter 2
- [~] Auto Pan
- [~] Auto Pan 2
- [~] Auto Shift
- [~] Channel EQ — compiled `abl.device.channeleq~`; exact ADV attribute mapping.
- [~] Chorus
- [~] Chorus-Ensemble
- [~] Compressor
- [~] Delay
- [~] Drum Buss
- [~] Echo
- [~] EQ Eight
- [~] Erosion
- [~] Filter Delay — all three native bands and dry branch execute; tempo automation remains.
- [~] EQ Three
- [~] Flanger
- [~] Frequency Shifter
- [~] Gate
- [~] Glue Compressor
- [~] Grain Delay
- [~] Limiter — compiled `abl.device.limiter~`; exact ADV attribute mapping.
- [~] Looper
- [~] Multiband Dynamics
- [~] Overdrive
- [~] Pedal
- [~] Phaser
- [~] Phaser-Flanger
- [~] Redux
- [~] Redux 2
- [~] Resonators
- [~] Reverb
- [~] Roar
- [~] Saturator
- [~] Shifter
- [~] Spectral processing
- [~] Utility / Stereo Gain
- [~] Transmute
- [~] Dynamic Tube
- [~] Vinyl Distortion
- [~] Vocoder

## Partial instruments (6/75)

- [~] Drift — native audio and exhaustive ADV rendering proven; full graph integration remains.
- [~] Drum Sampler / Drum Cell — native audio and exhaustive ADV rendering proven.
- [~] Impulse — processor construction and preset-port application proven; required companion/voice state remains.
- [~] Meld — native audio and exhaustive ADV rendering proven.
- [~] Wavetable / Instrument Vector — native audio and exhaustive ADV rendering proven.
- [~] Operator — native oscillator/envelope voice rendering and user wavetable graph recovery proven; global filter/LFO auxiliaries and polyphonic voice allocation remain.

## Partial MIDI devices (7/75)

- [~] Arpeggiator — construction and preset-port application proven; native scheduler/companion state remains.
- [~] Chord — native MIDI event and exhaustive ADV event rendering proven.
- [~] Note Length — native MIDI event and exhaustive ADV event rendering proven.
- [~] Pitch — native MIDI event and exhaustive ADV event rendering proven.
- [~] Random — native MIDI event and exhaustive ADV event rendering proven.
- [~] Scale — native MIDI event and exhaustive ADV event rendering proven.
- [~] Velocity — native MIDI event and exhaustive ADV event rendering proven.

The common missing piece is chaining these through nested MIDI racks and reproducing Live’s scheduler exactly.

## Partial rack and routing families (6/75)

- [~] Audio Branch Mixer
- [~] Audio Effect Rack
- [~] Drum Rack
- [~] Instrument Rack
- [~] MIDI Branch Mixer
- [~] MIDI Effect Rack

For these, exhaustive graph parsing is proven: device order, nested racks, values, macros, mappings, key/velocity/chain zones, mixers, and sends are recovered. Native execution of arbitrary parallel chains, chain selectors, nested mixers, sends, and returns is not complete.

## Partial Max for Live families (3/75)

- [~] Max audio effects — 57 library assets; embedded AMXD loading and saved-parameter replay work. Live API-only behavior is device-specific.
- [~] Max instruments — 2 library assets; AMXD loading works, but every dependency and non-UI render still needs verification.
- [~] Max MIDI effects — 141 library assets; AMXD loading works, but every dependency and non-UI render still needs verification.

The bundled Max runtime and 67 compiled Ableton `abl.*~` objects are available; this does not imply that every arbitrary Max patch is already safe or semantically complete outside Live.

## Arrangement and rendering surface

- [x] Fixed BPM, configurable meter, bars, sample rate, and render tail.
- [x] Native instrument source with arrangement notes.
- [x] Native instrument source with reusable MIDI clips and sparse placements.
- [x] Sample source with one-shot triggers, velocity scaling, loops, and sparse placements.
- [x] Compiled Ableton Max instrument-object source.
- [x] Per-track gain and pan.
- [x] Ordered native effect chains using installed ADV presets.
- [x] Max for Live and compiled Ableton Max effects after native effects.
- [x] Native effect sidechain from a rendered 44.1 kHz audio file.
- [x] Reusable cold-render cache for native clips and post-effect audio.
- [x] Full-arrangement per-track stem export.
- [x] Stereo WAV master render and peak report.
- [x] Explicit `customDsp: false` report for all-Ableton/plugin graphs.
- [ ] Timeline automation lanes for arbitrary device parameters/macros.
- [ ] Track-to-track buses, groups, sends, and return tracks.
- [ ] Direct track-to-track sidechain connections.
- [ ] Native Ableton master-device chains.
- [ ] Tempo and time-signature automation.
- [ ] Live-style groove application during graph rendering.
- [ ] Follow actions, clip envelopes, probability, chance, and per-note expression.
- [ ] Freeze/flatten/resampling operations as declarative graph nodes.

## Asset inspection and import surface

- [x] Search installed ADG, ALC, ADV, and AGR assets with compatibility metadata.
- [x] Inspect an arbitrary Ableton asset and its dependencies.
- [x] Inspect complete ADV/ADG device graphs.
- [x] Inspect Simpler/Sampler layers, sample zones, loops, and envelopes.
- [x] Inspect Drum Racks and resolve Core Library samples.
- [x] Inspect ALC tempo, loop bounds, and MIDI notes.
- [x] Inspect AGR timing, velocity, and grid data.
- [x] Import drum ALC + ADG into renderable song JSON.
- [x] Import tonal ALC through a selected sample ADG.
- [x] Render an audio-effect ADG with supported native nested devices and branch mixing.
- [ ] Import a complete ALS set and preserve its entire arrangement/session graph.
- [ ] Resolve every Pack and user-library dependency, not only Core Library assets.
- [ ] Round-trip edited graphs back into Ableton file formats.

Useful discovery commands:

```sh
pnpm djbooth produce ableton library --query "808" --limit 50
pnpm djbooth produce ableton inspect-asset /path/to/device.adg
pnpm djbooth produce ableton inspect-device-graph /path/to/device.adg
pnpm djbooth produce ableton inspect-instrument /path/to/instrument.adg
pnpm djbooth produce ableton inspect-clip /path/to/clip.alc
pnpm djbooth produce ableton inspect-groove /path/to/groove.agr
```

## Tutorial and production-knowledge surface

What is collected:

- [x] 357 official Ableton tutorial articles.
- [x] 296 official articles with linked media.
- [x] 100 official articles prioritized for headless use.
- [x] 477 unique YouTube candidates from 45 targeted searches.
- [x] 41 Ableton device families connected to at least one official article.
- [x] YouTube metadata categorized into sound design, bass, mixing, drums, spatial processing, harmony, dynamics, and groove.
- [x] 304 tutorial videos ingested, totaling 99.71 hours.
- [x] English creator/automatic captions recovered for 287 videos; 17 are explicitly queued for local ASR.
- [x] 2,701 timestamped Ableton UI frames retained with OCR; source video is deleted after extraction.
- [x] 7,225 transcript-grounded action windows indexed across 49 device families.
- [x] Native `ytdlp-ts` extraction avoids browser cookies and webpage throttling; updated `yt-dlp` remains the edge-case fallback.
- [x] Per-device knowledge map includes capability status, common actions/parameters, timestamp links, nearest frames, and evidence scores.
- [x] Thirteen executable production recipes synthesized from 24 source articles.
- [x] Current recipes use real installed ADV presets and Ableton DSP only.
- [ ] Collect high-signal independent blog/tutorial catalogs systematically.
- [ ] Expand YouTube searches beyond the original Ableton/Serum queries and score instructor quality, specificity, and audible evidence.
- [x] Obtain captions where available and retain time-coded action evidence for synthesis.
- [ ] Extract exact device order, parameter moves, routing, automation, input assumptions, and intended audible outcome.
- [ ] Map each tutorial action to recovered Ableton parameters/macros or explicitly flag it as unsupported.
- [ ] Compile tutorial steps into a versioned declarative recipe schema.
- [ ] Render dry/wet fixtures and automatically reject silent, unstable, clipping, or negligible recipes.
- [ ] Human-audition every recipe for whether it actually achieves the tutorial’s stated goal.
- [ ] Cover every high-value device and every musical role with multiple contrasting recipes.
- [ ] Use tutorial recipes during reference-track reconstruction instead of selecting effects by name alone.

Current executable recipes:

- [x] Low-end authority
- [x] Focused pulse bass
- [x] Kick authority
- [x] Snare depth
- [x] Clap dimension
- [x] Hat air
- [x] Pad depth
- [x] Tape-colored pad depth
- [x] Lead perspective
- [x] Wide lead echo
- [x] Granular ear candy
- [x] Percussion electricity
- [x] Warm drum color

Current recipe-device coverage is narrow: Hybrid Reverb, Roar, Chorus-Ensemble, EQ Eight, Drum Buss, Glue Compressor, Grain Delay, Utility, Delay, Echo, and Reverb. That is only 11 device families and should not be confused with broad production knowledge.

### Tutorial source queues

Official/authoritative:

- [x] [Live manual: instruments and effects](https://www.ableton.com/en/live-manual/12/working-with-instruments-and-effects/)
- [x] [Live manual: racks](https://www.ableton.com/en/live-manual/12/instrument-drum-and-effect-racks/)
- [x] [Live instrument reference](https://www.ableton.com/en/live-manual/12/live-instrument-reference/)
- [x] [Max for Live devices](https://www.ableton.com/en/live-manual/12/max-for-live-devices/)
- [x] [Ableton tutorial archive](https://www.ableton.com/en/blog/categories/tutorials/)
- [~] [Ableton Learn Live videos](https://www.ableton.com/en/live/learn-live/): catalog and map every video to families/features.

High-signal YouTube queues:

- [~] Seed To Stage — 15 candidates already collected; prioritize long-form sound design and full-track workflows.
- [~] Ned Rush — prioritize racks, routing, generative sequencing, resampling, Drum Racks, and unusual stock-device chains.
- [~] Underdog Electronic Music School — prioritize arrangement, groove, techno/house low end, transitions, and mix decisions.
- [~] You Suck at Producing / Underbelly — prioritize concise stock-device workflows and arrangement fundamentals.
- [~] Ableton Tips / Production Music Live — 15 candidates already collected; prioritize start-to-finish genre workflows and reproducible stock chains.
- [~] Mr. Bill — prioritize resampling, racks, modulation, bass design, and high-detail arrangement.
- [~] XNB — prioritize deep references for individual Ableton devices.
- [~] Add channel-level discovery and playlists; captions, chapters, caching, and video-ID deduplication work.

Independent tutorial queues:

- [~] [Sound On Sound Ableton techniques](https://www.soundonsound.com/techniques/creative-crossfades-ableton-live): precise workflow and signal-flow articles.
- [~] [Attack Magazine tutorials](https://www.attackmagazine.com/technique/tutorials/): genre production, synthesis, drum programming, and arrangement examples.
- [~] [MusicRadar production tutorials](https://www.musicradar.com/tutorials/music-production-tutorials): device techniques and contemporary production workflows.
- [ ] Add selected artist/producer breakdowns where the actual project, rack, or parameter state is visible.
- [ ] Track source version, publication date, Live version, stock/third-party dependencies, and licensing constraints.

## Recipe schema required to “actually know how to use it”

Each learned technique should contain:

- [ ] Goal and musical role: e.g. “punchy mono-compatible bass,” not merely “use Roar.”
- [ ] Provenance: URL, creator, publication date, Live version, and relevant timestamps.
- [ ] Input contract: source type, register, transient/dynamic character, level, BPM, and key assumptions.
- [ ] Device graph: exact order, rack topology, presets, and parameter values.
- [ ] Modulation/routing: sidechain source, macros, envelopes, LFOs, automation curves, sends, and wet/dry topology.
- [ ] Musical context: where it enters, section role, density, voicing, rhythm, and relationship to other parts.
- [ ] Expected result: tonal, transient, dynamic, stereo, and depth changes.
- [ ] Executability: supported/partial/blocked actions linked to this capability matrix.
- [ ] Verification: dry/wet render, metrics, listening note, and reusable fixture.
- [ ] Translation notes: the nearest executable Ableton-native equivalent when a tutorial uses unsupported or third-party tools.

## Demonstrated end-to-end production path

- [x] Analyze a reference and separated stems.
- [x] Express notes, clips, samples, and arrangement in text/JSON.
- [x] Render plugin instruments such as Serum headlessly.
- [x] Feed those renders and Ableton library samples into the graph.
- [x] Apply serial chains of real Ableton effects and installed presets.
- [x] Cache occupied post-effect clips rather than rendering empty song-length audio.
- [x] Render stems and a final master with no custom DSP.
- [x] Demonstrate a 21-track, 88-bar arrangement with 40 Ableton-native effect instances.
- [ ] Drive native Ableton instruments for most tonal parts instead of relying mainly on Serum/pre-rendered audio.
- [ ] Select and parameterize techniques from the tutorial knowledge base based on stem role and audible target.
- [ ] Add full bus/return/master topology and timeline automation.
- [ ] Compare every reconstruction against reference stem relationships and iterate automatically.

Example build and render:

```sh
node examples/production/build-night-bus-developed.mjs

pnpm djbooth produce ableton render-graph \
  examples/production/night-bus-developed-graph.json \
  /tmp/night-bus-developed.wav \
  --cache-dir /tmp/night-bus-developed-cache \
  --stems-dir /tmp/night-bus-developed-stems \
  --device-host rust/target/x86_64-apple-darwin/release/djbooth-rs
```

## Recommended execution order

1. [ ] Make the capability report persist a machine-readable snapshot and per-family test fixture links.
2. [ ] Finish exact ADG rack execution: parallel chains, selectors, nested mixers, sends, and returns.
3. [ ] Add parameter/macro automation and direct graph sidechains.
4. [ ] Add native master chains and group/return buses.
5. [ ] Finish Operator, Impulse, and Arpeggiator scheduler/voice behavior.
6. [ ] Exhaustively verify Max for Live dependencies and non-UI rendering.
7. [x] Expand tutorial collection across the source queues above.
8. [x] Build time-coded action extraction and the executable recipe schema.
9. [ ] Produce at least three verified recipes for every high-value instrument/effect and musical role.
10. [ ] Maintain audible device fixtures plus complete-track benchmarks so capability and taste improve together.
