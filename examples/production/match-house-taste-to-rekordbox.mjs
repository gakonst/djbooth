import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { MasterDatabase } from "../../packages/rekordbox-ts/dist/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const corpusRoot = path.resolve(process.argv[2] ?? path.join(here, "house-taste-corpus"));
const spotify = JSON.parse(
  await readFile(path.join(corpusRoot, "spotify-house-tracks.json"), "utf8"),
);

const database = new MasterDatabase({ readonly: true });
let localTracks;
try {
  localTracks = database.connection
    .prepare(`SELECT
      c.*,
      ar."Name" AS "ArtistName",
      re."Name" AS "RemixerName",
      ge."Name" AS "GenreName",
      ke."ScaleName" AS "KeyName"
    FROM "djmdContent" c
    LEFT JOIN "djmdArtist" ar ON ar."ID" = c."ArtistID"
    LEFT JOIN "djmdArtist" re ON re."ID" = c."RemixerID"
    LEFT JOIN "djmdGenre" ge ON ge."ID" = c."GenreID"
    LEFT JOIN "djmdKey" ke ON ke."ID" = c."KeyID"
    WHERE c."FolderPath" IS NOT NULL AND c."FolderPath" != ''`)
    .all();
} finally {
  database.close();
}

const localRecords = localTracks.map(prepareLocalTrack);
const byIsrc = groupBy(
  localRecords.filter((track) => track.isrc),
  (track) => track.isrc,
);
const byTitleToken = new Map();
for (const track of localRecords) {
  for (const token of track.titleTokens) {
    const records = byTitleToken.get(token) ?? [];
    records.push(track);
    byTitleToken.set(token, records);
  }
}

const matches = [];
for (const spotifyTrack of spotify.tracks) {
  const candidates = candidatePool(spotifyTrack);
  const scored = candidates
    .map((localTrack) => scoreMatch(spotifyTrack, localTrack))
    .filter((candidate) => candidate.score >= 45)
    .sort(compareCandidates)
    .slice(0, 5);
  const best = scored[0] ?? null;
  matches.push({
    spotify: spotifyTrack,
    confidence: best ? confidence(best.score) : "none",
    match: best,
    alternatives: scored.slice(1),
  });
}

matches.sort(
  (left, right) =>
    right.spotify.tasteScore - left.spotify.tasteScore ||
    (right.match?.score ?? 0) - (left.match?.score ?? 0),
);

const core = selectCore(matches);
const output = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  databasePath: database.path,
  localTrackCount: localRecords.length,
  spotifyTrackCount: spotify.tracks.length,
  matchedTrackCount: matches.filter((entry) => entry.match).length,
  highConfidenceCount: matches.filter((entry) => entry.confidence === "high").length,
  coreTrackCount: core.length,
  core,
  matches,
};

await writeFile(
  path.join(corpusRoot, "local-reference-matches.json"),
  `${JSON.stringify(output, null, 2)}\n`,
);
await writeFile(path.join(corpusRoot, "local-reference-matches.md"), renderMarkdown(output));

console.log(
  JSON.stringify(
    {
      localTracks: output.localTrackCount,
      spotifyTracks: output.spotifyTrackCount,
      matched: output.matchedTrackCount,
      highConfidence: output.highConfidenceCount,
      core: output.coreTrackCount,
    },
    null,
    2,
  ),
);

function candidatePool(track) {
  const isrcMatches = byIsrc.get(normalizeIsrc(track.isrc)) ?? [];
  const titleTokens = meaningfulTokens(track.name);
  const counts = new Map();
  for (const token of titleTokens) {
    for (const candidate of byTitleToken.get(token) ?? []) {
      counts.set(candidate, (counts.get(candidate) ?? 0) + 1);
    }
  }
  const tokenMatches = [...counts.entries()]
    .filter(([, count]) => count >= Math.min(2, titleTokens.size))
    .sort((left, right) => right[1] - left[1])
    .slice(0, 120)
    .map(([candidate]) => candidate);
  return [...new Set([...isrcMatches, ...tokenMatches])];
}

function scoreMatch(spotifyTrack, localTrack) {
  const spotifyTitle = normalizeText(spotifyTrack.name);
  const spotifyBase = normalizeTitleBase(spotifyTrack.name);
  const spotifyTokens = meaningfulTokens(spotifyTrack.name);
  const spotifyArtists = new Set(
    spotifyTrack.artists.flatMap((artist) => meaningfulTokens(artist.name)),
  );
  const exactIsrc =
    normalizeIsrc(spotifyTrack.isrc) && normalizeIsrc(spotifyTrack.isrc) === localTrack.isrc;
  const exactTitle = spotifyTitle === localTrack.title;
  const exactBase = spotifyBase === localTrack.baseTitle;
  const titleSimilarity = jaccard(spotifyTokens, localTrack.titleTokens);
  const artistSimilarity = jaccard(spotifyArtists, localTrack.artistTokens);
  const durationDifference = Math.abs(
    (spotifyTrack.durationSeconds ?? 0) - localTrack.lengthSeconds,
  );
  const durationScore = Math.max(0, 1 - durationDifference / 45);
  const versionConflict =
    versionSignature(spotifyTrack.name) !== versionSignature(localTrack.raw.Title);

  let score = 0;
  if (exactIsrc) score += 100;
  if (exactTitle) score += 48;
  else if (exactBase) score += 31;
  score += titleSimilarity * 42;
  score += artistSimilarity * 25;
  score += durationScore * 9;
  score += Math.min(5, Math.max(0, localTrack.bitRate / 64 - 2));
  score += localTrack.exists ? 4 : -100;
  if (versionConflict && !exactIsrc) score -= 22;
  if (artistSimilarity === 0 && !exactIsrc) score -= 25;

  return {
    score: round(score),
    evidence: {
      exactIsrc: Boolean(exactIsrc),
      exactTitle,
      exactBaseTitle: exactBase,
      titleSimilarity: round(titleSimilarity),
      artistSimilarity: round(artistSimilarity),
      durationDifferenceSeconds: round(durationDifference),
      versionConflict,
    },
    local: {
      id: String(localTrack.raw.ID),
      title: localTrack.raw.Title,
      artist: localTrack.raw.ArtistName ?? null,
      remixer: localTrack.raw.RemixerName ?? null,
      genre: localTrack.raw.GenreName ?? null,
      key: localTrack.raw.KeyName ?? null,
      bpm: Number(localTrack.raw.BPM ?? 0) / 100 || null,
      lengthSeconds: localTrack.lengthSeconds,
      bitRate: localTrack.bitRate || null,
      sampleRate: Number(localTrack.raw.SampleRate ?? 0) || null,
      rating: Number(localTrack.raw.Rating ?? 0),
      playCount: Number(localTrack.raw.DJPlayCount ?? 0),
      isrc: localTrack.raw.ISRC || null,
      path: localTrack.raw.FolderPath,
    },
  };
}

function prepareLocalTrack(raw) {
  const title = normalizeText(raw.Title ?? raw.FileNameL ?? "");
  const titleTokens = meaningfulTokens(raw.Title ?? raw.FileNameL ?? "");
  const artistMaterial = [raw.ArtistName, raw.RemixerName, raw.FolderPath, raw.FileNameL]
    .filter(Boolean)
    .join(" ");
  return {
    raw,
    title,
    baseTitle: normalizeTitleBase(raw.Title ?? raw.FileNameL ?? ""),
    titleTokens,
    artistTokens: meaningfulTokens(artistMaterial),
    isrc: normalizeIsrc(raw.ISRC),
    lengthSeconds: Number(raw.Length ?? 0),
    bitRate: Number(raw.BitRate ?? 0),
    exists: path.isAbsolute(raw.FolderPath) && existsSync(raw.FolderPath),
  };
}

function selectCore(allMatches) {
  const selected = [];
  const artistCounts = new Map();
  const playlistCounts = new Map();
  for (const entry of allMatches) {
    if (!entry.match || entry.match.score < 68) continue;
    const primaryArtist = entry.spotify.artists[0]?.name ?? "unknown";
    const artistCount = artistCounts.get(primaryArtist) ?? 0;
    if (artistCount >= 3) continue;
    const personalPlaylists = entry.spotify.playlists.filter((playlist) => playlist.weight >= 5);
    const addsCoverage = personalPlaylists.some(
      (playlist) => (playlistCounts.get(playlist.name) ?? 0) < 6,
    );
    if (!addsCoverage && selected.length >= 48) continue;
    selected.push({
      id: slug(`${primaryArtist}-${entry.spotify.name}`),
      title: entry.spotify.name,
      artists: entry.spotify.artists.map((artist) => artist.name),
      tasteScore: entry.spotify.tasteScore,
      playlists: entry.spotify.playlists.map((playlist) => playlist.name),
      spotifyId: entry.spotify.id,
      spotifyIsrc: entry.spotify.isrc,
      matchScore: entry.match.score,
      audio: entry.match.local.path,
      rekordbox: entry.match.local,
    });
    artistCounts.set(primaryArtist, artistCount + 1);
    for (const playlist of personalPlaylists) {
      playlistCounts.set(playlist.name, (playlistCounts.get(playlist.name) ?? 0) + 1);
    }
    if (selected.length >= 72) break;
  }
  return selected;
}

function renderMarkdown(output) {
  const lines = [
    "# Local house reference matches",
    "",
    `${output.matchedTrackCount} of ${output.spotifyTrackCount} Spotify taste tracks matched against ${output.localTrackCount} Rekordbox tracks; ${output.highConfidenceCount} are high confidence.`,
    "",
    `The balanced analysis core contains ${output.coreTrackCount} local references. Matching favors exact ISRC and version-aware title/artist agreement; Spotify supplies selection metadata only.`,
    "",
    "## Analysis core",
    "",
    "| Reference | Match | BPM | Key | Source playlists |",
    "| --- | ---: | ---: | --- | --- |",
  ];
  for (const entry of output.core) {
    lines.push(
      `| ${entry.artists.join(", ")} — ${entry.title} | ${entry.matchScore.toFixed(1)} | ${entry.rekordbox.bpm ?? ""} | ${entry.rekordbox.key ?? ""} | ${entry.playlists.slice(0, 3).join(", ")} |`,
    );
  }
  lines.push("", "## Highest-weight unmatched or uncertain references", "");
  for (const entry of output.matches
    .filter((candidate) => !candidate.match || candidate.match.score < 68)
    .slice(0, 40)) {
    lines.push(
      `- ${entry.spotify.artists.map((artist) => artist.name).join(", ")} — ${entry.spotify.name}: ${entry.match ? entry.match.score.toFixed(1) : "no match"}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function normalizeText(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replaceAll(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replaceAll(/&/g, " and ")
    .replaceAll(/[^a-z0-9]+/g, " ")
    .trim();
}

function normalizeTitleBase(value) {
  return normalizeText(
    String(value ?? "")
      .replaceAll(/\([^)]*(?:remix|mix|edit|version|remaster|radio|extended|feat)[^)]*\)/gi, " ")
      .replaceAll(/\[[^\]]*\]/g, " ")
      .replaceAll(/\s+-\s+.*(?:remix|mix|edit|version|remaster|radio|extended).*$/gi, " "),
  );
}

function versionSignature(value) {
  const normalized = normalizeText(value);
  const terms = ["remix", "edit", "extended", "radio", "remaster", "club", "dub", "mix"];
  return terms.filter((term) => normalized.includes(term)).join("+");
}

function meaningfulTokens(value) {
  const ignored = new Set([
    "a",
    "an",
    "and",
    "by",
    "feat",
    "featuring",
    "ft",
    "in",
    "mix",
    "of",
    "on",
    "original",
    "the",
    "to",
    "with",
  ]);
  return new Set(
    normalizeText(value)
      .split(" ")
      .filter((token) => token && !ignored.has(token)),
  );
}

function normalizeIsrc(value) {
  return normalizeText(value).replaceAll(" ", "");
}

function jaccard(left, right) {
  if (!left.size || !right.size) return 0;
  let intersection = 0;
  for (const item of left) if (right.has(item)) intersection += 1;
  return intersection / (left.size + right.size - intersection);
}

function groupBy(values, key) {
  const groups = new Map();
  for (const value of values) {
    const identifier = key(value);
    const group = groups.get(identifier) ?? [];
    group.push(value);
    groups.set(identifier, group);
  }
  return groups;
}

function compareCandidates(left, right) {
  return (
    right.score - left.score ||
    right.local.bitRate - left.local.bitRate ||
    right.local.rating - left.local.rating
  );
}

function confidence(score) {
  if (score >= 100) return "high";
  if (score >= 68) return "medium";
  return "low";
}

function round(value) {
  return Math.round(value * 1_000) / 1_000;
}

function slug(value) {
  return normalizeText(value).replaceAll(" ", "-").slice(0, 96);
}
