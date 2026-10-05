# InstrumentVector

Generate pitched or percussive sound inside Ableton's native engine.

## Production use

Choose it for its synthesis model, then shape motion with envelopes/modulation and control the result downstream.

- Kind: instrument
- Domains: synthesis, timbre
- Headless status: partial
- Engine status: nativeAudioRenderProven
- Preset status: exhaustiveAdvRenderProven
- Mechanism: liveEngineBundle
- Safe claim: Native audio execution is proven; higher-level preset, routing, or automation parity is incomplete.
- Remaining blocker: all installed ADV presets render finitely; composite rack/sidechain differentials remain
- Custom DSP: false

## Tutorial knowledge

- Evidence status: evidence-rich
- Videos: 31
- Action windows: 74
- Common actions: use (30), filter (13), add (10), create (10), turn (9), set (6), change (4), map (4), group (3), lower (3), cut (2), modulate (2)
- Common parameters: lfo (11), envelope (9), gain (6), attack (3), frequency (3), amount (2), decay (2), detune (2), rate (2), sustain (2), 100Hz (1), 2 DB (1)
- Commonly co-occurs with: Reverb (13), DrumGroupDevice (7), Operator (7), UltraAnalog (7), Hybrid (6), AutoFilter (5), Chorus2 (5), Echo (5), InstrumentGroupDevice (5), Limiter (5), Compressor2 (4), MultiSampler (4)
- Recipes: none yet

## Timestamped evidence

- [COLLISION - Design Custom Percussion Sounds in Ableton Live 11](https://www.youtube.com/watch?v=SVC9fAi6gTQ&t=1234s) — Jemeneye, 20:35. Actions: use; parameters: none tagged. i was really nervous about making the collision tutorial even though i've played with collision and some of the sdho's sdho's sdho's um you know what i mean i've used operator i've used analog i've used sampler i've used wavetable like sampl
- [Sound Design with Wavetable in Ableton Live 10](https://www.youtube.com/watch?v=J0XXUPVc8dA&t=405s) — Sequence One, 6:46. Actions: filter, lower, set, turn, use; parameters: 2 DB. all right so before we set the final destination of the filter I'm going to lower the volume of wavetable about 2 DB because I started to notice that on the track volume it was starting to peak okay back to the filter section so you okay back to the
- [Ableton's Instruments Explained! (Lite, Intro, Standard & Suite)](https://www.youtube.com/watch?v=Rdf1CLNg2ac&t=1663s) — Matt Tinkler, 27:44. Actions: create; parameters: none tagged. Collision, and Tension, as well as access to all of the different DS or drum synth instruments that are created inside of Max for Live. Lastly, Suite gives us access to Sampler, Operator, Wavetable, and Meld, as well as Bass and Wavetable, and Meld, as well a
- [Ableton Wavetable Synth - Full Guide for Beginners](https://www.youtube.com/watch?v=aLOYhVQbhp8&t=1803s) — Ableton Tips by PML, 30:03. Actions: cut, use; parameters: none tagged. also are racked like this. So you can easily control the most important parameters like cutff, chorus, and just echo, reverb. All right, I hope this overview of Wavetable was useful for you guys, make sure to check out our music guys, make sure to check out
- [Ableton Wavetable Tutorial: Exciting Hard Techno Lead Sound Design](https://www.youtube.com/watch?v=TZBbSHNiMQQ&t=787s) — Marcin Rajski, 13:08. Actions: add, modulate, use; parameters: amount, envelope. I want the sound to be even more interesting so I will add some modulations I will use the second envelope to modulate both wavetable position and the warping amount you have already learned about these two earlier already learned about these
- [Ableton Wavetable Synth - Full Guide for Beginners](https://www.youtube.com/watch?v=aLOYhVQbhp8&t=1230s) — Ableton Tips by PML, 20:31. Actions: increase, map; parameters: lfo. And we can map an LFO to this position of this wave table. So we can just click on wavetable position and map the first LFO to this one. Let's just increase oscillator one position with LFO one. And we're just mapping it to this And we're just mapping it
- [Modulators in Ableton Live: LFO - Ableton Tutorial + Project File](https://www.youtube.com/watch?v=1VQFlrMQdMI&t=309s) — 343 Labs, 5:10. Actions: map, turn, use; parameters: lfo. we'll turn this closer to a triangle wave now if you're a wavetable user you might be going hey man there's already an LFO inside of the wavetable device and you're right what's cool about the LFO device is that we can open multimap device is that we can ope
- [Modulators in Ableton Live: LFO - Ableton Tutorial + Project File](https://www.youtube.com/watch?v=1VQFlrMQdMI&t=328s) — 343 Labs, 5:28. Actions: map, modulate; parameters: gain, frequency. and now we can assign the same control signal to parameters inside and outside of wavetable let's click map and this time I'm going to modulate the frequency of my erosion device [Music] let's again limit the range of modulation
- [Sound Design with Feedback in Ableton Live](https://www.youtube.com/watch?v=3HKDztcT3Cg&t=1241s) — Seed To Stage, 20:42. Actions: lower, use; parameters: feedback, envelope. design around a feedback situation is that you have to control the feedback and what i've done here is i've used envelope follower to listen to this wavetable sound and this yields this really interesting situation where i've
- [Made in Ableton Live: K. Hart on creative resampling, granular techniques and adding life to MIDI](https://www.youtube.com/watch?v=LANPsnGB_yY&t=598s) — Ableton, 9:58. Actions: change, filter, turn, use; parameters: envelope. from the other. It sounds like this. I went ahead and turned off the filter inside of wavetable because I'm going to use an auto filter to kind of control the envelope. I went ahead and changed the amplitude envelope to look similar to this. And then important if you're making a…

## Official reading

- [George FitzGerald: Personal Stamp](https://www.ableton.com/en/blog/george-fitzgerald-personal-stamp/) — Learn how George FitzGerald uses Ableton Live to bring the sounds on his latest album to life.
- [Made in Ableton Live: K. Hart](https://www.ableton.com/en/blog/made-in-ableton-live-k-hart/) — Learn how to create a glitchy, future garage-inspired track with K. Hart using Live's generative, granular, and spectral tools.
- [Pad It Out: 10 Ways to Make Distinctive Pad Sounds](https://www.ableton.com/en/blog/pad-it-out-10-ways-make-distinctive-pad-sounds/) — Sound designer Richard Veenstra outlines 10 tips to make your pad sounds stand out. Audio examples included.
- [Shapeshifting: Sound Design Explorations with Roar](https://www.ableton.com/en/blog/shapeshifting-sound-design-explorations-with-roar/) — See how Roar turns basic signals into entirely new sounds, with Seed to Stage’s video walkthrough.
- [Meld: A Look at Live 12’s New Bi-Timbral Synth](https://www.ableton.com/en/blog/meld-a-look-at-live-12s-new-bi-timbral-synth/) — Find out the story behind Live 12’s new bi-timbral macro oscillator device and learn tips and tricks to try with it.
- [Made in Ableton Live: Tom Cosm](https://www.ableton.com/en/blog/made-in-ableton-live-tom-cosm/) — Watch Tom Cosm layer buzzing neurobass over hard-hitting drums as he crafts a dynamic, richly textured arrangement for a drum and bass track.
- [Made in Ableton Live: STRANJAH](https://www.ableton.com/en/blog/made-in-ableton-live-stranjah/) — Check out STRANJAH’s detail-focused approach to crafting perfect grooves, lush melodic layers, and driving drum & bass arrangements.
- [Download the Live Set of Eluize’s New Track “EMDR”](https://www.ableton.com/en/blog/download-the-live-set-of-eluizes-new-track-emdr/) — Berlin-based house and techno producer Eluize lifts the lid on her creative process, with a free Live set download to see how she works.
- [Wavetable: How to Build a Whole Track with Live’s New Synth](https://www.ableton.com/en/blog/wavetable-how-build-whole-track-lives-new-synth/) — Ableton Live 10 video tutorial with Sonic State and Certified Trainer Simon Stokes building a track from scratch with the Wavetable synthesizer.
- [Drone Lab: Creating Sustained Sounds in Live 11](https://www.ableton.com/en/blog/drone-lab-creating-sustained-sounds-in-live-11/) — Ami Dang, Xosar, Niall McCallum and Sofia Nicolas Melero explain how they created the sustained sounds and drone-making devices found in Ableton’s Drone Lab.
- [Download the Live Set of Merrin Karras’ New Track “Still Life”](https://www.ableton.com/en/blog/download-the-live-set-of-merrin-karras-new-track-still-life/) — Ireland-born electronic musician Merrin Karras reveals his creative process, with a free Live set download to see directly how he works.
- [Made in Ableton Live: Kabuki](https://www.ableton.com/en/blog/made-in-ableton-live-kabuki/) — Learn about Max patching with a look into Kabuki’s free Max for Live device – then download it to try out in your own music.
