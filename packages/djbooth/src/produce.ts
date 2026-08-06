import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

import { Cli, z } from "incur";

const MAX_NATIVE_OUTPUT_BYTES = 10 * 1024 * 1024;

const trackOutput = z.object({
  id: z.string(),
  kind: z.string(),
  plugin: z.string().optional(),
  preset: z.string().optional(),
  events: z.number().int().nonnegative(),
  peakDb: z.number(),
});

const renderOutput = z.object({
  title: z.string(),
  output: z.string(),
  stemsDirectory: z.string().optional(),
  bpm: z.number().positive(),
  bars: z.number().int().positive(),
  sampleRate: z.number().int().positive(),
  durationSeconds: z.number().positive(),
  peakDb: z.number(),
  rmsDb: z.number(),
  tracks: z.array(trackOutput),
});

const sourceProfileOutput = z.object({
  path: z.string(),
  peakDb: z.number(),
  rmsDb: z.number(),
  crestFactorDb: z.number(),
  dynamicRangeDb: z.number(),
  silenceRatio: z.number(),
  transientDensityPerSecond: z.number(),
  stereoCorrelation: z.number(),
  stereoWidthDb: z.number(),
  lowBandRatio: z.number(),
  midBandRatio: z.number(),
  highBandRatio: z.number(),
  sixteenthEnergyDb: z.array(z.number()).length(16),
  syncopationRatio: z.number(),
  sectionRmsDb: z.array(z.number()),
});

const referenceProfileOutput = z.object({
  schemaVersion: z.number().int().positive(),
  source: z.string(),
  durationSeconds: z.number().positive(),
  bpm: z.number().positive(),
  firstDownbeatSeconds: z.number().nonnegative(),
  key: z.string(),
  keyConfidence: z.number(),
  bars: z.number().int().nonnegative(),
  phraseCount: z.number().int().nonnegative(),
  phraseLengthHistogram: z.record(z.string(), z.number().int().nonnegative()),
  mix: sourceProfileOutput,
  stems: z.record(z.string(), sourceProfileOutput),
  sections: z.array(
    z.object({
      index: z.number().int().positive(),
      startBeat: z.number().int().positive(),
      startSeconds: z.number().nonnegative(),
      durationBars: z.number().int().nonnegative(),
      kind: z.number().int().nonnegative(),
      energyZ: z.number(),
      lowBandZ: z.number(),
      midBandZ: z.number(),
      highBandZ: z.number(),
      onsetZ: z.number(),
      energyDeltaZ: z.number(),
      distanceFromPrevious: z.number(),
      stemRmsDb: z.record(z.string(), z.number()),
    }),
  ),
  relationships: z.object({
    bassToDrumsRmsDb: z.number().nullable().optional(),
    otherToDrumsRmsDb: z.number().nullable().optional(),
    vocalsToDrumsRmsDb: z.number().nullable().optional(),
    sectionContrastDb: z.number(),
    activeStemsPerSection: z.array(z.number().int().nonnegative()),
  }),
});

const profileComparisonOutput = z.object({
  schemaVersion: z.number().int().positive(),
  referenceProfile: z.string(),
  candidateProfile: z.string(),
  referenceSource: z.string(),
  candidateSource: z.string(),
  overallScore: z.number().min(0).max(100),
  categories: z.record(z.string(), z.number().min(0).max(100)),
  metrics: z.array(
    z.object({
      name: z.string(),
      category: z.string(),
      reference: z.number(),
      candidate: z.number(),
      targetDelta: z.number(),
      unit: z.string(),
      score: z.number().min(0).max(100),
      weight: z.number().positive(),
    }),
  ),
  recommendations: z.array(
    z.object({
      priority: z.enum(["high", "medium", "low"]),
      target: z.string(),
      adjustment: z.number(),
      unit: z.string(),
      instruction: z.string(),
      rationale: z.string(),
    }),
  ),
});

const sampleZoneOutput = z.object({
  name: z.string(),
  relativePath: z.string(),
  resolvedPath: z.string(),
  keyMin: z.number().int(),
  keyMax: z.number().int(),
  velocityMin: z.number().int(),
  velocityMax: z.number().int(),
  selectorMin: z.number().int(),
  selectorMax: z.number().int(),
  rootKey: z.number().int(),
  detuneCents: z.number(),
  volume: z.number(),
});

const rackOutput = z.object({
  source: z.string(),
  coreLibrary: z.string(),
  name: z.string(),
  voices: z.array(
    z.object({
      midiNote: z.number().int(),
      name: z.string(),
      receivingNote: z.number().int(),
      sendingNote: z.number().int(),
      chokeGroup: z.number().int(),
      sampleSelector: z.number().int(),
      gainDb: z.number(),
      volumeVelocityScale: z.number(),
      oneShotFadeOutSeconds: z.number(),
      samples: z.array(sampleZoneOutput),
      selectedSamples: z.array(z.string()),
    }),
  ),
});

const graphParameterOutput = z.object({
  name: z.string(),
  value: z.string(),
  numericValue: z.number().nullable(),
  minimum: z.number().nullable(),
  maximum: z.number().nullable(),
  automationTargetId: z.string().nullable(),
  modulationTargetId: z.string().nullable(),
  midiMapping: z
    .object({
      persistentKey: z.string(),
      isNote: z.boolean(),
      channel: z.number().int(),
      noteOrController: z.number().int(),
      lowerNote: z.number().int(),
      upperNote: z.number().int(),
      mapMode: z.number().int(),
    })
    .nullable(),
});

type GraphDevice = {
  id: string | null;
  sourceOffset: number;
  family: string;
  name: string;
  enabled: boolean | null;
  parameters: z.infer<typeof graphParameterOutput>[];
  rack: RackGraph | null;
};

type RackGraph = {
  kind: string;
  visibleMacros: number;
  chainSelector: z.infer<typeof graphParameterOutput> | null;
  macros: Array<{
    index: number;
    name: string;
    value: string;
    numericValue: number | null;
    defaultValue: number | null;
    minimum: number | null;
    maximum: number | null;
    color: number | null;
    annotation: string;
    automationTargetId: string | null;
    modulationTargetId: string | null;
    excludedFromRandomization: boolean;
    excludedFromSnapshots: boolean;
  }>;
  chains: RackChain[];
  returnChains: RackChain[];
};

type RackChain = {
  id: string | null;
  name: string;
  soloed: boolean;
  selector: {
    minimum: number;
    maximum: number;
    crossfadeMinimum: number;
    crossfadeMaximum: number;
  } | null;
  receivingNote: number | null;
  sendingNote: number | null;
  chokeGroup: number | null;
  devices: GraphDevice[];
  mixer: GraphDevice | null;
};

const graphDeviceOutput: z.ZodType<GraphDevice> = z.lazy(() =>
  z.object({
    id: z.string().nullable(),
    sourceOffset: z.number().int().nonnegative(),
    family: z.string(),
    name: z.string(),
    enabled: z.boolean().nullable(),
    parameters: z.array(graphParameterOutput),
    rack: rackGraphOutput.nullable(),
  }),
);

const rackChainOutput: z.ZodType<RackChain> = z.lazy(() =>
  z.object({
    id: z.string().nullable(),
    name: z.string(),
    soloed: z.boolean(),
    selector: z
      .object({
        minimum: z.number(),
        maximum: z.number(),
        crossfadeMinimum: z.number(),
        crossfadeMaximum: z.number(),
      })
      .nullable(),
    receivingNote: z.number().int().nullable(),
    sendingNote: z.number().int().nullable(),
    chokeGroup: z.number().int().nullable(),
    devices: z.array(graphDeviceOutput),
    mixer: graphDeviceOutput.nullable(),
  }),
);

const rackGraphOutput: z.ZodType<RackGraph> = z.lazy(() =>
  z.object({
    kind: z.string(),
    visibleMacros: z.number().int().nonnegative(),
    chainSelector: graphParameterOutput.nullable(),
    macros: z.array(
      z.object({
        index: z.number().int().nonnegative(),
        name: z.string(),
        value: z.string(),
        numericValue: z.number().nullable(),
        defaultValue: z.number().nullable(),
        minimum: z.number().nullable(),
        maximum: z.number().nullable(),
        color: z.number().int().nullable(),
        annotation: z.string(),
        automationTargetId: z.string().nullable(),
        modulationTargetId: z.string().nullable(),
        excludedFromRandomization: z.boolean(),
        excludedFromSnapshots: z.boolean(),
      }),
    ),
    chains: z.array(rackChainOutput),
    returnChains: z.array(rackChainOutput),
  }),
);

const deviceGraphOutput = z.object({
  source: z.string(),
  name: z.string(),
  format: z.string(),
  roots: z.array(graphDeviceOutput),
  devices: z.number().int().positive(),
  racks: z.number().int().nonnegative(),
  chains: z.number().int().nonnegative(),
  parameters: z.number().int().nonnegative(),
  macroMappings: z.number().int().nonnegative(),
  customDsp: z.literal(false),
});

const deviceGraphAuditOutput = z.object({
  coreLibrary: z.string(),
  assets: z.number().int().nonnegative(),
  parsedAssets: z.number().int().nonnegative(),
  failedAssets: z.array(
    z.object({
      asset: z.string(),
      error: z.string(),
    }),
  ),
  devices: z.number().int().nonnegative(),
  racks: z.number().int().nonnegative(),
  chains: z.number().int().nonnegative(),
  parameters: z.number().int().nonnegative(),
  macroMappings: z.number().int().nonnegative(),
  completeFamilies: z.number().int().nonnegative(),
  partialFamilies: z.number().int().nonnegative(),
  blockedFamilies: z.number().int().nonnegative(),
  deviceFamilies: z.array(
    z.object({
      family: z.string(),
      instances: z.number().int().positive(),
      mechanism: z.string(),
      engineStatus: z.string(),
      presetStatus: z.string(),
      headlessStatus: z.string(),
      implementation: z.string().nullable(),
      blocker: z.string().nullable(),
    }),
  ),
  customDsp: z.literal(false),
});

const presetAuditOutput = z.object({
  coreLibrary: z.string(),
  engine: z.string(),
  installedPresets: z.number().int().nonnegative(),
  eligiblePresets: z.number().int().nonnegative(),
  testedPresets: z.number().int().nonnegative(),
  renderedPresets: z.number().int().nonnegative(),
  audiblePresets: z.number().int().nonnegative(),
  silentPresets: z.array(
    z.object({
      asset: z.string(),
      family: z.string(),
      processor: z.string(),
      peak: z.number().nonnegative(),
    }),
  ),
  failedPresets: z.array(
    z.object({
      asset: z.string(),
      family: z.string(),
      processor: z.string(),
      exitCode: z.number().int().nullable(),
      error: z.string(),
    }),
  ),
  skippedFamilies: z.array(
    z.object({
      family: z.string(),
      presets: z.number().int().nonnegative(),
      reason: z.string(),
    }),
  ),
  familyResults: z.array(
    z.object({
      family: z.string(),
      processor: z.string(),
      tested: z.number().int().positive(),
      rendered: z.number().int().nonnegative(),
      audible: z.number().int().nonnegative(),
      silent: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
      minimumParametersApplied: z.number().int().nonnegative(),
      maximumParametersApplied: z.number().int().nonnegative(),
      maximumPeak: z.number().nonnegative(),
      maximumDelta: z.number().nonnegative(),
    }),
  ),
  exhaustive: z.boolean(),
  jobs: z.number().int().positive(),
  customDsp: z.literal(false),
});

const clipOutput = z.object({
  source: z.string(),
  name: z.string(),
  bpm: z.number().positive(),
  loopStart: z.number(),
  loopEnd: z.number(),
  notes: z.array(
    z.object({
      beat: z.number(),
      durationBeats: z.number().positive(),
      note: z.number().int(),
      velocity: z.number().int(),
      offVelocity: z.number().int(),
    }),
  ),
});

const grooveOutput = z.object({
  source: z.string(),
  name: z.string(),
  loopStart: z.number(),
  loopEnd: z.number(),
  grid: z.number().int(),
  quantizationAmount: z.number(),
  timingAmount: z.number(),
  randomAmount: z.number(),
  velocityAmount: z.number(),
  events: z.array(z.object({ beat: z.number(), velocity: z.number().int() })),
});

const importOutput = z.object({
  output: z.string(),
  rack: z.string(),
  clip: z.string(),
  tracks: z.number().int().positive(),
  events: z.number().int().positive(),
});

const transcriptionOutput = z.object({
  audioSeconds: z.number().nonnegative(),
  backend: z.literal("mlx"),
  chunks: z.number().int().nonnegative(),
  events: z.string(),
  generationSeconds: z.number().nonnegative(),
  instruments: z.array(z.string()).nullable(),
  model: z.string(),
  notes: z.number().int().nonnegative(),
  rawNotes: z.number().int().nonnegative(),
  output: z.string(),
  realtimeFactor: z.number().nonnegative(),
  totalSeconds: z.number().nonnegative(),
});

const assetOutput = z.object({
  path: z.string(),
  relativePath: z.string(),
  kind: z.string(),
  name: z.string(),
  devices: z.array(z.string()),
  references: z.array(z.string()),
  sampleFiles: z.number().int().nonnegative(),
  midiNotes: z.number().int().nonnegative(),
  renderability: z.string(),
});

const libraryOutput = z.object({
  coreLibrary: z.string(),
  scanned: z.number().int().nonnegative(),
  matched: z.number().int().nonnegative(),
  assets: z.array(assetOutput),
});

const abletonCapabilitiesOutput = z.object({
  coreLibrary: z.string(),
  libraryAssets: z.number().int().nonnegative(),
  deviceFamilies: z.number().int().nonnegative(),
  compiledMaxObjects: z.number().int().nonnegative(),
  standaloneNativeBundles: z.number().int().nonnegative(),
  completeFamilies: z.number().int().nonnegative(),
  partialFamilies: z.number().int().nonnegative(),
  blockedFamilies: z.number().int().nonnegative(),
  families: z.array(
    z.object({
      family: z.string(),
      libraryAssets: z.number().int().nonnegative(),
      mechanism: z.string(),
      engineStatus: z.string(),
      presetStatus: z.string(),
      headlessStatus: z.string(),
      implementation: z.string().nullable().optional(),
      blocker: z.string().nullable().optional(),
      customDsp: z.boolean(),
    }),
  ),
});

const abletonEngineProbeOutput = z.object({
  engine: z.string(),
  engineSha256: z.string(),
  abiProfile: z.string().nullable(),
  loadedImage: z.string(),
  hostArchitecture: z.string(),
  vmaddrSlide: z.number().int(),
  loadable: z.boolean(),
  registryInitialized: z.boolean(),
  initExitFunctions: z.number().int().nonnegative(),
  registryEntries: z.number().int().nonnegative(),
  engineCreated: z.boolean(),
  sampleRate: z.number().int().positive(),
  bufferSize: z.number().int().positive(),
  audioCycleDriven: z.boolean(),
  audioPeak: z.number().nonnegative(),
  processor: z.string().nullable(),
  processorRegistered: z.boolean(),
  processorConstructed: z.boolean(),
  processorFactoryFunction: z.string().nullable(),
  processorCalcFunction: z.string().nullable(),
  processorGraph: z.string().nullable(),
  processorGraphAttached: z.boolean(),
  processorGraphEntries: z.number().int().nonnegative(),
  processorGraphExecutionFunction: z.string().nullable(),
  processorPreset: z.string().nullable(),
  presetParametersApplied: z.number().int().nonnegative(),
  appliedParameters: z.array(
    z.object({
      name: z.string(),
      value: z.number(),
      callback: z.string(),
    }),
  ),
  appliedMidiEvents: z.array(
    z.object({
      kind: z.enum(["noteOn", "noteOff"]),
      note: z.number().int().min(0).max(127),
      velocity: z.number().int().min(0).max(127),
      noteId: z.number().int().nonnegative(),
      sampleOffset: z.number().int().nonnegative(),
      callback: z.string(),
    }),
  ),
  processorRenderPeak: z.number().nonnegative(),
  processorRenderDelta: z.number().nonnegative(),
  processorRenderFrames: z.number().int().nonnegative(),
  processorRenderOutput: z.string().nullable(),
  registeredProcessors: z.array(z.string()),
  registeredPorts: z.number().int().nonnegative(),
  processorSchemas: z.array(
    z.object({
      name: z.string(),
      createMessageId: z.number().int().nonnegative(),
      createMessageData: z.string(),
      factoryFunction: z.string().nullable(),
      createMembers: z.array(
        z.object({
          name: z.string(),
          typeId: z.number().int().nonnegative(),
          arrayCount: z.number().int().nonnegative(),
          byteOffset: z.number().int().nonnegative(),
        }),
      ),
      headerWords: z.array(z.string()),
      initialCalcFunction: z.string().nullable(),
      changeAudioDataOffset: z.number().int(),
      audioProcessor: z.boolean(),
      processorType: z.number().int().nonnegative(),
      processorRate: z.number().int().nonnegative(),
      ports: z.array(
        z.object({
          name: z.string(),
          kind: z.string(),
          kindId: z.number().int().nonnegative(),
          rawU32A: z.number().int().nonnegative(),
          rawU32B: z.number().int().nonnegative(),
          rawU64A: z.string(),
          rawU64B: z.string(),
        }),
      ),
    }),
  ),
  recoveredDevices: z.array(z.string()),
  customDsp: z.boolean(),
});

const abletonEngineAuditOutput = z.object({
  engine: z.string(),
  engineSha256: z.string(),
  registeredProcessors: z.number().int().nonnegative(),
  constructedProcessors: z.number().int().nonnegative(),
  failedProcessors: z.array(
    z.object({
      processor: z.string(),
      exitCode: z.number().int().nullable(),
      error: z.string().nullable(),
    }),
  ),
  renderAttempted: z.boolean(),
  renderableProcessors: z.number().int().nonnegative(),
  renderedProcessors: z.number().int().nonnegative(),
  renderedProcessorNames: z.array(z.string()),
  failedRenders: z.array(
    z.object({
      processor: z.string(),
      exitCode: z.number().int().nullable(),
      error: z.string().nullable(),
    }),
  ),
  jobs: z.number().int().positive(),
  customDsp: z.boolean(),
});

const instrumentOutput = z.object({
  source: z.string(),
  coreLibrary: z.string(),
  name: z.string(),
  layers: z.array(
    z.object({
      name: z.string(),
      device: z.string(),
      gainDb: z.number(),
      pan: z.number(),
      velocityAmount: z.number(),
      attackSeconds: z.number().nonnegative(),
      decaySeconds: z.number().nonnegative(),
      sustainLevel: z.number().nonnegative(),
      releaseSeconds: z.number().nonnegative(),
      zones: z.array(sampleZoneOutput),
    }),
  ),
  unsupportedDevices: z.array(z.string()),
});

export const produceCli = Cli.create("produce", {
  description:
    "Render declarative multitrack productions through Serum and native DSP without opening a DAW.",
  hint: "Describe notes, drum triggers, Serum parameters, sidechain and mix settings in JSON, then render a master and optional stems offline.",
  mcp: {
    instructions:
      "Use render for deterministic offline production. The native x86_64 host loads the installed Serum VST2 plug-in directly; no Ableton or other DAW process is involved.",
  },
});

const abletonCli = Cli.create("ableton", {
  description: "Inspect and import Ableton ADG racks and ALC MIDI clips without launching Live.",
  hint: "Resolve Core Library rack references, sample zones, Simpler settings and MIDI events into the declarative renderer.",
});

produceCli.command(abletonCli);

abletonCli.command("capabilities", {
  description:
    "Map every installed Ableton device family to its headless native bundle, engine processor, Max object or rack/sample implementation.",
  options: z.object({
    binary: z.string().optional().describe("Native x86_64 djbooth-rs helper override"),
    coreLibrary: z.string().optional().describe("Ableton Core Library root override"),
    maxContents: z.string().optional().describe("Bundled Max.app Contents root override"),
    devicesRoot: z.string().optional().describe("Standalone Ableton device bundles root override"),
  }),
  output: abletonCapabilitiesOutput,
  async run(context) {
    const args = [
      "ableton",
      "capabilities",
      ...(context.options.coreLibrary
        ? ["--core-library", resolveInvocationPath(context.options.coreLibrary)]
        : []),
      ...(context.options.maxContents
        ? ["--max-contents", resolveInvocationPath(context.options.maxContents)]
        : []),
      ...(context.options.devicesRoot
        ? ["--devices-root", resolveInvocationPath(context.options.devicesRoot)]
        : []),
    ];
    return abletonCapabilitiesOutput.parse(
      await runNative(resolveProducerBinary(context.options.binary), args),
    );
  },
});

abletonCli.command("probe-engine", {
  description:
    "Boot Ableton's real Live Engine bundle headlessly, enumerate its processor registry and drive one native audio cycle.",
  options: z.object({
    binary: z.string().optional().describe("Native x86_64 djbooth-rs helper override"),
    engine: z.string().optional().describe("Ableton Live Engine executable override"),
    processor: z.string().optional().describe("Exact internal processor name to verify"),
    construct: z.boolean().default(false).describe("Construct the selected Ableton processor"),
    parameter: z
      .array(z.string().min(3))
      .default([])
      .describe("Native float event input as NAME=VALUE; repeat for multiple parameters"),
    note: z.number().int().min(0).max(127).optional().describe("Native MIDI note to render"),
    sequence: z.string().optional().describe("JSON note sequence for the native InMidi port"),
    velocity: z.number().int().min(1).max(127).default(100),
    gateSeconds: z.number().positive().finite().default(0.5),
    renderFrames: z.number().int().positive().optional().describe("Optional audit render limit"),
    input: z.string().optional().describe("Stereo 44.1 kHz WAV to process"),
    sample: z.string().optional().describe("WAV to bind to native Ableton Drum Sampler"),
    preset: z.string().optional().describe("Ableton ADV preset to apply through native ports"),
    presetDeviceOffset: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe("Nested ADG device byte offset to apply"),
    output: z.string().optional().describe("Destination WAV for processor output"),
  }),
  output: abletonEngineProbeOutput,
  async run(context) {
    const args = [
      "ableton",
      "probe-live-engine",
      "--bootstrap",
      ...(context.options.engine
        ? ["--engine", resolveInvocationPath(context.options.engine)]
        : []),
      ...(context.options.processor ? ["--processor", context.options.processor] : []),
      ...(context.options.construct ? ["--construct"] : []),
      ...context.options.parameter.flatMap((parameter) => ["--parameter", parameter]),
      ...(context.options.note === undefined ? [] : ["--note", String(context.options.note)]),
      ...(context.options.sequence
        ? ["--sequence", resolveInvocationPath(context.options.sequence)]
        : []),
      "--velocity",
      String(context.options.velocity),
      "--gate-seconds",
      String(context.options.gateSeconds),
      ...(context.options.renderFrames === undefined
        ? []
        : ["--render-frames", String(context.options.renderFrames)]),
      ...(context.options.input ? ["--input", resolveInvocationPath(context.options.input)] : []),
      ...(context.options.sample
        ? ["--sample", resolveInvocationPath(context.options.sample)]
        : []),
      ...(context.options.preset
        ? ["--preset", resolveInvocationPath(context.options.preset)]
        : []),
      ...(context.options.presetDeviceOffset === undefined
        ? []
        : ["--preset-device-offset", String(context.options.presetDeviceOffset)]),
      ...(context.options.output
        ? ["--output", resolveInvocationPath(context.options.output)]
        : []),
    ];
    return abletonEngineProbeOutput.parse(
      await runNative(resolveProducerBinary(context.options.binary), args),
    );
  },
});

abletonCli.command("audit-engine", {
  description:
    "Crash-isolate every registered Ableton Live Engine processor and optionally render every audio input/output topology.",
  options: z.object({
    binary: z.string().optional().describe("Native x86_64 djbooth-rs helper override"),
    engine: z.string().optional().describe("Ableton Live Engine executable override"),
    jobs: z.number().int().positive().max(32).default(8),
    render: z.boolean().default(false).describe("Render every detected native audio processor"),
  }),
  output: abletonEngineAuditOutput,
  async run(context) {
    const args = [
      "ableton",
      "audit-live-engine",
      "--jobs",
      String(context.options.jobs),
      ...(context.options.render ? ["--render"] : []),
      ...(context.options.engine
        ? ["--engine", resolveInvocationPath(context.options.engine)]
        : []),
    ];
    return abletonEngineAuditOutput.parse(
      await runNative(resolveProducerBinary(context.options.binary), args),
    );
  },
});

abletonCli.command("library", {
  description: "Search installed ADG, ALC, ADV and AGR assets with headless compatibility data.",
  options: z.object({
    binary: z.string().optional().describe("Native djbooth-rs helper override"),
    coreLibrary: z.string().optional().describe("Ableton Core Library root override"),
    query: z.string().optional().describe("Case-insensitive asset path query"),
    kind: z.enum(["adg", "alc", "adv", "agr"]).optional(),
    limit: z.number().int().positive().max(10_000).default(100),
  }),
  output: libraryOutput,
  async run(context) {
    const args = [
      "ableton",
      "library",
      ...(context.options.coreLibrary
        ? ["--core-library", resolveInvocationPath(context.options.coreLibrary)]
        : []),
      ...(context.options.query ? ["--query", context.options.query] : []),
      ...(context.options.kind ? ["--kind", context.options.kind] : []),
      "--limit",
      String(context.options.limit),
    ];
    return libraryOutput.parse(
      await runNative(resolveProducerBinary(context.options.binary), args),
    );
  },
});

abletonCli.command("inspect-asset", {
  description: "Inspect devices, preset references, sample count and compatibility of any asset.",
  args: z.object({ asset: z.string().min(1).describe("ADG, ALC, ADV or AGR asset") }),
  options: z.object({
    binary: z.string().optional().describe("Native djbooth-rs helper override"),
  }),
  output: assetOutput,
  async run(context) {
    return assetOutput.parse(
      await runNative(resolveProducerBinary(context.options.binary), [
        "ableton",
        "inspect-asset",
        resolveInvocationPath(context.args.asset),
      ]),
    );
  },
});

abletonCli.command("inspect-rack", {
  description: "Inspect an Ableton ADG drum rack and resolve its selected Core Library samples.",
  args: z.object({ rack: z.string().min(1).describe("Ableton ADG drum rack") }),
  options: z.object({
    binary: z.string().optional().describe("Native djbooth-rs helper override"),
    coreLibrary: z.string().optional().describe("Ableton Core Library root override"),
  }),
  output: rackOutput,
  async run(context) {
    const args = [
      "ableton",
      "inspect-rack",
      resolveInvocationPath(context.args.rack),
      ...(context.options.coreLibrary
        ? ["--core-library", resolveInvocationPath(context.options.coreLibrary)]
        : []),
    ];
    return rackOutput.parse(await runNative(resolveProducerBinary(context.options.binary), args));
  },
});

abletonCli.command("inspect-device-graph", {
  description:
    "Inspect complete ADV/ADG device order, nested racks, macros, mappings, chain zones, mixers, sends and parameters.",
  args: z.object({ asset: z.string().min(1).describe("Ableton ADV or ADG asset") }),
  options: z.object({
    binary: z.string().optional().describe("Native djbooth-rs helper override"),
  }),
  output: deviceGraphOutput,
  async run(context) {
    return deviceGraphOutput.parse(
      await runNative(resolveProducerBinary(context.options.binary), [
        "ableton",
        "inspect-device-graph",
        resolveInvocationPath(context.args.asset),
      ]),
    );
  },
});

abletonCli.command("audit-device-graphs", {
  description:
    "Parse every installed ADV and ADG, aggregate the complete graph surface, and report every incompatible asset.",
  options: z.object({
    binary: z.string().optional().describe("Native djbooth-rs helper override"),
    coreLibrary: z.string().optional().describe("Ableton Core Library root override"),
  }),
  output: deviceGraphAuditOutput,
  async run(context) {
    const args = [
      "ableton",
      "audit-device-graphs",
      ...(context.options.coreLibrary
        ? ["--core-library", resolveInvocationPath(context.options.coreLibrary)]
        : []),
    ];
    return deviceGraphAuditOutput.parse(
      await runNative(resolveProducerBinary(context.options.binary), args),
    );
  },
});

abletonCli.command("audit-presets", {
  description:
    "Crash-isolate installed ADV presets on their mapped native Live Engine processors, with representative or exhaustive coverage.",
  options: z.object({
    binary: z.string().optional().describe("Native x86_64 djbooth-rs helper override"),
    coreLibrary: z.string().optional().describe("Ableton Core Library root override"),
    engine: z.string().optional().describe("Ableton Live Engine executable override"),
    jobs: z.number().int().positive().max(32).default(8),
    all: z.boolean().default(false).describe("Test every eligible installed ADV preset"),
  }),
  output: presetAuditOutput,
  async run(context) {
    const args = [
      "ableton",
      "audit-presets",
      "--jobs",
      String(context.options.jobs),
      ...(context.options.all ? ["--all"] : []),
      ...(context.options.coreLibrary
        ? ["--core-library", resolveInvocationPath(context.options.coreLibrary)]
        : []),
      ...(context.options.engine
        ? ["--engine", resolveInvocationPath(context.options.engine)]
        : []),
    ];
    return presetAuditOutput.parse(
      await runNative(resolveProducerBinary(context.options.binary), args),
    );
  },
});

abletonCli.command("inspect-clip", {
  description: "Inspect tempo, loop bounds and MIDI notes in an Ableton ALC clip.",
  args: z.object({ clip: z.string().min(1).describe("Ableton ALC MIDI clip") }),
  options: z.object({
    binary: z.string().optional().describe("Native djbooth-rs helper override"),
  }),
  output: clipOutput,
  async run(context) {
    return clipOutput.parse(
      await runNative(resolveProducerBinary(context.options.binary), [
        "ableton",
        "inspect-clip",
        resolveInvocationPath(context.args.clip),
      ]),
    );
  },
});

abletonCli.command("inspect-groove", {
  description: "Inspect timing, velocity and grid data in an XML Ableton AGR groove.",
  args: z.object({ groove: z.string().min(1).describe("Ableton AGR groove") }),
  options: z.object({
    binary: z.string().optional().describe("Native djbooth-rs helper override"),
  }),
  output: grooveOutput,
  async run(context) {
    return grooveOutput.parse(
      await runNative(resolveProducerBinary(context.options.binary), [
        "ableton",
        "inspect-groove",
        resolveInvocationPath(context.args.groove),
      ]),
    );
  },
});

abletonCli.command("inspect-instrument", {
  description: "Inspect Simpler and Sampler layers, zones, loops and envelopes in an ADG rack.",
  args: z.object({ instrument: z.string().min(1).describe("Ableton ADG instrument rack") }),
  options: z.object({
    binary: z.string().optional().describe("Native djbooth-rs helper override"),
    coreLibrary: z.string().optional().describe("Ableton Core Library root override"),
  }),
  output: instrumentOutput,
  async run(context) {
    const args = [
      "ableton",
      "inspect-instrument",
      resolveInvocationPath(context.args.instrument),
      ...(context.options.coreLibrary
        ? ["--core-library", resolveInvocationPath(context.options.coreLibrary)]
        : []),
    ];
    return instrumentOutput.parse(
      await runNative(resolveProducerBinary(context.options.binary), args),
    );
  },
});

abletonCli.command("import-drum-clip", {
  description: "Convert an ALC clip and its referenced ADG rack to a renderable song JSON.",
  args: z.object({
    clip: z.string().min(1).describe("Ableton ALC MIDI clip"),
    output: z.string().min(1).describe("Destination song JSON"),
  }),
  options: z.object({
    binary: z.string().optional().describe("Native djbooth-rs helper override"),
    rack: z.string().optional().describe("Optional explicit ADG rack override"),
    coreLibrary: z.string().optional().describe("Ableton Core Library root override"),
    groove: z.string().optional().describe("Optional XML AGR groove template"),
    repeats: z.number().int().positive().default(1),
    sampleRate: z.number().int().min(8_000).max(384_000).default(44_100),
  }),
  output: importOutput,
  async run(context) {
    const args = [
      "ableton",
      "import-drum-clip",
      resolveInvocationPath(context.args.clip),
      resolveInvocationPath(context.args.output),
      "--repeats",
      String(context.options.repeats),
      "--sample-rate",
      String(context.options.sampleRate),
      ...(context.options.rack ? ["--rack", resolveInvocationPath(context.options.rack)] : []),
      ...(context.options.coreLibrary
        ? ["--core-library", resolveInvocationPath(context.options.coreLibrary)]
        : []),
      ...(context.options.groove
        ? ["--groove", resolveInvocationPath(context.options.groove)]
        : []),
    ];
    return importOutput.parse(await runNative(resolveProducerBinary(context.options.binary), args));
  },
});

abletonCli.command("import-midi-clip", {
  description: "Render a tonal ALC through its referenced or an explicitly selected sample ADG.",
  args: z.object({
    clip: z.string().min(1).describe("Ableton ALC MIDI clip"),
    output: z.string().min(1).describe("Destination song JSON"),
  }),
  options: z.object({
    binary: z.string().optional().describe("Native djbooth-rs helper override"),
    instrument: z.string().optional().describe("Optional sample-based ADG instrument override"),
    coreLibrary: z.string().optional().describe("Ableton Core Library root override"),
    groove: z.string().optional().describe("Optional XML AGR groove template"),
    repeats: z.number().int().positive().default(1),
    sampleRate: z.number().int().min(8_000).max(384_000).default(44_100),
  }),
  output: importOutput,
  async run(context) {
    const args = [
      "ableton",
      "import-midi-clip",
      resolveInvocationPath(context.args.clip),
      resolveInvocationPath(context.args.output),
      "--repeats",
      String(context.options.repeats),
      "--sample-rate",
      String(context.options.sampleRate),
      ...(context.options.instrument
        ? ["--instrument", resolveInvocationPath(context.options.instrument)]
        : []),
      ...(context.options.coreLibrary
        ? ["--core-library", resolveInvocationPath(context.options.coreLibrary)]
        : []),
      ...(context.options.groove
        ? ["--groove", resolveInvocationPath(context.options.groove)]
        : []),
    ];
    return importOutput.parse(await runNative(resolveProducerBinary(context.options.binary), args));
  },
});

produceCli.command("transcribe", {
  description:
    "Extract a per-instrument MIDI skeleton and structured note events from audio with MuScriptor-large on MLX.",
  hint: "Run this on separated stems, then combine its note, timing and articulation evidence with reference-profile timbre, groove, dynamics and arrangement targets before rendering.",
  args: z.object({
    audio: z.string().min(1).describe("Source mix or separated stem audio"),
    output: z.string().min(1).describe("Destination multitrack MIDI file"),
  }),
  options: z.object({
    pythonProjectDirectory: z
      .string()
      .optional()
      .describe("Standalone muscriptor-mlx Python project override"),
    cacheDirectory: z.string().optional().describe("MuScriptor-large model cache override"),
    events: z.string().optional().describe("Structured note-event JSON destination"),
    start: z.number().nonnegative().default(0),
    duration: z.number().positive().optional(),
    instrument: z
      .array(z.string().min(1))
      .default([])
      .describe("Hard instrument-group constraint; repeat for multiple groups"),
    maxTokens: z.number().int().positive().max(2_000).default(2_000),
    tempo: z.number().positive().default(120),
  }),
  output: transcriptionOutput,
  async run(context) {
    const project = resolveMuscriptorProject(context.options.pythonProjectDirectory);
    const args = [
      "run",
      "--project",
      project,
      "--python",
      "3.12",
      "djbooth-muscriptor-mlx",
      "transcribe",
      resolveInvocationPath(context.args.audio),
      "--output",
      resolveInvocationPath(context.args.output),
      "--start",
      String(context.options.start),
      "--max-tokens",
      String(context.options.maxTokens),
      "--tempo",
      String(context.options.tempo),
      ...(context.options.duration ? ["--duration", String(context.options.duration)] : []),
      ...(context.options.cacheDirectory
        ? ["--cache-directory", resolveInvocationPath(context.options.cacheDirectory)]
        : []),
      ...(context.options.events
        ? ["--events", resolveInvocationPath(context.options.events)]
        : []),
      ...context.options.instrument.flatMap((instrument) => ["--instrument", instrument]),
    ];
    return transcriptionOutput.parse(await runJsonCommand("uv", args));
  },
});

produceCli.command("reference-profile", {
  description:
    "Extract groove, timbre, dynamics, stereo, arrangement and stem-balance targets from a reference track.",
  args: z.object({
    audio: z.string().min(1).describe("Reference mix audio file"),
  }),
  options: z.object({
    binary: z.string().optional().describe("Native djbooth-rs helper override"),
    stem: z
      .array(z.string().min(3))
      .default([])
      .describe("Named separated source as NAME=PATH; repeat for multiple stems"),
    output: z.string().optional().describe("Optional destination profile JSON"),
  }),
  output: referenceProfileOutput,
  async run(context) {
    const args = [
      "produce",
      "reference-profile",
      resolveInvocationPath(context.args.audio),
      ...context.options.stem.flatMap((stem) => {
        const separator = stem.indexOf("=");
        if (separator < 1) throw new Error(`--stem must use NAME=PATH, received '${stem}'`);
        return [
          "--stem",
          `${stem.slice(0, separator)}=${resolveInvocationPath(stem.slice(separator + 1))}`,
        ];
      }),
      ...(context.options.output
        ? ["--output", resolveInvocationPath(context.options.output)]
        : []),
    ];
    return referenceProfileOutput.parse(
      await runNative(resolveProducerBinary(context.options.binary), args),
    );
  },
});

produceCli.command("profile-compare", {
  description:
    "Score a candidate production-taste profile against a reference and return actionable mix, groove, timbre and arrangement deltas.",
  args: z.object({
    reference: z.string().min(1).describe("Reference profile JSON"),
    candidate: z.string().min(1).describe("Candidate profile JSON"),
  }),
  options: z.object({
    binary: z.string().optional().describe("Native djbooth-rs helper override"),
    output: z.string().optional().describe("Optional destination comparison JSON"),
  }),
  output: profileComparisonOutput,
  async run(context) {
    const args = [
      "produce",
      "profile-compare",
      resolveInvocationPath(context.args.reference),
      resolveInvocationPath(context.args.candidate),
      ...(context.options.output
        ? ["--output", resolveInvocationPath(context.options.output)]
        : []),
    ];
    return profileComparisonOutput.parse(
      await runNative(resolveProducerBinary(context.options.binary), args),
    );
  },
});

produceCli.command("render", {
  description: "Render one JSON song specification to a stereo WAV and optional per-track stems.",
  args: z.object({
    spec: z.string().min(1).describe("Song specification JSON"),
    output: z.string().min(1).describe("Destination stereo WAV"),
  }),
  options: z.object({
    binary: z.string().optional().describe("Native x86_64 djbooth-rs helper override"),
    serumPlugin: z.string().optional().describe("Serum VST2 binary override"),
    serumPresets: z.string().optional().describe("Serum preset root override"),
    blockSize: z.number().int().positive().max(8_192).default(512),
    stems: z.string().optional().describe("Optional directory for processed track stems"),
    play: z.boolean().default(false).describe("Play the completed WAV with afplay"),
  }),
  output: renderOutput,
  examples: [
    {
      args: {
        spec: "examples/production/westend-core.json",
        output: "/tmp/westend-core.wav",
      },
      options: { stems: "/tmp/westend-core-stems", play: true },
      description: "Render and audition the bundled 126 BPM tech-house core loop",
    },
  ],
  async run(context) {
    const binary = resolveProducerBinary(context.options.binary);
    const args = [
      "produce",
      "render",
      resolveInvocationPath(context.args.spec),
      resolveInvocationPath(context.args.output),
      "--block-size",
      String(context.options.blockSize),
      ...(context.options.serumPlugin
        ? ["--serum-plugin", resolveInvocationPath(context.options.serumPlugin)]
        : []),
      ...(context.options.serumPresets
        ? ["--serum-presets", resolveInvocationPath(context.options.serumPresets)]
        : []),
      ...(context.options.stems ? ["--stems", resolveInvocationPath(context.options.stems)] : []),
      ...(context.options.play ? ["--play"] : []),
    ];
    return renderOutput.parse(await runNative(binary, args));
  },
});

export function resolveProducerBinary(override?: string): string {
  const explicitCandidates = [
    override ? resolveInvocationPath(override) : undefined,
    process.env.DJBOOTH_RS_BIN,
    resolve(import.meta.dirname, "../native-bin/djbooth-rs"),
  ].filter((candidate): candidate is string => Boolean(candidate));
  const explicitBinary = explicitCandidates.find((candidate) => existsSync(candidate));
  if (explicitBinary) return explicitBinary;
  const buildCandidates = [
    resolve(import.meta.dirname, "../../../rust/target/x86_64-apple-darwin/release/djbooth-rs"),
    resolve(import.meta.dirname, "../../../rust/target/x86_64-apple-darwin/debug/djbooth-rs"),
  ]
    .filter((candidate) => existsSync(candidate))
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
  const binary = buildCandidates[0];
  if (binary) return binary;
  throw new Error(
    "x86_64 djbooth-rs producer is missing; build it with `cargo build --manifest-path rust/Cargo.toml --target x86_64-apple-darwin -p djbooth-rs`",
  );
}

function resolveMuscriptorProject(override?: string): string {
  const candidates = [
    override ? resolveInvocationPath(override) : undefined,
    process.env.DJBOOTH_MUSCRIPTOR_MLX_PROJECT,
    resolve(import.meta.dirname, "../../../python/muscriptor-mlx"),
  ].filter((candidate): candidate is string => Boolean(candidate));
  const project = candidates.find((candidate) => existsSync(resolve(candidate, "pyproject.toml")));
  if (project) return project;
  throw new Error(
    "muscriptor-mlx Python project is missing; pass --python-project-directory or set DJBOOTH_MUSCRIPTOR_MLX_PROJECT",
  );
}

function resolveInvocationPath(path: string): string {
  return resolve(process.env.INIT_CWD ?? process.cwd(), path);
}

async function runNative(binary: string, args: string[]): Promise<unknown> {
  return runJsonCommand(binary, args);
}

async function runJsonCommand(binary: string, args: string[]): Promise<unknown> {
  const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (value: string) => {
    stdout += value;
    if (stdout.length > MAX_NATIVE_OUTPUT_BYTES) child.kill("SIGTERM");
  });
  child.stderr.on("data", (value: string) => {
    stderr += value;
    if (stderr.length > MAX_NATIVE_OUTPUT_BYTES) child.kill("SIGTERM");
  });
  const exitCode = await new Promise<number | null>((accept, reject) => {
    child.once("error", reject);
    child.once("close", accept);
  });
  if (exitCode !== 0) {
    throw new Error(stderr.trim() || stdout.trim() || `djbooth-rs exited with ${exitCode}`);
  }
  for (
    let marker = stdout.lastIndexOf("{");
    marker >= 0;
    marker = stdout.lastIndexOf("{", marker - 1)
  ) {
    try {
      return JSON.parse(stdout.slice(marker).trim());
    } catch {
      // Nested JSON objects fail until the scan reaches the outer report object.
    }
  }
  throw new Error(`djbooth-rs returned invalid JSON: ${stdout.slice(0, 240)}`);
}
