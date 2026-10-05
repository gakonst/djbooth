import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const corpusRoot = path.resolve(process.argv[2] ?? path.join(here, "house-taste-corpus"));
const productionLimit = Number(option("--production") ?? 48);
const lineageLimit = Number(option("--lineage") ?? 12);
const spotify = JSON.parse(
  await readFile(path.join(corpusRoot, "spotify-house-tracks.json"), "utf8"),
);
const local = JSON.parse(
  await readFile(path.join(corpusRoot, "local-reference-matches.json"), "utf8"),
);
const artists = new Map(spotify.artists.map((artist) => [artist.id, artist]));

const eligible = local.matches
  .filter((entry) => entry.match?.score >= 68)
  .map((entry) => classify(entry))
  .filter((entry) => entry.bpm && entry.audio)
  .sort((left, right) => right.selectionScore - left.selectionScore);

const production = balancedSelect(
  eligible.filter(
    (entry) =>
      entry.electronic &&
      entry.year >= 2010 &&
      entry.bpm >= 118 &&
      entry.bpm <= 134.5 &&
      !entry.versionConflict,
  ),
  productionLimit,
  3,
);
const productionIds = new Set(production.map((entry) => entry.spotifyId));
const lineage = balancedSelect(
  eligible.filter(
    (entry) =>
      !productionIds.has(entry.spotifyId) &&
      entry.year > 0 &&
      entry.year < 2010 &&
      entry.tasteScore >= 8,
  ),
  lineageLimit,
  2,
);

const tracks = [
  ...production.map((track) => ({ ...track, role: "production-language" })),
  ...lineage.map((track) => ({ ...track, role: "hook-lineage" })),
].map((track) => ({
  id: track.id,
  title: track.title,
  artists: track.artists,
  year: track.year,
  audio: track.audio,
  role: track.role,
  tasteScore: track.tasteScore,
  selectionScore: track.selectionScore,
  spotifyId: track.spotifyId,
  playlists: track.playlists,
  genres: track.genres,
  rekordbox: {
    bpm: track.bpm,
    key: track.key,
    rating: track.rating,
    playCount: track.playCount,
  },
}));

const manifest = {
  schemaVersion: 1,
  name: "Personal house production language and hook-lineage references",
  generatedAt: new Date().toISOString(),
  source: "Weighted Spotify playlists resolved to local Rekordbox audio",
  productionLanguageTracks: production.length,
  hookLineageTracks: lineage.length,
  tracks,
};
await writeFile(
  path.join(corpusRoot, "house-reference-manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
await writeFile(path.join(corpusRoot, "house-reference-manifest.md"), renderMarkdown(manifest));

console.log(
  JSON.stringify(
    {
      productionLanguage: production.length,
      hookLineage: lineage.length,
      total: tracks.length,
    },
    null,
    2,
  ),
);

function classify(entry) {
  const track = entry.spotify;
  const artistProfiles = track.artists.map((artist) => artists.get(artist.id)).filter(Boolean);
  const genres = [...new Set(artistProfiles.flatMap((artist) => artist.genres ?? []))];
  const electronic = genres.some((genre) =>
    /house|techno|dance|electro|disco|edm|afro|organic|electronica|trance/i.test(genre),
  );
  const year = Number.parseInt(track.releaseDate?.slice(0, 4) ?? "0", 10) || 0;
  const maxPlaylistWeight = Math.max(...track.playlists.map((playlist) => playlist.weight));
  const personalPlaylistCount = track.playlists.filter((playlist) => playlist.weight >= 5).length;
  const artistTaste = Math.max(0, ...artistProfiles.map((artist) => artist.tasteScore ?? 0));
  const localTrack = entry.match.local;
  const qualityBoost = Math.min(5, Math.max(0, (localTrack.bitRate ?? 0) / 64 - 2));
  const selectionScore =
    track.tasteScore * 2 +
    maxPlaylistWeight * 2 +
    personalPlaylistCount * 8 +
    Math.min(25, artistTaste / 6) +
    qualityBoost +
    (entry.match.evidence.exactIsrc ? 8 : 0);
  return {
    id: slug(`${track.artists[0]?.name}-${track.name}`),
    title: track.name,
    artists: track.artists.map((artist) => artist.name),
    year,
    audio: localTrack.path,
    bpm: localTrack.bpm,
    key: localTrack.key,
    rating: localTrack.rating,
    playCount: localTrack.playCount,
    spotifyId: track.id,
    tasteScore: track.tasteScore,
    selectionScore: round(selectionScore),
    playlists: track.playlists.map((playlist) => playlist.name),
    genres,
    electronic,
    versionConflict: entry.match.evidence.versionConflict,
  };
}

function balancedSelect(candidates, limit, maxPerPrimaryArtist) {
  const selected = [];
  const artistCounts = new Map();
  const playlistCounts = new Map();
  for (const candidate of candidates) {
    const primary = candidate.artists[0] ?? "unknown";
    if ((artistCounts.get(primary) ?? 0) >= maxPerPrimaryArtist) continue;
    const signaturePlaylists = candidate.playlists.filter((name) =>
      [
        "gak track ids",
        "new echo inspo",
        "Julya Karma audio",
        "ADAM TEN - TRACK ID'S",
        "Adam Ten & Mita Gami Vibes",
        "tektek25",
        "my-own-usb",
        "Madarae Feb 2025",
        "exploration",
        "pre summer",
      ].includes(name),
    );
    const expandsCoverage = signaturePlaylists.some(
      (name) => (playlistCounts.get(name) ?? 0) < Math.ceil(limit / 8),
    );
    if (!expandsCoverage && selected.length >= Math.floor(limit * 0.75)) continue;
    selected.push(candidate);
    artistCounts.set(primary, (artistCounts.get(primary) ?? 0) + 1);
    for (const name of signaturePlaylists) {
      playlistCounts.set(name, (playlistCounts.get(name) ?? 0) + 1);
    }
    if (selected.length >= limit) break;
  }
  return selected;
}

function renderMarkdown(manifest) {
  const lines = [
    "# House reference analysis manifest",
    "",
    `${manifest.productionLanguageTracks} modern production-language references plus ${manifest.hookLineageTracks} melodic and cultural lineage references.`,
    "",
    "The production group teaches groove, density, arrangement, timbre, and mix relationships. The lineage group teaches memorable hooks, bass motifs, vocal phrasing, and source-material taste; it is not used as a house mix target by itself.",
  ];
  for (const role of ["production-language", "hook-lineage"]) {
    lines.push(
      "",
      `## ${role === "production-language" ? "Production language" : "Hook lineage"}`,
      "",
    );
    lines.push("| Track | BPM | Key | Genres |", "| --- | ---: | --- | --- |");
    for (const track of manifest.tracks.filter((candidate) => candidate.role === role)) {
      lines.push(
        `| ${track.artists.join(", ")} — ${track.title} | ${track.rekordbox.bpm} | ${track.rekordbox.key ?? ""} | ${track.genres.slice(0, 4).join(", ")} |`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function slug(value) {
  return String(value)
    .normalize("NFKD")
    .replaceAll(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-|-$/g, "")
    .slice(0, 96);
}

function round(value) {
  return Math.round(value * 1_000) / 1_000;
}
