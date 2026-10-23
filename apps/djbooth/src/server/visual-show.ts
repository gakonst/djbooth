import { z } from "zod";
export { defaultVisualShow, type VisualShow } from "../shared/visual-presets.js";

const id = z.string().min(1).max(128);
export const visualShowSchema = z
  .object({
    version: z.literal(1),
    presets: z
      .array(
        z
          .object({
            id,
            name: z.string().min(1).max(256),
            look: z
              .object({
                theme: z.enum(["halloween", "eighties", "y2k", "tech-house"]),
                intensity: z.number().min(0).max(2),
                motion: z.number().min(0).max(2),
                density: z.number().min(0.1).max(1),
                halloween: z.number().min(0).max(1),
              })
              .strict(),
          })
          .strict(),
      )
      .max(64),
    cues: z
      .array(
        z
          .object({
            id,
            presetId: id,
            label: z.string().max(256),
            minutes: z.number().min(0.1).max(240),
          })
          .strict(),
      )
      .max(128),
    loop: z.boolean(),
  })
  .strict()
  .superRefine((show, context) => {
    const presets = new Set(show.presets.map((p) => p.id));
    if (presets.size !== show.presets.length)
      context.addIssue({ code: "custom", message: "Preset IDs must be unique" });
    if (new Set(show.cues.map((c) => c.id)).size !== show.cues.length)
      context.addIssue({ code: "custom", message: "Cue IDs must be unique" });
    for (const cue of show.cues)
      if (!presets.has(cue.presetId))
        context.addIssue({ code: "custom", message: `Unknown cue preset: ${cue.presetId}` });
  });
