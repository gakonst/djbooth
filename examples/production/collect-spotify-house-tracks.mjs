import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const outputDirectory = path.resolve(
  process.argv[2] ?? path.join(import.meta.dirname, "house-taste-corpus"),
);
const inventory = JSON.parse(
  await readFile(path.join(outputDirectory, "spotify-playlists.json"), "utf8"),
);

// Personal ID lists and producer/set crates carry more taste weight than broad genre playlists.
const playlistWeights = new Map([
  ["gak track ids", 7],
  ["new echo inspo", 7],
  ["Julya Karma audio", 7],
  ["Lee Burridge b2b Patricio — Lightning in a Bottle 2026", 7],
  ["ADAM TEN - TRACK ID'S", 6],
  ["Adam Ten & Mita Gami Vibes", 6],
  ["tektek25", 6],
  ["my-own-usb", 6],
  ["Madarae Feb 2025", 6],
  ["exploration", 5],
  ["pre summer", 5],
  ["gak dance", 5],
  ["Opener Dance", 5],
  ["Melodic House & Techno", 5],
  ["late night", 4],
  ["new dance", 4],
  ["Botzi Dance", 4],
  ["Botzi Electronic", 4],
  ["Botzi kala", 4],
  ["bouncy tech house ", 4],
  ["2024 House Vibes", 4],
  ["Dance 2025", 4],
  ["Banger Opening Set Without Tech House", 4],
  ["summer24 shazams", 3],
  ["summer24 likes", 3],
]);

const selectedPlaylists = [...playlistWeights.entries()].map(([name, weight]) => {
  const playlist = inventory.playlists.find((candidate) => candidate.name === name);
  if (!playlist) throw new Error(`Spotify playlist not found: ${name}`);
  return { ...playlist, weight };
});

const playlistResults = [];
for (const [index, playlist] of selectedPlaylists.entries()) {
  const items = await readPlaylistItems(playlist.id);
  playlistResults.push({ playlist, items });
  console.error(
    `[${index + 1}/${selectedPlaylists.length}] ${playlist.name}: ${items.length} items`,
  );
}

const recentPage = await spotifyRequest("/me/player/recently-played", { limit: "50" });
const recentIds = new Set(
  (recentPage.items ?? []).map((entry) => (entry.track ?? entry.item)?.id).filter(Boolean),
);
const tracksById = new Map();

for (const { playlist, items } of playlistResults) {
  for (const [position, entry] of items.entries()) {
    const source = entry.track ?? entry.item;
    if (!source?.id || source.type !== "track") continue;
    const track = tracksById.get(source.id) ?? normalizeTrack(source);
    track.playlists.push({
      id: playlist.id,
      name: playlist.name,
      weight: playlist.weight,
      position,
      addedAt: entry.added_at ?? null,
      owned: playlist.owned,
    });
    tracksById.set(source.id, track);
  }
}

const tracks = [...tracksById.values()];
for (const track of tracks) {
  track.recent = recentIds.has(track.id);
  track.tasteScore =
    track.playlists.reduce((total, playlist) => total + playlist.weight, 0) +
    Math.max(0, track.playlists.length - 1) * 4 +
    (track.recent ? 10 : 0) +
    Math.min(4, track.popularity / 25);
}
tracks.sort(
  (left, right) => right.tasteScore - left.tasteScore || right.popularity - left.popularity,
);

const artistCounts = new Map();
for (const track of tracks) {
  for (const artist of track.artists) {
    const record = artistCounts.get(artist.id) ?? {
      id: artist.id,
      name: artist.name,
      tracks: new Set(),
      playlistIds: new Set(),
      tasteScore: 0,
      genres: [],
    };
    record.tracks.add(track.id);
    for (const playlist of track.playlists) record.playlistIds.add(playlist.id);
    record.tasteScore += track.tasteScore;
    artistCounts.set(artist.id, record);
  }
}

const topArtistRecords = [...artistCounts.values()]
  .sort((left, right) => right.tasteScore - left.tasteScore)
  .slice(0, 200);
for (const ids of chunks(
  topArtistRecords.map((artist) => artist.id),
  50,
)) {
  const response = await spotifyRequest("/artists", { ids: ids.join(",") });
  for (const artist of response.artists ?? []) {
    const record = artistCounts.get(artist.id);
    if (record) record.genres = artist.genres ?? [];
  }
}

const artists = [...artistCounts.values()]
  .map((artist) => ({
    ...artist,
    tracks: artist.tracks.size,
    playlists: artist.playlistIds.size,
    playlistIds: undefined,
    tasteScore: round(artist.tasteScore, 2),
  }))
  .sort((left, right) => right.tasteScore - left.tasteScore);

const corpus = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  method: {
    playlistSelection:
      "Curated personal crates, ID lists, producer playlists, and house/dance lists",
    weighting:
      "Personal ID and producer/set crates outrank broad genre lists; cross-playlist recurrence and recent listening add weight",
    audioCaveat:
      "Spotify metadata selects references; audio analysis is performed only from separately resolved local sources",
  },
  counts: {
    playlists: selectedPlaylists.length,
    playlistEntries: playlistResults.reduce((total, result) => total + result.items.length, 0),
    uniqueTracks: tracks.length,
    uniqueArtists: artists.length,
    recentMatches: tracks.filter((track) => track.recent).length,
  },
  playlists: selectedPlaylists,
  artists,
  tracks,
};

await mkdir(outputDirectory, { recursive: true });
await writeFile(
  path.join(outputDirectory, "spotify-house-tracks.json"),
  `${JSON.stringify(corpus, null, 2)}\n`,
);
await writeFile(path.join(outputDirectory, "spotify-house-tracks.md"), renderMarkdown(corpus));
console.log(JSON.stringify({ outputDirectory, ...corpus.counts }, null, 2));

async function readPlaylistItems(playlistId) {
  const all = [];
  for (let offset = 0; ; offset += 50) {
    const page = await spotifyRequest(`/playlists/${playlistId}/items`, {
      limit: "50",
      offset: String(offset),
    });
    all.push(...(page.items ?? []));
    if (!page.next) return all;
  }
}

async function spotifyRequest(apiPath, query) {
  const { stdout } = await execFileAsync(
    "pnpm",
    [
      "--silent",
      "djbooth",
      "spots",
      "request",
      "GET",
      apiPath,
      "--query",
      JSON.stringify(query),
      "--format",
      "json",
    ],
    { cwd: path.resolve(import.meta.dirname, "../.."), maxBuffer: 64 * 1024 * 1024 },
  );
  return JSON.parse(stdout.slice(stdout.indexOf("{")));
}

function normalizeTrack(source) {
  return {
    id: source.id,
    name: source.name,
    artists: (source.artists ?? []).map((artist) => ({ id: artist.id, name: artist.name })),
    album: source.album?.name ?? null,
    releaseDate: source.album?.release_date ?? null,
    durationSeconds: round((source.duration_ms ?? 0) / 1000, 3),
    popularity: source.popularity ?? 0,
    explicit: Boolean(source.explicit),
    isrc: source.external_ids?.isrc ?? null,
    uri: source.uri,
    url: source.external_urls?.spotify,
    previewUrl: source.preview_url ?? null,
    playlists: [],
  };
}

function chunks(values, size) {
  return Array.from({ length: Math.ceil(values.length / size) }, (_, index) =>
    values.slice(index * size, index * size + size),
  );
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function renderMarkdown(corpus) {
  const trackRow = (track) =>
    `| [${escapeCell(track.name)}](${track.url}) | ${escapeCell(track.artists.map((artist) => artist.name).join(", "))} | ${track.tasteScore.toFixed(1)} | ${track.playlists.length} | ${track.recent ? "yes" : ""} |`;
  const artistRow = (artist) =>
    `| ${escapeCell(artist.name)} | ${artist.tasteScore.toFixed(1)} | ${artist.tracks} | ${artist.playlists} | ${escapeCell(artist.genres.slice(0, 5).join(", "))} |`;
  return `# Spotify house taste corpus\n\n${corpus.counts.uniqueTracks} unique tracks from ${corpus.counts.playlists} weighted playlists. Spotify metadata is taste-selection evidence, not an audio source.\n\n## Highest-weight tracks\n\n| Track | Artists | Score | Playlists | Recent |\n| --- | --- | ---: | ---: | --- |\n${corpus.tracks.slice(0, 250).map(trackRow).join("\n")}\n\n## Highest-weight artists\n\n| Artist | Score | Tracks | Playlists | Genres |\n| --- | ---: | ---: | ---: | --- |\n${corpus.artists.slice(0, 200).map(artistRow).join("\n")}\n`;
}

function escapeCell(value) {
  return String(value ?? "")
    .replaceAll("|", "\\|")
    .replaceAll("\n", " ");
}
