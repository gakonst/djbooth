import { resolve } from "node:path";

import { Cli, z } from "incur";

import {
  muscriptorSetupResultSchema,
  setupMuscriptor,
  transcribeAudioToMidi,
  transcriptionResultSchema,
} from "./transcription.js";

export const produceCli = Cli.create("produce", {
  description: "Turn reference audio into structured production material.",
});

produceCli.command("setup", {
  description: "Download and convert the pinned MuScriptor-large checkpoint for MLX.",
  options: z.object({
    cacheDirectory: z.string().optional().describe("MuScriptor-large model cache override"),
    pythonProjectDirectory: z
      .string()
      .optional()
      .describe("Standalone muscriptor-mlx Python project override"),
    uvBinary: z.string().optional().describe("uv executable override"),
  }),
  output: muscriptorSetupResultSchema,
  async run(context) {
    return setupMuscriptor({
      cacheDirectory: resolveOptionalInvocationPath(context.options.cacheDirectory),
      onLog: (message) => process.stderr.write(message),
      pythonProjectDirectory: resolveOptionalInvocationPath(context.options.pythonProjectDirectory),
      uvBinary: context.options.uvBinary,
    });
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
    uvBinary: z.string().optional().describe("uv executable override"),
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
  output: transcriptionResultSchema,
  async run(context) {
    return transcribeAudioToMidi(
      resolveInvocationPath(context.args.audio),
      resolveInvocationPath(context.args.output),
      {
        cacheDirectory: resolveOptionalInvocationPath(context.options.cacheDirectory),
        durationSeconds: context.options.duration,
        eventsPath: resolveOptionalInvocationPath(context.options.events),
        instruments: context.options.instrument,
        maxTokens: context.options.maxTokens,
        onLog: (message) => process.stderr.write(message),
        pythonProjectDirectory: resolveOptionalInvocationPath(
          context.options.pythonProjectDirectory,
        ),
        startSeconds: context.options.start,
        tempo: context.options.tempo,
        uvBinary: context.options.uvBinary,
      },
    );
  },
});

function resolveInvocationPath(path: string): string {
  return resolve(process.env.INIT_CWD ?? process.cwd(), path);
}

function resolveOptionalInvocationPath(path?: string): string | undefined {
  return path ? resolveInvocationPath(path) : undefined;
}
