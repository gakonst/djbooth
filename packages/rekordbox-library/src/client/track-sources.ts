export type TrackSourceProvider = "spotify" | "soundcloud" | "youtube" | "soulseek";

export type TrackSource = {
  provider: TrackSourceProvider;
  kind: "download" | "reference";
  url?: string;
  peer?: string;
};

const sourceLines: ReadonlyArray<{
  kind: TrackSource["kind"];
  pattern: RegExp;
}> = [
  { kind: "download", pattern: /^Media source:\s*(.+)$/iu },
  { kind: "download", pattern: /^Source URL:\s*(.+)$/iu },
  { kind: "download", pattern: /^Download source:\s*(.+)$/iu },
  { kind: "download", pattern: /^Downloaded from [^:]+:\s*(.+)$/iu },
  { kind: "reference", pattern: /^Spotify URL:\s*(.+)$/iu },
  { kind: "reference", pattern: /^Spotify:\s*(.+)$/iu },
  { kind: "reference", pattern: /^\[Spotify Enriched\]\s+(\S+)$/iu },
];

/** Decode trusted platform references from tracks-ts and legacy embedded comments. */
export function trackSourcesFromComment(comment: string | null | undefined): TrackSource[] {
  if (!comment) return [];
  const sources: TrackSource[] = [];
  for (const line of comment.split(/\r?\n/u)) {
    for (const candidate of sourceLines) {
      const value = candidate.pattern.exec(line.trim())?.[1];
      if (!value) continue;
      const source = platformSource(value.trim(), candidate.kind);
      if (source && !sources.some((existing) => existing.provider === source.provider)) {
        sources.push(source);
      }
      break;
    }
  }
  if (!sources.some((source) => source.provider === "spotify")) {
    const spotifyId = comment.match(/^Spotify ID:\s*([A-Za-z0-9]+)$/imu)?.[1];
    if (spotifyId) {
      sources.push({
        provider: "spotify",
        kind: "reference",
        url: `https://open.spotify.com/track/${spotifyId}`,
      });
    }
  }
  return sources;
}

function platformSource(value: string, kind: TrackSource["kind"]): TrackSource | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol === "slsk:" && url.hostname === "download") {
    return {
      provider: "soulseek",
      kind: "download",
      ...(url.searchParams.get("username")?.trim()
        ? { peer: url.searchParams.get("username")!.trim() }
        : {}),
    };
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) {
    return undefined;
  }
  const hostname = url.hostname.toLocaleLowerCase("en-US");
  const provider = providerForHostname(hostname);
  if (!provider) return undefined;
  url.protocol = "https:";
  return { provider, kind, url: url.href };
}

function providerForHostname(
  hostname: string,
): Exclude<TrackSourceProvider, "soulseek"> | undefined {
  if (hostMatches(hostname, "spotify.com") || hostMatches(hostname, "spotify.link")) {
    return "spotify";
  }
  if (
    hostMatches(hostname, "soundcloud.com") ||
    hostname === "snd.sc" ||
    hostMatches(hostname, "on.soundcloud.com")
  ) {
    return "soundcloud";
  }
  if (
    hostMatches(hostname, "youtube.com") ||
    hostMatches(hostname, "youtube-nocookie.com") ||
    hostname === "youtu.be"
  ) {
    return "youtube";
  }
  return undefined;
}

function hostMatches(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}
