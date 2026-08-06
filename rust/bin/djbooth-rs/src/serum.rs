use std::collections::BTreeMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, ensure};
use flate2::read::ZlibDecoder;
use serde::Deserialize;

use crate::plugin::{
    AutomationEnvelope, AutomationPoint, ControlAutomation, DisplayUnit, NamedParameterOverride,
    ParameterTarget,
};

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SerumPatchSpec {
    schema_version: u32,
    pub(crate) name: String,
    pub(crate) template_preset: PathBuf,
    #[serde(default)]
    expected_resources: Vec<String>,
    pub(crate) tutorial: Option<TutorialReference>,
    #[serde(default = "default_master_volume_percent")]
    master_volume_percent: f32,
    #[serde(default)]
    portamento_ms: Option<f32>,
    #[serde(default)]
    oscillator_a: Option<OscillatorSpec>,
    #[serde(default)]
    oscillator_b: Option<OscillatorSpec>,
    #[serde(default)]
    noise: Option<NoiseSpec>,
    #[serde(default)]
    sub: Option<SubSpec>,
    amp_envelope: EnvelopeSpec,
    #[serde(default)]
    envelope_2: Option<EnvelopeSpec>,
    #[serde(default)]
    envelope_3: Option<EnvelopeSpec>,
    #[serde(default)]
    filter: Option<FilterSpec>,
    #[serde(default)]
    effects: EffectsSpec,
    #[serde(default)]
    lfos: BTreeMap<String, LfoSpec>,
    #[serde(default)]
    modulations: Vec<ModulationSpec>,
    #[serde(default)]
    design_notes: Vec<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TutorialReference {
    pub(crate) title: String,
    pub(crate) url: String,
    pub(crate) section: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OscillatorSpec {
    wavetable: String,
    #[serde(default = "default_level_percent")]
    level_percent: f32,
    #[serde(default)]
    pan: f32,
    #[serde(default)]
    octave: i8,
    #[serde(default)]
    semitones: i8,
    #[serde(default)]
    fine_cents: f32,
    #[serde(default = "default_unison")]
    unison: u8,
    #[serde(default = "default_detune_percent")]
    detune_percent: f32,
    #[serde(default = "default_unison_blend_percent")]
    blend_percent: f32,
    #[serde(default)]
    wavetable_position_percent: f32,
    #[serde(default)]
    phase_degrees: f32,
    #[serde(default)]
    random_phase_percent: f32,
    #[serde(default)]
    warp: Option<WarpSpec>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WarpSpec {
    mode: String,
    amount_percent: f32,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NoiseSpec {
    sample: String,
    level_percent: f32,
    #[serde(default = "default_noise_pitch_percent")]
    pitch_percent: f32,
    #[serde(default)]
    fine_percent: f32,
    #[serde(default)]
    pan: f32,
    #[serde(default)]
    phase_percent: f32,
    #[serde(default)]
    random_phase_percent: f32,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SubSpec {
    shape: String,
    octave: i8,
    level_percent: f32,
    #[serde(default)]
    pan: f32,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EnvelopeSpec {
    #[serde(default)]
    attack_ms: f32,
    #[serde(default)]
    hold_ms: f32,
    decay_ms: f32,
    sustain_percent: f32,
    #[serde(default = "default_release_ms")]
    release_ms: f32,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FilterSpec {
    filter_type: String,
    cutoff_hz: f32,
    #[serde(default)]
    resonance_percent: f32,
    #[serde(default)]
    drive_percent: f32,
    #[serde(default)]
    fat_percent: f32,
    #[serde(default = "default_level_percent")]
    mix_percent: f32,
    #[serde(default = "default_filter_stereo_percent")]
    stereo_percent: f32,
    #[serde(default)]
    route: Vec<FilterSource>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
enum FilterSource {
    OscillatorA,
    OscillatorB,
    Noise,
    Sub,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EffectsSpec {
    #[serde(default)]
    distortion: Option<DistortionSpec>,
    #[serde(default)]
    compressor: Option<CompressorSpec>,
    #[serde(default)]
    eq: Option<EqSpec>,
    #[serde(default)]
    filter: Option<FxFilterSpec>,
    #[serde(default)]
    reverb: Option<ReverbSpec>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DistortionSpec {
    mode: String,
    drive_percent: f32,
    #[serde(default = "default_level_percent")]
    mix_percent: f32,
    #[serde(default)]
    pre_filter: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CompressorSpec {
    threshold_db: f32,
    ratio: String,
    attack_ms: f32,
    release_ms: f32,
    #[serde(default)]
    gain_db: f32,
    #[serde(default)]
    multiband: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EqSpec {
    low_type: String,
    low_frequency_hz: f32,
    low_q_percent: f32,
    low_gain_db: f32,
    high_type: String,
    high_frequency_hz: f32,
    high_q_percent: f32,
    high_gain_db: f32,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FxFilterSpec {
    filter_type: String,
    cutoff_hz: f32,
    #[serde(default)]
    resonance_percent: f32,
    #[serde(default)]
    drive_percent: f32,
    #[serde(default = "default_level_percent")]
    mix_percent: f32,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReverbSpec {
    size_percent: f32,
    pre_delay_ms: f32,
    low_cut_percent: f32,
    high_cut_percent: f32,
    damp_percent: f32,
    width_percent: f32,
    mix_percent: f32,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LfoSpec {
    mode: LfoMode,
    rate_hz: f64,
    points: Vec<LfoPointSpec>,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
enum LfoMode {
    Envelope,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LfoPointSpec {
    position_percent: f32,
    value_percent: f32,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ModulationSpec {
    source: String,
    destination: String,
    range: ModulationRange,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "unit", rename_all = "camelCase")]
enum ModulationRange {
    Percent { minimum: f32, maximum: f32 },
    Hertz { minimum: f32, maximum: f32 },
    Semitones { minimum: f32, maximum: f32 },
}

pub(crate) struct CompiledSerumPatch {
    pub(crate) name: String,
    pub(crate) preset: PathBuf,
    pub(crate) parameters: Vec<NamedParameterOverride>,
    pub(crate) automations: Vec<ControlAutomation>,
}

pub(crate) fn load_and_compile_patch(
    patch_path: &Path,
    preset_root: &Path,
) -> Result<CompiledSerumPatch> {
    let patch = serde_json::from_slice::<SerumPatchSpec>(
        &fs::read(patch_path)
            .with_context(|| format!("failed to read Serum patch {}", patch_path.display()))?,
    )
    .with_context(|| format!("invalid Serum patch JSON in {}", patch_path.display()))?;
    patch
        .compile(preset_root)
        .with_context(|| format!("invalid Serum patch '{}'", patch.name))
}

impl SerumPatchSpec {
    fn compile(&self, preset_root: &Path) -> Result<CompiledSerumPatch> {
        ensure!(self.schema_version == 1, "unsupported schemaVersion");
        ensure!(!self.name.trim().is_empty(), "name cannot be empty");
        let preset = if self.template_preset.is_absolute() {
            self.template_preset.clone()
        } else {
            preset_root.join(&self.template_preset)
        };
        ensure!(
            preset.is_file(),
            "template preset does not exist: {}",
            preset.display()
        );
        validate_template_resources(&preset, &self.expected_resources)?;
        validate_percent(self.master_volume_percent, "masterVolumePercent")?;

        let mut parameters = Vec::new();
        normalized(
            &mut parameters,
            "MasterVol",
            self.master_volume_percent / 100.0,
        );
        if let Some(portamento_ms) = self.portamento_ms {
            ensure!(
                portamento_ms.is_finite() && portamento_ms >= 0.0,
                "portamentoMs must be non-negative"
            );
            display(
                &mut parameters,
                "PortTime",
                portamento_ms,
                DisplayUnit::Milliseconds,
            );
        }

        // A patch is complete and deterministic: inherited voices, routes and FX start disabled.
        for (name, value) in [
            ("Osc A On", 0.0),
            ("Osc B On", 0.0),
            ("Osc N On", 0.0),
            ("Osc S On", 0.0),
            ("Filter On", 0.0),
            ("Dist_On", 0.0),
            ("Flg_On", 0.0),
            ("Phs_On", 0.0),
            ("Cho_On", 0.0),
            ("Dly_On", 0.0),
            ("Comp_On", 0.0),
            ("Rev_On", 0.0),
            ("EQ_On", 0.0),
            ("FX Fil On", 0.0),
            ("Hyp On", 0.0),
        ] {
            normalized(&mut parameters, name, value);
        }
        for slot in 1..=16 {
            bipolar_percent(&mut parameters, &mod_parameter_name(slot), 0.0)?;
        }

        if let Some(oscillator) = &self.oscillator_a {
            oscillator.compile('A', &mut parameters)?;
        }
        if let Some(oscillator) = &self.oscillator_b {
            oscillator.compile('B', &mut parameters)?;
        }
        if let Some(noise) = &self.noise {
            noise.compile(&mut parameters)?;
        }
        if let Some(sub) = &self.sub {
            sub.compile(&mut parameters)?;
        }
        self.amp_envelope.compile(1, &mut parameters)?;
        if let Some(envelope) = &self.envelope_2 {
            envelope.compile(2, &mut parameters)?;
        }
        if let Some(envelope) = &self.envelope_3 {
            envelope.compile(3, &mut parameters)?;
        }
        if let Some(filter) = &self.filter {
            filter.compile(&mut parameters)?;
        }
        self.effects.compile(&mut parameters)?;
        let mut automations = Vec::with_capacity(self.modulations.len());
        for modulation in &self.modulations {
            modulation.compile(&self.lfos, &mut automations)?;
        }
        for note in &self.design_notes {
            ensure!(
                !note.trim().is_empty(),
                "designNotes cannot contain an empty entry"
            );
        }
        if let Some(tutorial) = &self.tutorial {
            ensure!(
                !tutorial.title.trim().is_empty(),
                "tutorial title cannot be empty"
            );
            ensure!(
                tutorial.url.starts_with("https://"),
                "tutorial URL must use HTTPS"
            );
            ensure!(
                !tutorial.section.trim().is_empty(),
                "tutorial section cannot be empty"
            );
        }

        Ok(CompiledSerumPatch {
            name: self.name.clone(),
            preset,
            parameters,
            automations,
        })
    }
}

impl OscillatorSpec {
    fn compile(
        &self,
        oscillator: char,
        parameters: &mut Vec<NamedParameterOverride>,
    ) -> Result<()> {
        ensure!(
            !self.wavetable.trim().is_empty(),
            "oscillator wavetable cannot be empty"
        );
        validate_percent(self.level_percent, "oscillator levelPercent")?;
        validate_pan(self.pan)?;
        ensure!(
            (-4..=4).contains(&self.octave),
            "oscillator octave must be -4..4"
        );
        ensure!(
            (-12..=12).contains(&self.semitones),
            "oscillator semitones must be -12..12"
        );
        ensure!(
            self.fine_cents.is_finite() && (-100.0..=100.0).contains(&self.fine_cents),
            "oscillator fineCents must be -100..100"
        );
        ensure!(
            (1..=16).contains(&self.unison),
            "oscillator unison must be 1..16"
        );
        for (value, name) in [
            (self.detune_percent, "detunePercent"),
            (self.blend_percent, "blendPercent"),
            (self.wavetable_position_percent, "wavetablePositionPercent"),
            (self.phase_degrees / 3.6, "phaseDegrees"),
            (self.random_phase_percent, "randomPhasePercent"),
        ] {
            validate_percent(value, name)?;
        }
        normalized(parameters, &format!("Osc {oscillator} On"), 1.0);
        percent(parameters, &format!("{oscillator} Vol"), self.level_percent)?;
        pan(parameters, &format!("{oscillator} Pan"), self.pan)?;
        normalized(
            parameters,
            &format!("{oscillator} Octave"),
            (f32::from(self.octave) + 4.0) / 8.0,
        );
        normalized(
            parameters,
            &format!("{oscillator} Semi"),
            (f32::from(self.semitones) + 12.0) / 24.0,
        );
        normalized(
            parameters,
            &format!("{oscillator} Fine"),
            (self.fine_cents + 100.0) / 200.0,
        );
        normalized(
            parameters,
            &format!("{oscillator} Unison"),
            f32::from(self.unison - 1) / 15.0,
        );
        percent(
            parameters,
            &format!("{oscillator} UniDet"),
            self.detune_percent,
        )?;
        percent(
            parameters,
            &format!("{oscillator} UniBlend"),
            self.blend_percent,
        )?;
        percent(
            parameters,
            &format!("{oscillator} WTPos"),
            self.wavetable_position_percent,
        )?;
        normalized(
            parameters,
            &format!("{oscillator} Phase"),
            self.phase_degrees / 360.0,
        );
        percent(
            parameters,
            &format!("{oscillator} RandPhase"),
            self.random_phase_percent,
        )?;
        if let Some(warp) = &self.warp {
            choice(parameters, &format!("WarpOsc{oscillator}"), &warp.mode);
            bipolar_percent(
                parameters,
                &format!("{oscillator} Warp"),
                warp.amount_percent,
            )?;
        }
        Ok(())
    }
}

impl NoiseSpec {
    fn compile(&self, parameters: &mut Vec<NamedParameterOverride>) -> Result<()> {
        ensure!(
            !self.sample.trim().is_empty(),
            "noise sample cannot be empty"
        );
        for (value, name) in [
            (self.level_percent, "noise levelPercent"),
            (self.pitch_percent, "noise pitchPercent"),
            (self.phase_percent, "noise phasePercent"),
            (self.random_phase_percent, "noise randomPhasePercent"),
        ] {
            validate_percent(value, name)?;
        }
        ensure!(
            (-100.0..=100.0).contains(&self.fine_percent),
            "noise finePercent must be -100..100"
        );
        validate_pan(self.pan)?;
        normalized(parameters, "Osc N On", 1.0);
        percent(parameters, "Noise Level", self.level_percent)?;
        percent(parameters, "Noise Pitch", self.pitch_percent)?;
        normalized(
            parameters,
            "Noise Fine",
            (self.fine_percent + 100.0) / 200.0,
        );
        pan(parameters, "Noise Pan", self.pan)?;
        percent(parameters, "Noise Phase", self.phase_percent)?;
        percent(parameters, "Noise RandPhase", self.random_phase_percent)?;
        Ok(())
    }
}

impl SubSpec {
    fn compile(&self, parameters: &mut Vec<NamedParameterOverride>) -> Result<()> {
        ensure!((-4..=4).contains(&self.octave), "sub octave must be -4..4");
        validate_percent(self.level_percent, "sub levelPercent")?;
        validate_pan(self.pan)?;
        normalized(parameters, "Osc S On", 1.0);
        choice(parameters, "SubOscShape", &self.shape);
        normalized(
            parameters,
            "SubOscOctave",
            (f32::from(self.octave) + 4.0) / 8.0,
        );
        percent(parameters, "Sub Osc Level", self.level_percent)?;
        pan(parameters, "Sub Osc Pan", self.pan)?;
        Ok(())
    }
}

impl EnvelopeSpec {
    fn compile(&self, envelope: u8, parameters: &mut Vec<NamedParameterOverride>) -> Result<()> {
        for (value, name) in [
            (self.attack_ms, "attackMs"),
            (self.hold_ms, "holdMs"),
            (self.decay_ms, "decayMs"),
            (self.release_ms, "releaseMs"),
        ] {
            ensure!(
                value.is_finite() && value >= 0.0,
                "envelope {name} must be non-negative"
            );
        }
        validate_percent(self.sustain_percent, "envelope sustainPercent")?;
        display(
            parameters,
            &format!("Env{envelope} Atk"),
            self.attack_ms,
            DisplayUnit::Milliseconds,
        );
        display(
            parameters,
            &format!(
                "Env{envelope} H{}",
                if envelope == 1 { "old" } else { "ld" }
            ),
            self.hold_ms,
            DisplayUnit::Milliseconds,
        );
        display(
            parameters,
            &format!("Env{envelope} Dec"),
            self.decay_ms,
            DisplayUnit::Milliseconds,
        );
        normalized(
            parameters,
            &format!("Env{envelope} Sus"),
            self.sustain_percent / 100.0,
        );
        display(
            parameters,
            &format!("Env{envelope} Rel"),
            self.release_ms,
            DisplayUnit::Milliseconds,
        );
        Ok(())
    }
}

impl FilterSpec {
    fn compile(&self, parameters: &mut Vec<NamedParameterOverride>) -> Result<()> {
        ensure!(
            self.cutoff_hz.is_finite() && self.cutoff_hz > 0.0,
            "filter cutoffHz must be positive"
        );
        for (value, name) in [
            (self.resonance_percent, "filter resonancePercent"),
            (self.drive_percent, "filter drivePercent"),
            (self.fat_percent, "filter fatPercent"),
            (self.mix_percent, "filter mixPercent"),
            (self.stereo_percent, "filter stereoPercent"),
        ] {
            validate_percent(value, name)?;
        }
        normalized(parameters, "Filter On", 1.0);
        choice(parameters, "Fil Type", &self.filter_type);
        display(parameters, "Fil Cutoff", self.cutoff_hz, DisplayUnit::Hertz);
        percent(parameters, "Fil Reso", self.resonance_percent)?;
        percent(parameters, "Fil Driv", self.drive_percent)?;
        percent(parameters, "Fil Var", self.fat_percent)?;
        percent(parameters, "Fil Mix", self.mix_percent)?;
        percent(parameters, "Fil Stereo", self.stereo_percent)?;
        for (source, name) in [
            (FilterSource::OscillatorA, "OscA>Fil"),
            (FilterSource::OscillatorB, "OscB>Fil"),
            (FilterSource::Noise, "OscN>Fil"),
            (FilterSource::Sub, "OscS>Fil"),
        ] {
            normalized(parameters, name, f32::from(self.route.contains(&source)));
        }
        Ok(())
    }
}

impl EffectsSpec {
    fn compile(&self, parameters: &mut Vec<NamedParameterOverride>) -> Result<()> {
        if let Some(effect) = &self.distortion {
            validate_percent(effect.drive_percent, "distortion drivePercent")?;
            validate_percent(effect.mix_percent, "distortion mixPercent")?;
            normalized(parameters, "Dist_On", 1.0);
            choice(parameters, "Dist_Mode", &effect.mode);
            percent(parameters, "Dist_Drv", effect.drive_percent)?;
            percent(parameters, "Dist_Wet", effect.mix_percent)?;
            normalized(parameters, "Dist_PrePost", f32::from(effect.pre_filter));
        }
        if let Some(effect) = &self.compressor {
            ensure!(
                effect.attack_ms >= 0.0 && effect.release_ms >= 0.0,
                "compressor times must be non-negative"
            );
            normalized(parameters, "Comp_On", 1.0);
            display(
                parameters,
                "Cmp_Thr",
                effect.threshold_db,
                DisplayUnit::Decibels,
            );
            choice(parameters, "Cmp_Rat", &effect.ratio);
            display(
                parameters,
                "Cmp_Att",
                effect.attack_ms,
                DisplayUnit::Milliseconds,
            );
            display(
                parameters,
                "Cmp_Rel",
                effect.release_ms,
                DisplayUnit::Milliseconds,
            );
            display(parameters, "CmpGain", effect.gain_db, DisplayUnit::Decibels);
            choice(
                parameters,
                "CmpMBnd",
                if effect.multiband {
                    "MultBand"
                } else {
                    "Normal"
                },
            );
        }
        if let Some(effect) = &self.eq {
            for value in [effect.low_q_percent, effect.high_q_percent] {
                validate_percent(value, "EQ qPercent")?;
            }
            normalized(parameters, "EQ_On", 1.0);
            choice(parameters, "EQ TypL", &effect.low_type);
            choice(parameters, "EQ TypH", &effect.high_type);
            display(
                parameters,
                "EQ FrqL",
                effect.low_frequency_hz,
                DisplayUnit::Hertz,
            );
            display(
                parameters,
                "EQ FrqH",
                effect.high_frequency_hz,
                DisplayUnit::Hertz,
            );
            percent(parameters, "EQ Q L", effect.low_q_percent)?;
            percent(parameters, "EQ Q H", effect.high_q_percent)?;
            display(
                parameters,
                "EQ VolL",
                effect.low_gain_db,
                DisplayUnit::Decibels,
            );
            display(
                parameters,
                "EQ VolH",
                effect.high_gain_db,
                DisplayUnit::Decibels,
            );
        }
        if let Some(effect) = &self.filter {
            validate_percent(effect.resonance_percent, "FX filter resonancePercent")?;
            validate_percent(effect.drive_percent, "FX filter drivePercent")?;
            validate_percent(effect.mix_percent, "FX filter mixPercent")?;
            normalized(parameters, "FX Fil On", 1.0);
            choice(parameters, "FX Fil Type", &effect.filter_type);
            display(
                parameters,
                "FX Fil Freq",
                effect.cutoff_hz,
                DisplayUnit::Hertz,
            );
            percent(parameters, "FX Fil Reso", effect.resonance_percent)?;
            percent(parameters, "FX Fil Drive", effect.drive_percent)?;
            percent(parameters, "FX Fil Wet", effect.mix_percent)?;
        }
        if let Some(effect) = &self.reverb {
            for (value, name) in [
                (effect.size_percent, "reverb sizePercent"),
                (effect.low_cut_percent, "reverb lowCutPercent"),
                (effect.high_cut_percent, "reverb highCutPercent"),
                (effect.damp_percent, "reverb dampPercent"),
                (effect.width_percent, "reverb widthPercent"),
                (effect.mix_percent, "reverb mixPercent"),
            ] {
                validate_percent(value, name)?;
            }
            ensure!(
                effect.pre_delay_ms.is_finite() && effect.pre_delay_ms >= 0.0,
                "reverb preDelayMs must be non-negative"
            );
            normalized(parameters, "Rev_On", 1.0);
            percent(parameters, "VerbSize", effect.size_percent)?;
            display(
                parameters,
                "VerbPDly",
                effect.pre_delay_ms,
                DisplayUnit::Milliseconds,
            );
            percent(parameters, "VerbLoCt", effect.low_cut_percent)?;
            percent(parameters, "VerbHiCt", effect.high_cut_percent)?;
            percent(parameters, "VerbDamp", effect.damp_percent)?;
            percent(parameters, "VerbWdth", effect.width_percent)?;
            percent(parameters, "Verb Wet", effect.mix_percent)?;
        }
        Ok(())
    }
}

impl ModulationSpec {
    fn compile(
        &self,
        lfos: &BTreeMap<String, LfoSpec>,
        automations: &mut Vec<ControlAutomation>,
    ) -> Result<()> {
        ensure!(
            !self.source.trim().is_empty(),
            "modulation source cannot be empty"
        );
        ensure!(
            !self.destination.trim().is_empty(),
            "modulation destination cannot be empty"
        );
        let lfo = lfos
            .get(&self.source)
            .with_context(|| format!("modulation source '{}' is not defined", self.source))?;
        let envelope = lfo.compile()?;
        match (&*self.destination, &self.range) {
            ("pitch", ModulationRange::Semitones { minimum, maximum }) => {
                ensure!(*minimum == 0.0, "pitch modulation minimum must be zero");
                automations.push(ControlAutomation::PitchBend {
                    semitones: *maximum,
                    envelope,
                });
            }
            (destination, ModulationRange::Percent { minimum, maximum }) => {
                validate_percent(*minimum, "modulation minimum")?;
                validate_percent(*maximum, "modulation maximum")?;
                automations.push(ControlAutomation::Parameter {
                    name: parameter_destination(destination)?.to_owned(),
                    minimum: ParameterTarget::Normalized(*minimum / 100.0),
                    maximum: ParameterTarget::Normalized(*maximum / 100.0),
                    envelope,
                });
            }
            ("filter.cutoff", ModulationRange::Hertz { minimum, maximum }) => {
                ensure!(
                    *minimum > 0.0 && *maximum > 0.0,
                    "filter automation must be positive"
                );
                automations.push(ControlAutomation::Parameter {
                    name: "Fil Cutoff".to_owned(),
                    minimum: ParameterTarget::Display {
                        value: *minimum,
                        unit: DisplayUnit::Hertz,
                    },
                    maximum: ParameterTarget::Display {
                        value: *maximum,
                        unit: DisplayUnit::Hertz,
                    },
                    envelope,
                });
            }
            _ => anyhow::bail!(
                "modulation destination '{}' does not support the selected range unit",
                self.destination
            ),
        }
        Ok(())
    }
}

impl LfoSpec {
    fn compile(&self) -> Result<AutomationEnvelope> {
        ensure!(
            matches!(self.mode, LfoMode::Envelope),
            "only envelope-mode LFOs are supported"
        );
        ensure!(
            self.rate_hz.is_finite() && self.rate_hz > 0.0,
            "LFO rateHz must be positive"
        );
        ensure!(self.points.len() >= 2, "LFO needs at least two points");
        let mut points = Vec::with_capacity(self.points.len());
        for point in &self.points {
            validate_percent(point.position_percent, "LFO positionPercent")?;
            validate_percent(point.value_percent, "LFO valuePercent")?;
            points.push(AutomationPoint {
                position: point.position_percent / 100.0,
                value: point.value_percent / 100.0,
            });
        }
        ensure!(
            points.first().is_some_and(|point| point.position == 0.0),
            "LFO must start at 0%"
        );
        ensure!(
            points.last().is_some_and(|point| point.position == 1.0),
            "LFO must end at 100%"
        );
        for pair in points.windows(2) {
            ensure!(
                pair[0].position < pair[1].position,
                "LFO points must be ordered"
            );
        }
        Ok(AutomationEnvelope {
            duration_seconds: 1.0 / self.rate_hz,
            points,
        })
    }
}

fn parameter_destination(destination: &str) -> Result<&'static str> {
    match destination {
        "oscillatorA.level" => Ok("A Vol"),
        "oscillatorB.level" => Ok("B Vol"),
        "noise.level" => Ok("Noise Level"),
        "filter.resonance" => Ok("Fil Reso"),
        _ => anyhow::bail!("unsupported percentage modulation destination '{destination}'"),
    }
}

fn validate_template_resources(preset: &Path, resources: &[String]) -> Result<()> {
    if resources.is_empty() {
        return Ok(());
    }
    let data = fs::read(preset)?;
    ensure!(
        data.len() > 60 && &data[8..12] == b"FPCh",
        "template is not a chunk FXP"
    );
    let mut decoder = ZlibDecoder::new(&data[60..]);
    let mut state = Vec::new();
    decoder
        .read_to_end(&mut state)
        .context("failed to decompress Serum template state")?;
    let state = String::from_utf8_lossy(&state);
    for resource in resources {
        ensure!(
            state.contains(resource),
            "template does not contain Serum resource '{resource}'"
        );
    }
    Ok(())
}

fn normalized(parameters: &mut Vec<NamedParameterOverride>, name: &str, value: f32) {
    parameters.push(NamedParameterOverride {
        name: name.to_owned(),
        target: ParameterTarget::Normalized(value),
    });
}

fn mod_parameter_name(slot: u8) -> String {
    if slot < 10 {
        format!("Mod {slot} amt")
    } else {
        format!("Mod{slot} amt")
    }
}

fn percent(parameters: &mut Vec<NamedParameterOverride>, name: &str, value: f32) -> Result<()> {
    validate_percent(value, name)?;
    normalized(parameters, name, value / 100.0);
    Ok(())
}

fn bipolar_percent(
    parameters: &mut Vec<NamedParameterOverride>,
    name: &str,
    value: f32,
) -> Result<()> {
    ensure!(
        value.is_finite() && (-100.0..=100.0).contains(&value),
        "{name} must be -100..100"
    );
    normalized(parameters, name, (value + 100.0) / 200.0);
    Ok(())
}

fn pan(parameters: &mut Vec<NamedParameterOverride>, name: &str, value: f32) -> Result<()> {
    validate_pan(value)?;
    normalized(parameters, name, (value + 100.0) / 200.0);
    Ok(())
}

fn choice(parameters: &mut Vec<NamedParameterOverride>, name: &str, value: &str) {
    parameters.push(NamedParameterOverride {
        name: name.to_owned(),
        target: ParameterTarget::Choice(value.to_owned()),
    });
}

fn display(
    parameters: &mut Vec<NamedParameterOverride>,
    name: &str,
    value: f32,
    unit: DisplayUnit,
) {
    parameters.push(NamedParameterOverride {
        name: name.to_owned(),
        target: ParameterTarget::Display { value, unit },
    });
}

fn validate_percent(value: f32, name: &str) -> Result<()> {
    ensure!(
        value.is_finite() && (0.0..=100.0).contains(&value),
        "{name} must be 0..100"
    );
    Ok(())
}

fn validate_pan(value: f32) -> Result<()> {
    ensure!(
        value.is_finite() && (-100.0..=100.0).contains(&value),
        "pan must be -100..100"
    );
    Ok(())
}

const fn default_master_volume_percent() -> f32 {
    70.0
}
const fn default_level_percent() -> f32 {
    100.0
}
const fn default_noise_pitch_percent() -> f32 {
    50.0
}
const fn default_unison() -> u8 {
    1
}
const fn default_detune_percent() -> f32 {
    25.0
}
const fn default_unison_blend_percent() -> f32 {
    75.0
}
const fn default_filter_stereo_percent() -> f32 {
    50.0
}
const fn default_release_ms() -> f32 {
    15.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percent_controls_use_serums_normalized_scale() {
        let mut parameters = Vec::new();
        percent(&mut parameters, "A Vol", 37.0).expect("valid percent");
        let ParameterTarget::Normalized(value) = parameters[0].target else {
            panic!("normalized target")
        };
        assert!((value - 0.37).abs() < f32::EPSILON);
    }

    #[test]
    fn rejects_out_of_range_modulation() {
        let mut parameters = Vec::new();
        assert!(bipolar_percent(&mut parameters, "Mod 1 amt", 101.0).is_err());
    }

    #[test]
    fn compiles_tutorial_lfo_rate_and_pitch_destination() {
        let lfo = LfoSpec {
            mode: LfoMode::Envelope,
            rate_hz: 25.0,
            points: vec![
                LfoPointSpec {
                    position_percent: 0.0,
                    value_percent: 100.0,
                },
                LfoPointSpec {
                    position_percent: 100.0,
                    value_percent: 0.0,
                },
            ],
        };
        let lfos = BTreeMap::from([("pitchEnvelope".to_owned(), lfo)]);
        let modulation = ModulationSpec {
            source: "pitchEnvelope".to_owned(),
            destination: "pitch".to_owned(),
            range: ModulationRange::Semitones {
                minimum: 0.0,
                maximum: 24.0,
            },
        };
        let mut automations = Vec::new();

        modulation
            .compile(&lfos, &mut automations)
            .expect("pitch modulation");

        let ControlAutomation::PitchBend {
            semitones,
            envelope,
        } = &automations[0]
        else {
            panic!("pitch bend automation")
        };
        assert_eq!(*semitones, 24.0);
        assert!((envelope.duration_seconds - 0.04).abs() < f64::EPSILON);
        assert_eq!(envelope.points[0].value, 1.0);
        assert_eq!(envelope.points[1].value, 0.0);
    }
}
