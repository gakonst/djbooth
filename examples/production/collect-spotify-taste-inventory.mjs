import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const outputDirectory = path.resolve(
  process.argv[2] ?? path.join(import.meta.dirname, "house-taste-corpus"),
);
const pageSize = 50;
const pages = [];

for (let offset = 0; ; offset += pageSize) {
  const page = await spotifyRequest("/me/playlists", {
    limit: String(pageSize),
    offset: String(offset),
  });
  pages.push(page);
  if (!page.next) break;
}

const playlists = pages
  .flatMap((page) => page.items)
  .map((playlist) => ({
    id: playlist.id,
    name: playlist.name,
    description: decodeHtml(playlist.description ?? ""),
    ownerId: playlist.owner?.id ?? null,
    ownerName: playlist.owner?.display_name ?? null,
    owned: playlist.owner?.id === "georgegak",
    collaborative: playlist.collaborative,
    public: playlist.public,
    tracks: playlist.items?.total ?? playlist.tracks?.total ?? 0,
    snapshotId: playlist.snapshot_id,
    url: playlist.external_urls?.spotify,
  }))
  .sort((left, right) => Number(right.owned) - Number(left.owned) || right.tracks - left.tracks);

const tasteTerms = [
  "house",
  "dance",
  "electronic",
  "afro",
  "organic",
  "melodic",
  "deep",
  "techno",
  "sunset",
  "midnight",
  "late night",
  "opener",
  "party",
  "exploration",
  "summer",
  "burridge",
  "adam ten",
  "maz",
  "keinemusik",
  "rampa",
  "&me",
  "black coffee",
  "dj set",
  "track id",
];

const candidates = playlists
  .map((playlist) => {
    const text = `${playlist.name} ${playlist.description} ${playlist.ownerName}`.toLowerCase();
    const matchedTerms = tasteTerms.filter((term) => text.includes(term));
    const score =
      matchedTerms.length * 10 +
      (playlist.owned ? 5 : 0) +
      (playlist.tracks >= 8 ? 3 : 0) +
      (playlist.tracks >= 25 ? 2 : 0) +
      (playlist.description.includes("@gakonst/music") ? 8 : 0);
    return { ...playlist, matchedTerms, score };
  })
  .filter((playlist) => playlist.score >= 10)
  .sort((left, right) => right.score - left.score || right.tracks - left.tracks);

const inventory = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  account: "georgegak",
  counts: {
    playlists: playlists.length,
    owned: playlists.filter((playlist) => playlist.owned).length,
    followed: playlists.filter((playlist) => !playlist.owned).length,
    candidateHousePlaylists: candidates.length,
  },
  candidates,
  playlists,
};

await mkdir(outputDirectory, { recursive: true });
await writeFile(
  path.join(outputDirectory, "spotify-playlists.json"),
  `${JSON.stringify(inventory, null, 2)}\n`,
);
await writeFile(path.join(outputDirectory, "spotify-playlists.md"), renderMarkdown(inventory));
console.log(JSON.stringify({ outputDirectory, ...inventory.counts }, null, 2));

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
    { cwd: path.resolve(import.meta.dirname, "../.."), maxBuffer: 32 * 1024 * 1024 },
  );
  return JSON.parse(stdout.slice(stdout.indexOf("{")));
}

function decodeHtml(value) {
  return value
    .replaceAll("&#x2F;", "/")
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'");
}

function renderMarkdown(inventory) {
  const row = (playlist) =>
    `| [${playlist.name.replaceAll("|", "\\|")}](${playlist.url}) | ${playlist.ownerName} | ${playlist.tracks} | ${playlist.matchedTerms?.join(", ") ?? ""} |`;
  return `# Spotify taste inventory\n\nGenerated ${inventory.generatedAt}. ${inventory.counts.playlists} visible playlists; ${inventory.counts.owned} owned by the current account.\n\n## House candidates\n\n| Playlist | Owner | Tracks | Matched taste terms |\n| --- | --- | ---: | --- |\n${inventory.candidates.map(row).join("\n")}\n\n## All playlists\n\n| Playlist | Owner | Tracks | Matched taste terms |\n| --- | --- | ---: | --- |\n${inventory.playlists.map(row).join("\n")}\n`;
}
