import type { PromptContext, PromptPlan } from "../shared/types.js";
import type { PlaylistItem } from "../shared/types.js";
import type { NanocodexWorkerCommand, NanocodexWorkerMessage } from "./nanocodex-protocol.js";

type PendingPlan = {
  reject(error: Error): void;
  resolve(plan: PromptPlan): void;
  reportProgress?: (summary: string) => void;
  reasoning: string;
};

/** Browser-WASM Nanocodex lifecycle owner for the library command surface. */
export class NanocodexPlanner {
  readonly #pending = new Map<string, PendingPlan>();
  readonly #ready: Promise<void>;
  readonly #worker: Worker;
  #rejectReady: ((error: Error) => void) | undefined;
  #resolveReady: (() => void) | undefined;

  constructor() {
    this.#worker = new Worker(new URL("./nanocodex-worker.ts", import.meta.url), {
      type: "module",
    });
    this.#ready = new Promise<void>((resolve, reject) => {
      this.#resolveReady = resolve;
      this.#rejectReady = reject;
    });
    this.#worker.onmessage = ({ data }: MessageEvent<NanocodexWorkerMessage>) => {
      if (data.type === "ready") {
        this.#resolveReady?.();
        this.#resolveReady = undefined;
        this.#rejectReady = undefined;
        return;
      }
      if (data.type === "event") {
        if (data.id) this.#handleEvent(data.id, data.event);
        return;
      }
      if (data.type === "result") {
        const pending = this.#pending.get(data.id);
        this.#pending.delete(data.id);
        pending?.resolve(data.plan);
        return;
      }
      const error = new Error(data.message);
      if (data.id) {
        const pending = this.#pending.get(data.id);
        this.#pending.delete(data.id);
        pending?.reject(error);
      } else {
        this.#rejectReady?.(error);
        this.#rejectReady = undefined;
        this.#resolveReady = undefined;
        for (const pending of this.#pending.values()) pending.reject(error);
        this.#pending.clear();
      }
    };
    this.#worker.onerror = (event) => {
      const error = new Error(event.message || "Nanocodex Worker failed");
      this.#rejectReady?.(error);
      for (const pending of this.#pending.values()) pending.reject(error);
      this.#pending.clear();
    };
    this.#post({ type: "start" });
  }

  async plan(
    id: string,
    prompt: string,
    context: PromptContext & { canWrite: boolean; playlists: PlaylistItem[] },
    reportProgress?: (summary: string) => void,
  ): Promise<PromptPlan> {
    await this.#ready;
    if (this.#pending.has(id)) throw new Error(`Prompt '${id}' is already running`);
    const result = new Promise<PromptPlan>((resolve, reject) => {
      this.#pending.set(id, {
        resolve,
        reject,
        reasoning: "",
        ...(reportProgress ? { reportProgress } : {}),
      });
    });
    this.#post({ type: "plan", id, prompt, context });
    return result;
  }

  dispose(): void {
    this.#worker.terminate();
    const error = new Error("Nanocodex planner was closed");
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }

  #post(command: NanocodexWorkerCommand): void {
    this.#worker.postMessage(command);
  }

  #handleEvent(id: string, event: import("nanocodex").AgentEvent): void {
    const pending = this.#pending.get(id);
    if (!pending?.reportProgress) return;
    if (event.type === "run.started") {
      pending.reportProgress("Thinking with Nanocodex in Rust/WASM…");
      return;
    }
    if (event.type === "reasoning.summary.delta") {
      const text = typeof event.payload.text === "string" ? event.payload.text : "";
      pending.reasoning = `${pending.reasoning}${text}`.slice(-240);
      const summary = pending.reasoning.trim();
      if (summary) pending.reportProgress(summary);
      return;
    }
    if (event.type === "tool.call") {
      const tool = typeof event.payload.tool === "string" ? event.payload.tool : "library tool";
      pending.reportProgress(`Planning with ${humanizeTool(tool)}…`);
      return;
    }
    if (event.type === "tool.result") pending.reportProgress("Validating the proposed action…");
  }
}

function humanizeTool(value: string): string {
  return value
    .replace(/^tools\./u, "")
    .replace(/([a-z])([A-Z])/gu, "$1 $2")
    .replace(/[._-]+/gu, " ")
    .toLowerCase();
}
