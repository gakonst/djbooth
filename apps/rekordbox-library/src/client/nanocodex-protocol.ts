import type { AgentEvent } from "nanocodex";

import type { PlaylistItem, PromptContext, PromptPlan } from "../shared/types.js";

export type NanocodexLibraryContext = PromptContext & {
  canWrite: boolean;
  playlists: PlaylistItem[];
};

export type NanocodexWorkerCommand =
  | { type: "start" }
  | {
      type: "plan";
      id: string;
      prompt: string;
      context: NanocodexLibraryContext;
    };

export type NanocodexWorkerMessage =
  | { type: "ready" }
  | { type: "event"; id?: string; event: AgentEvent }
  | { type: "result"; id: string; plan: PromptPlan }
  | { type: "error"; id?: string; message: string };
