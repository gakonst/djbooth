# Ableton Production and Headless Orchestration Knowledge Base

This is the operational synthesis of 99.71 hours of tutorial video, 357 official articles, 75 capability families, factory recipes, and the current native-engine audit. It distinguishes tutorial evidence from production synthesis and render-proven execution.

## Coverage

| Material | Count |
| --- | ---: |
| Tutorial videos | 304 |
| Tutorial hours | 99.71 |
| Videos with transcripts | 287 |
| Timestamped action windows | 7225 |
| Targeted frames | 2701 |
| Official articles | 357 |
| Ableton capability families | 75 |
| Families with tutorial evidence | 49 |
| Complete headless families | 12 |
| Partial headless families | 63 |
| Synthesized production principles | 19 |
| Production roles | 11 |
| Executable recipes | 20 |

## What we learned

### Give every sound a job before choosing devices

Richness comes from complementary roles—fundamental, body, transient, air, motion, and space—not from placing a large chain on every channel.

- Name the spectral, rhythmic, stereo, and depth role of each layer.
- Delete or mute a layer that duplicates another role without adding contrast.
- Judge processing in the full arrangement, not only in solo.

### Serial order is part of the sound

Filtering before distortion changes what generates harmonics; filtering after distortion changes what remains. The same principle applies to dynamics, modulation, and space.

- State the purpose of each stage and why it precedes the next one.
- Put corrective filtering before nonlinear stages when unwanted energy should not create harmonics.
- Use post-processing to contain level, bandwidth, and stereo consequences.

### Nonlinear devices are input-level dependent

Amp, Saturator, Roar, compression, and many analog-modeled devices produce different texture when their input level changes, so gain staging must be declarative.

- Record pre-device gain and post-device trim as part of the patch.
- Level-match bypass comparisons.
- Treat louder as a measurement error, not automatic improvement.

### Parallel chains preserve identity while adding character

A dry path can retain transient and pitch definition while a wet path supplies distortion, compression, modulation, or ambience.

- Define dry and wet gain independently.
- Band-limit or time-limit the wet branch when it competes with the source.
- Check phase and latency before interpreting the blend.

### Keep foundations centered and widen selected detail

Low-end authority survives translation when the fundamental is centered and stereo movement is concentrated in upper harmonics, ambience, or secondary layers.

- Keep the sub/fundamental mono or strongly correlated.
- Create width after a crossover, on a parallel harmonic layer, or in a separate octave.
- Audit mono compatibility and low-frequency phase.

### Movement needs a musical timescale

Envelope, LFO, random modulation, and automation solve different time scales: note shape, cyclic motion, organic variance, and section-level development.

- Use envelopes for note articulation.
- Use synchronized or intentionally free LFOs for within-phrase motion.
- Use automation for transitions and section contrast; use random modulation at small depth for life.

### Sidechain is a control signal, not only kick ducking

An external signal can drive compression, gating, filters, modulation, and wet-return clearance to make parts interlock.

- Choose a source whose rhythm expresses the desired interaction.
- Filter the detector when sub or cymbal energy causes false triggering.
- Duck effects returns separately when the dry source should stay stable.

### Distort the band that needs to become audible

Bass and drums gain perceived size when selected mids and upper harmonics are generated without destroying the low-frequency anchor or transient.

- Split or pre-filter when only one register needs density.
- Retain a clean low or transient layer.
- Use post-EQ and output trim to contain the added spectrum.

### Dynamics timing must breathe with the groove

Attack decides how much transient survives; release decides whether gain recovers musically before the next event.

- Set attack from the transient you want to retain.
- Set release while listening to the next rhythmic event.
- Use gain reduction as feedback, then judge the groove by ear at matched level.

### Depth is dry/wet balance, predelay, decay, filtering, and dynamics together

Reverb alone does not create a convincing front-to-back mix. Foreground separation and background placement depend on several coordinated cues.

- Use predelay to separate a foreground attack from its room.
- Darken or band-limit distant wet signals.
- Shorten or duck tails when arrangement density increases.

### Delay can write counter-rhythm and perspective

Sparse synchronized repeats, stereo offsets, filtered feedback, and automated throws extend motifs without adding another continuously playing instrument.

- Choose repeat timing from the empty spaces around the motif.
- Filter feedback so repeats recede.
- Automate sends on phrase endings rather than running high feedback continuously.

### Design drum transient, body, tone, and room as separate stages

Professional drum weight comes from controlling distinct perceptual components instead of stacking undifferentiated samples and bus processing.

- Tune and envelope the body before adding color.
- Keep the click/noise transient short and spectrally purposeful.
- Put room and ambience on controlled layers or sends.

### Physical models make organic tone but can produce extreme resonances

Collision, Corpus, and String Studio create convincing material behavior, but resonator feedback and excitation can jump in level unpredictably.

- Place a safety limiter while designing.
- Tune material, decay, and excitation in the target register.
- Remove narrow resonances after the physical model, not by flattening all character.

### Resampling converts unstable processes into editable composition

Granular, feedback, random, and long effect gestures become precise musical material when printed, selected, cut, reversed, and placed.

- Generate more material than needed, then curate.
- Cut gestures to phrase boundaries and rhythmic gaps.
- Preserve the source patch and random seed/state when reproducibility matters.

### Human variation is constrained, not uniformly random

Velocity, timing, probability, note length, and timbre should vary by role and phrase while anchors remain stable.

- Protect downbeats and identity notes.
- Vary supporting hits within bounded ranges.
- Create phrase-level fills and omissions in addition to micro-variation.

### Racks encode orchestration, not merely preset storage

Parallel chains, key/velocity zones, chain selectors, nested returns, and macros turn one track into a controlled arrangement system.

- Map macros to perceptual outcomes, not arbitrary parameters.
- Use selectors for section variants and performance states.
- Represent nested routing explicitly in the headless graph.

### Arrangement development needs orchestration changes

A convincing track develops through changes in register, density, rhythm, voicing, foreground, and motif—not only filter sweeps and muted drums.

- Give each section a distinct active-role set.
- Develop motifs through answer phrases, octave/voicing changes, and rhythmic displacement.
- Use transitions to prepare structural changes, not substitute for them.

### Factory presets are executable design vocabulary

Installed ADV/ADG assets capture Ableton's own parameter choices and routings; they are better starting points than approximate custom reimplementations when native execution is available.

- Resolve and retain exact preset asset paths.
- Render through Ableton's native processor when proven.
- Treat unsupported rack semantics as blockers, not invitations to substitute homemade DSP.

### Every extracted technique needs an audible fixture

Transcript and OCR extraction produce hypotheses. The learning loop closes only when a minimal render demonstrates the intended change and survives level-matched comparison.

- Build one-variable A/B fixtures for parameters and routing.
- Store source timestamp, device state, render, and measurement together.
- Promote a recipe only after it sounds useful in context.

## Navigate

- [Technique encyclopedia](TECHNIQUES.md)
- [Open execution and evidence gaps](GAPS.md)
- [Source catalog](SOURCES.md)
- Device encyclopedia: [Amp](devices/amp.md), [AudioBranchMixerDevice](devices/audio-branch-mixer-device.md), [AudioEffectGroupDevice](devices/audio-effect-group-device.md), [AutoFilter](devices/auto-filter.md), [AutoFilter2](devices/auto-filter2.md), [AutoPan](devices/auto-pan.md), [AutoPan2](devices/auto-pan2.md), [AutoShift](devices/auto-shift.md), [BeatRepeat](devices/beat-repeat.md), [Cabinet](devices/cabinet.md), [ChannelEq](devices/channel-eq.md), [Chorus](devices/chorus.md), [Chorus2](devices/chorus2.md), [Collision](devices/collision.md), [Compressor2](devices/compressor2.md), [Corpus](devices/corpus.md), [Delay](devices/delay.md), [Drift](devices/drift.md), [DrumBuss](devices/drum-buss.md), [DrumCell](devices/drum-cell.md), [DrumGroupDevice](devices/drum-group-device.md), [Echo](devices/echo.md), [Eq8](devices/eq8.md), [Erosion](devices/erosion.md), [FilterDelay](devices/filter-delay.md), [FilterEQ3](devices/filter-eq3.md), [Flanger](devices/flanger.md), [FrequencyShifter](devices/frequency-shifter.md), [Gate](devices/gate.md), [GlueCompressor](devices/glue-compressor.md), [GrainDelay](devices/grain-delay.md), [Hybrid](devices/hybrid.md), [InstrumentGroupDevice](devices/instrument-group-device.md), [InstrumentImpulse](devices/instrument-impulse.md), [InstrumentMeld](devices/instrument-meld.md), [InstrumentVector](devices/instrument-vector.md), [Limiter](devices/limiter.md), [Looper](devices/looper.md), [LoungeLizard](devices/lounge-lizard.md), [MidiArpeggiator](devices/midi-arpeggiator.md), [MidiBranchMixerDevice](devices/midi-branch-mixer-device.md), [MidiChord](devices/midi-chord.md), [MidiEffectGroupDevice](devices/midi-effect-group-device.md), [MidiNoteLength](devices/midi-note-length.md), [MidiPitcher](devices/midi-pitcher.md), [MidiRandom](devices/midi-random.md), [MidiScale](devices/midi-scale.md), [MidiVelocity](devices/midi-velocity.md), [MultibandDynamics](devices/multiband-dynamics.md), [MultiSampler](devices/multi-sampler.md), [MxDeviceAudioEffect](devices/mx-device-audio-effect.md), [MxDeviceInstrument](devices/mx-device-instrument.md), [MxDeviceMidiEffect](devices/mx-device-midi-effect.md), [Operator](devices/operator.md), [OriginalSimpler](devices/original-simpler.md), [Overdrive](devices/overdrive.md), [Pedal](devices/pedal.md), [Phaser](devices/phaser.md), [PhaserNew](devices/phaser-new.md), [Redux](devices/redux.md), [Redux2](devices/redux2.md), [Resonator](devices/resonator.md), [Reverb](devices/reverb.md), [Roar](devices/roar.md), [Saturator](devices/saturator.md), [Shifter](devices/shifter.md), [Spectral](devices/spectral.md), [SpectrumAnalyzer](devices/spectrum-analyzer.md), [StereoGain](devices/stereo-gain.md), [StringStudio](devices/string-studio.md), [Transmute](devices/transmute.md), [Tube](devices/tube.md), [UltraAnalog](devices/ultra-analog.md), [Vinyl](devices/vinyl.md), [Vocoder](devices/vocoder.md)
- Production roles: [Kick](roles/kick.md), [Snare and clap](roles/snare-clap.md), [Hats and percussion](roles/percussion.md), [Drum bus](roles/drums.md), [Bass and low end](roles/bass.md), [Lead, pluck, and hook](roles/lead.md), [Pads and harmonic beds](roles/pad.md), [Depth and spatial effects](roles/spatial.md), [Texture and ear candy](roles/texture.md), [Arrangement and development](roles/arrangement.md), [Mix bus and translation](roles/mix-bus.md)

## Query it

From the repository root:

```sh
node examples/production/query-ableton-knowledge-base.mjs "wide bass without losing the sub"
node examples/production/query-ableton-knowledge-base.mjs --type device "physical modeling percussion"
node examples/production/query-ableton-knowledge-base.mjs --type role "build a lead with depth"
```

The machine-readable source of truth is [knowledge-base.json](knowledge-base.json). Regenerate it with `node examples/production/build-ableton-knowledge-base.mjs`.
