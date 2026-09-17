import type { SetManifest } from "./manifest.js";
import { is1001Url } from "./media.js";
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
    if (track.startSeconds === undefined) continue; // Identity is enough for standalone acquisition.
    if (track.startSeconds < previousStart) {
      throw new TracksError(
        "INVALID_SOURCE",
        `Agent tracklist row ${track.order} starts before the preceding row`,
        { exitCode: 2 },
      );
    }
    previousStart = track.startSeconds;
  }
  for (const [index, track] of tracklist.tracks.entries()) {
    const end =
      index === tracklist.tracks.length - 1
        ? tracklist.durationSeconds
        : tracklist.tracks[index + 1]?.startSeconds;
    if (
      track.endSeconds === undefined &&
      track.startSeconds !== undefined &&
      end !== undefined &&
      end > track.startSeconds
    )
      track.endSeconds = end;
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
    "Resolve this DJ set into an ordered tracklist using agent browser/VM tools.",
    `Source: ${source}`,
    ...(context.title ? [`Inspected title: ${context.title}`] : []),
    ...(context.uploader ? [`Uploader: ${context.uploader}`] : []),
    ...(context.durationSeconds === undefined
      ? []
      : [`Duration seconds: ${context.durationSeconds}`]),
    "Use browser/VM tools to find and read the matching set page on the ordinary 1001Tracklists website. Match by source URL first, then inspected title, uploader, event, and duration.",
    "Use the publisher description and authoritative artist/festival pages to cross-check the 1001Tracklists result or fill gaps. Do not use a paid parsing API and do not guess.",
    "Return only one JSON object with: source (exactly as supplied), provider='agent', title/url/uploader/durationSeconds when known, complete, and tracks.",
    "Each tracks row must have contiguous order and exact artist/title/mix when known. Include timestamp or startSeconds only when evidenced; missing cue times must not block identification or standalone acquisition. Preserve unresolved rows as isId=true and title='ID'.",
    "The top-level url is the strongest evidence page when it differs from the source. Set complete=false if any interval or identity remains unresolved. Always search 1001Tracklists before accepting publisher-only evidence, and report when no matching 1001Tracklists page can be verified.",
    "If no matching 1001Tracklists page can be verified, include this exact warning in warnings: '1001Tracklists was searched but no matching tracklist could be verified; using the cited secondary source.'",
  ].join("\n");
}

/** Old description-only checkpoints must not permanently bypass 1001 research. */
export function needs1001Research(state: SetManifest): boolean {
  return (
    !is1001Url(state.tracklist.url ?? state.source.input) &&
    !state.warnings.some((warning) =>
      warning.startsWith(
        "1001Tracklists was searched but no matching tracklist could be verified;",
      ),
    )
  );
}

/** Keep verified standalone assets when better research changes track ordering. */
export function retainResolvedRecordings(
  previous: SetManifest | null | undefined,
  next: SetManifest,
): void {
  if (!previous) return;
  const key = (entry: SetManifest["entries"][number]) =>
    JSON.stringify(
      [entry.identity.artist, entry.identity.title, entry.identity.mix ?? ""].map((value) =>
        value?.normalize("NFKC").trim().toLowerCase(),
      ),
    );
  next.artifacts = { ...previous.artifacts, ...next.artifacts };
  for (const entry of next.entries) {
    if (entry.identity.status !== "identified") continue;
    const prior = previous.entries.find(
      (candidate) => candidate.identity.status === "identified" && key(candidate) === key(entry),
    );
    if (!prior || prior.acquisition.status !== "downloaded") continue;
    if (
      entry.spotify.status === "matched" &&
      prior.spotify.status === "matched" &&
      entry.spotify.id !== prior.spotify.id
    )
      continue;
    const recordings = [
      prior.acquisition.download,
      ...(prior.acquisition.alternatives ?? []),
    ].filter((download) => download.kind !== "source-set-clip" && download.clip === undefined);
    if (!recordings.length) continue;
    entry.acquisition = {
      ...prior.acquisition,
      download: recordings[0]!,
      alternatives: recordings.slice(1),
    };
    entry.spotify = prior.spotify;
    entry.rekordbox = prior.rekordbox;
  }
}
