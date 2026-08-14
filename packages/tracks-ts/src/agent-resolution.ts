import { TracksError } from "./errors.js";
import type { MediaMetadata } from "./integrations/ytdlp.js";
import { parseTracklistJson } from "./render.js";
import type { Tracklist } from "./types.js";

export type AgentResolutionRequest = {
  action: "agent-resolution-required";
  source: string;
  context: {
    sourceId?: string;
    title?: string;
    uploader?: string;
    durationSeconds?: number;
    webpageUrl?: string;
    description?: string;
    warning?: string;
  };
  prompt: string;
  submit: {
    option: "--agent-result-json";
    format: "Tracklist";
    requiredProvider: "agent";
  };
};

export function createAgentResolutionRequest(
  source: string,
  metadata?: MediaMetadata,
  warning?: string,
): AgentResolutionRequest {
  const context = {
    ...(metadata?.id ? { sourceId: metadata.id } : {}),
    ...(metadata?.title ? { title: metadata.title } : {}),
    ...(metadata?.uploader ? { uploader: metadata.uploader } : {}),
    ...(metadata?.durationSeconds === undefined
      ? {}
      : { durationSeconds: metadata.durationSeconds }),
    ...(metadata?.webpageUrl ? { webpageUrl: metadata.webpageUrl } : {}),
    ...(metadata?.description ? { description: metadata.description } : {}),
    ...(warning ? { warning } : {}),
  };
  return {
    action: "agent-resolution-required",
    source,
    context,
    prompt: buildAgentResolutionPrompt(source, context),
    submit: {
      option: "--agent-result-json",
      format: "Tracklist",
      requiredProvider: "agent",
    },
  };
}

export function parseAgentTracklist(source: string, json: string): Tracklist {
  let value: unknown;
  try {
    value = JSON.parse(json) as unknown;
  } catch (error) {
    throw new TracksError("INVALID_SOURCE", "--agent-result-json must be valid JSON", {
      cause: error,
      exitCode: 2,
    });
  }
  const outer = asRecord(value);
  const candidate = asRecord(outer.data ?? value);
  if (typeof candidate.complete !== "boolean") {
    throw new TracksError(
      "INVALID_SOURCE",
      "Agent tracklist JSON must set complete to true or false",
      { exitCode: 2 },
    );
  }
  const tracklist = parseTracklistJson(value);
  if (tracklist.provider !== "agent") {
    throw new TracksError("INVALID_SOURCE", "Agent tracklist JSON must set provider to 'agent'", {
      exitCode: 2,
    });
  }
  if (tracklist.source !== source) {
    throw new TracksError(
      "INVALID_SOURCE",
      `Agent tracklist source must exactly match '${source}'`,
      { exitCode: 2 },
    );
  }
  if (!tracklist.tracks.length) {
    throw new TracksError("INVALID_SOURCE", "Agent tracklist must contain at least one track", {
      exitCode: 2,
    });
  }
  let previousStart = -1;
  for (const [index, track] of tracklist.tracks.entries()) {
    if (track.order !== index + 1) {
      throw new TracksError(
        "INVALID_SOURCE",
        `Agent tracklist orders must be contiguous from 1; row ${index + 1} has order ${track.order}`,
        { exitCode: 2 },
      );
    }
    if (track.startSeconds === undefined) {
      throw new TracksError(
        "INVALID_SOURCE",
        `Agent tracklist row ${track.order} requires timestamp or startSeconds`,
        { exitCode: 2 },
      );
    }
    if (track.startSeconds < previousStart) {
      throw new TracksError(
        "INVALID_SOURCE",
        `Agent tracklist row ${track.order} starts before the preceding row`,
        { exitCode: 2 },
      );
    }
    previousStart = track.startSeconds;
  }
  return tracklist;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function buildAgentResolutionPrompt(
  source: string,
  context: AgentResolutionRequest["context"],
): string {
  return [
    "Resolve this DJ set into an ordered, timestamped tracklist using agent browser/VM tools.",
    `Source: ${source}`,
    ...(context.title ? [`Inspected title: ${context.title}`] : []),
    ...(context.uploader ? [`Uploader: ${context.uploader}`] : []),
    ...(context.durationSeconds === undefined
      ? []
      : [`Duration seconds: ${context.durationSeconds}`]),
    "Use browser/VM tools to find and read the matching set page on the ordinary 1001Tracklists website. Match by source URL first, then inspected title, uploader, event, and duration.",
    "Use the publisher description and authoritative artist/festival pages to cross-check the 1001Tracklists result or fill gaps. Do not use a paid parsing API and do not guess.",
    "Return only one JSON object with: source (exactly as supplied), provider='agent', title/url/uploader/durationSeconds when known, complete, and tracks.",
    "Each tracks row must have contiguous order, timestamp or startSeconds, and exact artist/title/mix when known. Preserve unresolved rows as isId=true and title='ID'.",
    "The top-level url is the strongest evidence page when it differs from the source. Set complete=false if any interval or identity remains unresolved.",
  ].join("\n");
}
