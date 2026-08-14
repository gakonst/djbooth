import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { safeFilename, type AudioMetadata } from "../acquisition.js";
import type { AcquisitionPlan, AcquisitionRecordingVariant } from "../acquire-manifest.js";
import {
  parseManifest,
  type SetManifest,
  type SpotifyCandidate,
  type SpotifyState,
  type TrackIdentity,
} from "../manifest.js";
import { formatTimestamp } from "../time.js";

export const BRUNELLO_ROOT = resolve(
  process.env.TRACKS_BRUNELLO_ROOT ??
    join(homedir(), "Music/tracks-ts/brunello-lightning-in-a-bottle-2026"),
);
export const BRUNELLO_MANIFEST_PATH = join(BRUNELLO_ROOT, "manifest.json");
export const BRUNELLO_SOURCE_PATH = join(
  BRUNELLO_ROOT,
  "source/brunello-lightning-in-a-bottle-2026-source.mp3",
);
export const BRUNELLO_YOUTUBE_URL = "https://youtu.be/baDz12J2uNo";
export const BRUNELLO_SOUNDCLOUD_URL =
  "https://soundcloud.com/cathalcanavan/brunello-lightning-in-a-bottle";
export const BRUNELLO_1001_URL =
  "https://www.1001tracklists.com/tracklist/suh1tyt/brunello-woogie-stage-lightning-in-a-bottle-festival-2026-united-states-2026-05-23.html";
export const BRUNELLO_SET_TITLE = "Brunello @ Lightning in a Bottle 2026";

const SET_DURATION = 7064.28;
const CUE_STARTS = [
  0, 301, 515, 788, 1105, 1347, 1634, 1846, 2148, 2421, 2731, 2913, 3120, 3452, 3815, 4117, 4420,
  4737, 5021, 5300, 5663, 5971, 6116, 6343, 6630, 6857,
] as const;

type IdentityDefinition = {
  artist: string;
  title: string;
  mix?: string;
  label?: string;
  isId?: boolean;
};

const IDENTITIES: readonly IdentityDefinition[] = [
  { artist: "Jansons", title: "Panic At The Disco", label: "LEFTROOM" },
  { artist: "Andre Butano & Miguel Lobo", title: "Sizzurp Overdose", label: "8BIT" },
  { artist: "Paride Saraceni", title: "Just For One Day", label: "TRONIC" },
  { artist: "Brunello", title: "Melted (Dusty Clown Mix)", label: "MELLOW CIRCUS RECORDS" },
  { artist: "Brunello", title: "Science Fiction", label: "MELLOW CIRCUS RECORDS" },
  { artist: "Unknown Artist", title: "ID [Set Extract @ 22:27]", isId: true },
  {
    artist: "Piero Pirupa, Shield, The Egyptian Lover & Paris Brightledge",
    title: "I Like",
    mix: "Club Mix",
    label: "REBIRTH",
  },
  { artist: "Brunello & Hilel Lev", title: "Apathy", label: "MELLOW CIRCUS RECORDS" },
  { artist: "Brunello", title: "Booty Clap" },
  { artist: "Brunello", title: "Clown Shoes" },
  { artist: "Aman Umber", title: "All The Things (Tyme's Love Tribute)" },
  {
    artist: "Eden Burns & Christopher Tubbs",
    title: "The Siren's Song",
    label: "PUBLIC POSSESSION",
  },
  { artist: "Brunello", title: "Helium" },
  { artist: "Brunello", title: "Melted", label: "MELLOW CIRCUS RECORDS" },
  { artist: "Brunello & Vargas", title: "Ghost Dance", label: "MELLOW CIRCUS RECORDS" },
  { artist: "Brunello", title: "11th Hour" },
  { artist: "Bill Loko", title: "Nen Lambo", mix: "Rampa vs &ME Edit", label: "VOD" },
  {
    artist: "Brunello & Connan",
    title: "The Clown's Corridor",
    label: "MELLOW CIRCUS RECORDS",
  },
  { artist: "Brunello", title: "Jester's Privilege", label: "MELLOW CIRCUS RECORDS" },
  { artist: "Tim Green & Sébastien Léger", title: "Duel", label: "FOR A MEMORY" },
  { artist: "Alex Kennon", title: "Blinding Lights (Joris Voorn Remix)", label: "SPECTRUM" },
  { artist: "Pele & Shawnecy", title: "Sixtynine", label: "TERMINAL M" },
  { artist: "Jesse Perez & Blue Mystic", title: "Esa Chiquita", label: "NO ART" },
  { artist: "Tiga", title: "FRICTION (Brunello Remix)", label: "TURBO" },
  { artist: "Unknown Artist", title: "ID [Set Extract @ 1:50:30]", isId: true },
  { artist: "Frankey & Sandrino", title: "Please", label: "REKIDS" },
] as const;

const SPOTIFY: Readonly<Record<number, SpotifyState>> = {
  1: matched(
    candidate(
      "33n31xg13MmN9Ewt57fes1",
      "Panic At The Disco",
      ["Jansons"],
      "The Extended Family (Miami Edition)",
      384_848,
      "GBQWD0706903",
      "2017-05-19",
    ),
  ),
  2: matched(
    candidate(
      "5W9Fo94yU2CsIaendtRRe6",
      "Sizzurp Overdose",
      ["Andre Butano", "Miguel Lobo"],
      "Sizzurp Overdose EP",
      410_593,
      "DEW871510073",
      "2015-06-29",
    ),
  ),
  3: matched(
    candidate(
      "0xog6AEOIgDCCb3gdCprMV",
      "Just For One Day",
      ["Paride Saraceni"],
      "ALL STARS 2017",
      422_400,
      "GBKQU1615572",
      "2016-12-12",
    ),
  ),
  4: matched(
    candidate(
      "00JxlzI5CgzGVhA6oMWGo1",
      "Melted (Dusty Clown Mix)",
      ["Brunello"],
      "Melted",
      387_840,
      "CA5KR2589099",
      "2025-09-05",
    ),
  ),
  5: matched(
    candidate(
      "6FTveMyq8szPAloptdZ17g",
      "Science Fiction",
      ["Brunello"],
      "Science Fiction",
      396_851,
      "QZVEM2622871",
      "2026-03-06",
    ),
  ),
  7: matched(
    candidate(
      "2qwpe0RTE2AJW7ZoaN9yLu",
      "I Like - Club Mix",
      ["Piero Pirupa", "Shield", "The Egyptian Lover", "Paris Brightledge"],
      "I Like",
      169_804,
      "ITJ782600041",
      "2026-06-19",
    ),
  ),
  8: matched(
    candidate(
      "6XRk6rd9IhdtVfQd45JFdi",
      "Apathy",
      ["Brunello", "Hilel Lev"],
      "Apathy",
      427_086,
      "QT2VB2652374",
      "2026-04-10",
    ),
  ),
  11: matched(
    candidate(
      "0JoJNum3aH8TGEmbDD0XfX",
      "All The Things (Tyme's Love Tribute)",
      ["Aman Umber"],
      "TELU01",
      254_500,
      "FR9W12448033",
      "2024-09-24",
    ),
  ),
  12: matched(
    candidate(
      "6wNUdWMhi6BqpBUR6Ewq02",
      "The Siren's Song",
      ["Eden Burns", "Christopher Tubbs"],
      "The Siren's Song",
      472_493,
      "DEVH21800438",
      "2022-01-21",
    ),
  ),
  14: matched(
    candidate(
      "2S6Yp0oUifZH2vWkVoRDHJ",
      "Melted",
      ["Brunello"],
      "Melted",
      457_322,
      "CA5KR2589098",
      "2025-09-05",
    ),
  ),
  15: matched(
    candidate(
      "3x6CEyquRREaQ9ZBbBhrGe",
      "Ghost Dance",
      ["Brunello", "Vargas"],
      "Ghost Dance",
      372_480,
      "QT62V2593429",
      "2025-12-26",
    ),
  ),
  17: ambiguous([
    candidate(
      "5gfHUwaCW9by1rL0Wi61KJ",
      "Nen Lambo - Rampa vs &ME Edit",
      ["Bill Loko", "Rampa", "&ME"],
      "Won’t Change / Nen Lambo",
      375_609,
      "DEEC32000011",
      "2020-07-24",
      0.897,
    ),
    candidate(
      "3I9WmdmUmEbpIpjjwWEWTR",
      "Nen Lambo (Rampa vs &ME Edit) [Mixed]",
      ["Bill Loko"],
      "Angelos Celebration Mix",
      346_235,
      "QM24S2300834",
      "2023-03-01",
      0.823,
    ),
  ]),
  18: matched(
    candidate(
      "4nCO6fJEjqZv7OJzV7LBEd",
      "The Clown's Corridor",
      ["Brunello", "Connan"],
      "The Clown's Corridor",
      351_967,
      "CA5KR2483637",
      "2024-08-30",
    ),
  ),
  19: matched(
    candidate(
      "6TipVm7dz9Z6CZaUBK3Rb5",
      "Jester's Privilege",
      ["Brunello"],
      "Jester's Privilege",
      371_250,
      "CA5KR2541951",
      "2025-07-25",
    ),
  ),
  20: ambiguous([
    candidate(
      "1qC3qRlsg8SiG3jhUtApKm",
      "Duel",
      ["Tim Green", "Sébastien Léger"],
      "Duel",
      574_838,
      "QM4TX2286317",
      "2022-05-20",
    ),
    candidate(
      "3lEQ7HZ4Hg57JCIO9aMHmp",
      "Duel - Mixed",
      ["Sébastien Léger", "Tim Green"],
      "Balance 031",
      405_853,
      "AUXN22303907",
      "2023-05-05",
      0.926,
    ),
  ]),
  21: matched(
    candidate(
      "0fZ19tHX4FSslZn8EeKCpo",
      "Blinding Lights - Joris Voorn Remix",
      ["Alex Kennon", "Joris Voorn"],
      "Blinding Lights (Joris Voorn Remix)",
      313_748,
      "NLEW22100004",
      "2021-04-02",
    ),
  ),
  22: ambiguous([
    candidate(
      "4FY48kU4f319zpUKQfyMkA",
      "Sixtynine",
      ["Pele", "Shawnecy"],
      "15 Years of Terminal M - A-Sides, Vol. 2",
      450_327,
      "DEBG51200157",
      "2016-01-11",
    ),
    candidate(
      "0OfGtjW1hQi0atXGiO3ozg",
      "Sixtynine",
      ["Pele & Shawnecy"],
      "Organic Creations Issue 1",
      450_327,
      "DEW871605678",
      "2016-10-21",
    ),
  ]),
  23: matched(
    candidate(
      "73nYQgfeifQwPcBcsk20V7",
      "Esa Chiquita",
      ["Jesse Perez", "Blue Mystic"],
      "Esa Chiquita",
      211_487,
      "CBEFB2600546",
      "2026-02-27",
    ),
  ),
  26: matched(
    candidate(
      "5hYQDHLyGqyiwLutvCVtCo",
      "Please",
      ["Frankey & Sandrino"],
      "Please EP",
      261_464,
      "GBLTF2500134",
      "2025-10-10",
    ),
  ),
};

const CLIP_ORDERS = new Set([6, 9, 10, 13, 16, 24, 25]);
const AUDITED_YOUTUBE_IDS: Readonly<Record<string, string>> = {
  "33n31xg13MmN9Ewt57fes1": "QHrDOvp789Q",
  "5W9Fo94yU2CsIaendtRRe6": "_Wx_POJn8m4",
  "0xog6AEOIgDCCb3gdCprMV": "lI5LQNYRsOQ",
  "00JxlzI5CgzGVhA6oMWGo1": "CGINl4_D5kc",
  "6FTveMyq8szPAloptdZ17g": "7CUTn0q-j0w",
  "2qwpe0RTE2AJW7ZoaN9yLu": "5l113bG5AW0",
  "6XRk6rd9IhdtVfQd45JFdi": "QFEE4Eoh01E",
  "0JoJNum3aH8TGEmbDD0XfX": "25BtFGPvYKc",
  "6wNUdWMhi6BqpBUR6Ewq02": "tUN0FmDSYFo",
  "2S6Yp0oUifZH2vWkVoRDHJ": "yaBDAR-PQz4",
  "3x6CEyquRREaQ9ZBbBhrGe": "irDsRokzylg",
  "5gfHUwaCW9by1rL0Wi61KJ": "Tr4FXgoPGRU",
  "4nCO6fJEjqZv7OJzV7LBEd": "zmvCLvgBmsA",
  "6TipVm7dz9Z6CZaUBK3Rb5": "OhVfMqRK-9c",
  "1qC3qRlsg8SiG3jhUtApKm": "Eh6mUSrqSbo",
  "3lEQ7HZ4Hg57JCIO9aMHmp": "pfhqjiTsdB0",
  "0fZ19tHX4FSslZn8EeKCpo": "7tkClpC6LHs",
  "4FY48kU4f319zpUKQfyMkA": "EU7z1CowU0k",
  "0OfGtjW1hQi0atXGiO3ozg": "-weQhOQgLFI",
  "73nYQgfeifQwPcBcsk20V7": "XbFwdUKR660",
  "5hYQDHLyGqyiwLutvCVtCo": "UGial643_n0",
};
const AUDITED_YOUTUBE_DURATIONS: Readonly<Record<string, number>> = {
  QHrDOvp789Q: 385,
  _Wx_POJn8m4: 411,
  lI5LQNYRsOQ: 422,
  CGINl4_D5kc: 388,
  "7CUTn0q-j0w": 397,
  "5l113bG5AW0": 170,
  QFEE4Eoh01E: 427,
  "25BtFGPvYKc": 260,
  tUN0FmDSYFo: 472,
  "yaBDAR-PQz4": 457,
  irDsRokzylg: 372,
  Tr4FXgoPGRU: 376,
  zmvCLvgBmsA: 352,
  "OhVfMqRK-9c": 371,
  Eh6mUSrqSbo: 575,
  pfhqjiTsdB0: 406,
  "7tkClpC6LHs": 314,
  EU7z1CowU0k: 450,
  "-weQhOQgLFI": 450,
  XbFwdUKR660: 211,
  UGial643_n0: 262,
};

export function reconcileBrunelloManifest(value: SetManifest): SetManifest {
  const manifest = structuredClone(value);
  if (manifest.entries.length !== 26) {
    throw new Error(`Brunello tracklist must contain 26 entries; got ${manifest.entries.length}`);
  }
  manifest.source = {
    input: BRUNELLO_YOUTUBE_URL,
    id: "baDz12J2uNo",
    url: BRUNELLO_YOUTUBE_URL,
    title: BRUNELLO_SET_TITLE,
    uploader: "Brunello",
    date: "2026-05-23",
    lineup: ["Brunello"],
    durationSeconds: SET_DURATION,
  };
  manifest.tracklist = {
    provider: "agent",
    url: BRUNELLO_1001_URL,
    complete: true,
  };
  manifest.artifacts = {
    ...manifest.artifacts,
    root: BRUNELLO_ROOT,
    manifest: BRUNELLO_MANIFEST_PATH,
    downloadDirectory: join(BRUNELLO_ROOT, "tracks"),
    sourceSet: {
      url: BRUNELLO_SOUNDCLOUD_URL,
      path: BRUNELLO_SOURCE_PATH,
      sha256: "adba80567b261bfd07e3108a52f43b95d0dc02da5da95cc383e0006b6aaae0fd",
      durationSeconds: 7064.267755,
      codec: "mp3",
      bitrate: 128_000,
    },
  };
  addUnique(manifest.warnings, `Tracklist resolved from ${BRUNELLO_1001_URL}`);
  addUnique(
    manifest.warnings,
    "Soulseek skipped because SLSK_USERNAME/SLSK_PASSWORD are not configured; using ytdlp fallback.",
  );

  for (const [index, entry] of manifest.entries.entries()) {
    const order = index + 1;
    if (entry.order !== order)
      throw new Error(`Unexpected entry order ${entry.order} at index ${index}`);
    const definition = IDENTITIES[index]!;
    const startSeconds = CUE_STARTS[index]!;
    const endSeconds = CUE_STARTS[index + 1] ?? SET_DURATION;
    entry.cue = {
      timestamp: formatTimestamp(startSeconds),
      startSeconds,
      endSeconds,
    };
    entry.identity = identity(definition);
    entry.spotify = spotifyForOrder(order, definition);
    if (entry.acquisition.status !== "downloaded") {
      entry.acquisition = definition.isId
        ? { status: "pending", query: definition.title }
        : { status: "pending", query: searchQuery(definition) };
      entry.errors = entry.errors.filter((error) => error.stage !== "acquisition");
    }
    if (order === 10) {
      addUnique(
        entry.warnings,
        'Identity conflict: 1001Tracklists/social metadata says "Clown Shoes"; SoundCloud cue description says "This Is The Way (Unreleased)". Preserved canonical 1001Tracklists identity.',
      );
    }
  }
  return parseManifest(manifest);
}

export function buildBrunelloAcquisitionPlan(manifest: SetManifest): AcquisitionPlan {
  const outputDirectory = join(BRUNELLO_ROOT, "tracks");
  const clips = manifest.entries
    .filter((entry) => CLIP_ORDERS.has(entry.order))
    .map((entry) => {
      const definition = IDENTITIES[entry.order - 1]!;
      const startSeconds = entry.cue.startSeconds!;
      const endSeconds = entry.cue.endSeconds!;
      const metadata = clipMetadata(definition, entry.order, startSeconds, endSeconds);
      return {
        entryOrder: entry.order,
        sourcePath: BRUNELLO_SOURCE_PATH,
        sourceUrl: BRUNELLO_SOUNDCLOUD_URL,
        sourceTitle: BRUNELLO_SET_TITLE,
        outputPath: join(
          outputDirectory,
          `${String(entry.order).padStart(2, "0")} - ${safeFilename(`${metadata.artists[0]} - ${metadata.title}`)} [set-extract].mp3`,
        ),
        startSeconds,
        endSeconds,
        metadata,
        qualityNote: "Lossy 128 kbps MP3 set recording; mix transitions may be present.",
        containsTransitions: true,
      };
    });

  const recordings = manifest.entries.flatMap((entry) => {
    const candidates =
      entry.spotify.status === "matched"
        ? [spotifyStateCandidate(entry.spotify)]
        : entry.spotify.status === "ambiguous"
          ? entry.spotify.candidates
          : [];
    if (!candidates.length) return [];
    return [
      {
        entryOrder: entry.order,
        variants: candidates.map((track) => recordingVariant(outputDirectory, entry.order, track)),
      },
    ];
  });
  return {
    clips,
    recordings,
    stagingDirectory: join(BRUNELLO_ROOT, ".staging"),
    sourceSets: [
      {
        path: BRUNELLO_SOURCE_PATH,
        sha256: "adba80567b261bfd07e3108a52f43b95d0dc02da5da95cc383e0006b6aaae0fd",
        durationSeconds: 7064.267755,
        codec: "mp3",
        bitrate: 128_000,
      },
    ],
  };
}

function identity(definition: IdentityDefinition): TrackIdentity {
  if (definition.isId) {
    return {
      status: "unidentified",
      isId: true,
      artist: definition.artist,
      title: definition.title,
    };
  }
  return {
    status: "identified",
    artist: definition.artist,
    title: definition.title,
    ...(definition.mix ? { mix: definition.mix } : {}),
    ...(definition.label ? { label: definition.label } : {}),
    searchQuery: searchQuery(definition),
  };
}

function spotifyForOrder(order: number, definition: IdentityDefinition): SpotifyState {
  const known = SPOTIFY[order];
  if (known) return structuredClone(known);
  if (definition.isId) return { status: "skipped", reason: "Unidentified 1001Tracklists entry" };
  return { status: "unmatched", query: spotifyQuery(definition) };
}

function matched(track: SpotifyCandidate): SpotifyState {
  return {
    status: "matched",
    query: `spotify:track:${track.id}`,
    ...track,
    candidates: [track],
  };
}

function ambiguous(candidates: SpotifyCandidate[]): SpotifyState {
  return {
    status: "ambiguous",
    query: candidates.map((track) => `spotify:track:${track.id}`).join(" OR "),
    candidates,
  };
}

function candidate(
  id: string,
  name: string,
  artists: string[],
  album: string,
  durationMs: number,
  isrc: string,
  releaseDate: string,
  score = 1,
): SpotifyCandidate {
  return {
    score,
    id,
    uri: `spotify:track:${id}`,
    url: `https://open.spotify.com/track/${id}`,
    name,
    artists,
    album,
    releaseDate,
    durationMs,
    explicit: false,
    isrc,
  };
}

function spotifyStateCandidate(
  state: Extract<SpotifyState, { status: "matched" }>,
): SpotifyCandidate {
  return {
    score: state.score,
    id: state.id,
    uri: state.uri,
    ...(state.url ? { url: state.url } : {}),
    name: state.name ?? state.id,
    artists: state.artists ?? ["Unknown Artist"],
    ...(state.album ? { album: state.album } : {}),
    ...(state.albumArtists?.length ? { albumArtists: state.albumArtists } : {}),
    ...(state.releaseDate ? { releaseDate: state.releaseDate } : {}),
    ...(state.durationMs === undefined ? {} : { durationMs: state.durationMs }),
    ...(state.explicit === undefined ? {} : { explicit: state.explicit }),
    ...(state.isrc ? { isrc: state.isrc } : {}),
  };
}

function recordingVariant(
  outputDirectory: string,
  order: number,
  track: SpotifyCandidate,
): AcquisitionRecordingVariant {
  if (track.id === "3I9WmdmUmEbpIpjjwWEWTR") {
    const startSeconds = CUE_STARTS[order - 1]!;
    const endSeconds = CUE_STARTS[order] ?? SET_DURATION;
    const title = `${track.name} [Set Extract]`;
    return {
      spotifyId: track.id,
      title: track.name,
      artists: track.artists,
      ...(track.album ? { album: track.album } : {}),
      ...(track.releaseDate ? { releaseDate: track.releaseDate } : {}),
      ...(track.durationMs === undefined ? {} : { durationMs: track.durationMs }),
      outputPath: join(
        outputDirectory,
        `${String(order).padStart(2, "0")} - ${safeFilename(`${track.artists.join(", ")} - ${title}`)} [spotify-${track.id}] [set-extract].mp3`,
      ),
      metadata: {
        title,
        artists: track.artists,
        album: BRUNELLO_SET_TITLE,
        comment: [
          "[Set Extract]",
          `Intended Spotify reference: https://open.spotify.com/track/${track.id}`,
          `Source: ${BRUNELLO_SET_TITLE}`,
          `Source URL: ${BRUNELLO_SOUNDCLOUD_URL}`,
          `Set range: ${formatTimestamp(startSeconds)}–${formatTimestamp(endSeconds)}`,
          "Quality: lossy set recording; transitions may be present; not a verified release master",
        ].join("\n"),
        trackNumber: order,
        trackTotal: 26,
        grouping: "tracks-ts set extract",
      },
      searchQuery: `${track.artists.join(" ")} ${track.name}`,
      sourceClip: {
        sourcePath: BRUNELLO_SOURCE_PATH,
        sourceUrl: BRUNELLO_SOUNDCLOUD_URL,
        sourceTitle: BRUNELLO_SET_TITLE,
        startSeconds,
        endSeconds,
        qualityNote:
          "Lossy 128 kbps MP3 set recording; mix transitions may be present; not a verified release master.",
        containsTransitions: true,
      },
    };
  }
  const filename = `${String(order).padStart(2, "0")} - ${safeFilename(`${track.artists.join(", ")} - ${track.name}`)} [spotify-${track.id}].m4a`;
  const youtubeId = AUDITED_YOUTUBE_IDS[track.id];
  return {
    spotifyId: track.id,
    ...(track.isrc ? { isrc: track.isrc } : {}),
    title: track.name,
    artists: track.artists,
    ...(track.album ? { album: track.album } : {}),
    ...(track.releaseDate ? { releaseDate: track.releaseDate } : {}),
    ...(track.durationMs === undefined ? {} : { durationMs: track.durationMs }),
    outputPath: join(outputDirectory, filename),
    metadata: {
      title: track.name,
      artists: track.artists,
      ...(track.album ? { album: track.album } : {}),
      ...(track.releaseDate ? { releaseDate: track.releaseDate } : {}),
      ...(track.isrc ? { isrc: track.isrc } : {}),
      comment: individualComment(track),
      trackNumber: order,
      trackTotal: 26,
      grouping: "tracks-ts resolved set",
    },
    searchQuery: `${track.artists.join(" ")} ${track.name}`,
    ...(youtubeId
      ? {
          preferredCandidate: {
            backend: "ytdlp",
            id: youtubeId,
            source: `https://www.youtube.com/watch?v=${youtubeId}`,
            title: track.name,
            artist: track.artists.join(", "),
            ...(AUDITED_YOUTUBE_DURATIONS[youtubeId] === undefined
              ? {}
              : { durationSeconds: AUDITED_YOUTUBE_DURATIONS[youtubeId] }),
          },
        }
      : {}),
  };
}

function clipMetadata(
  definition: IdentityDefinition,
  order: number,
  startSeconds: number,
  endSeconds: number,
): AudioMetadata {
  return {
    title: definition.title,
    artists: definition.isId ? ["Unknown Artist"] : [definition.artist],
    album: BRUNELLO_SET_TITLE,
    comment: [
      "[Set Extract]",
      `Source: ${BRUNELLO_SET_TITLE}`,
      `Source URL: ${BRUNELLO_SOUNDCLOUD_URL}`,
      `Set range: ${formatTimestamp(startSeconds)}–${formatTimestamp(endSeconds)}`,
      "Quality: lossy set recording; transitions may be present",
    ].join("\n"),
    trackNumber: order,
    trackTotal: 26,
    grouping: "tracks-ts set extract",
  };
}

function individualComment(track: SpotifyCandidate): string {
  return [
    "[Spotify Enriched]",
    `Spotify: https://open.spotify.com/track/${track.id}`,
    ...(track.isrc ? [`ISRC: ${track.isrc}`] : []),
    `Tracklist: ${BRUNELLO_1001_URL}`,
  ].join("\n");
}

function searchQuery(definition: IdentityDefinition): string {
  return `${definition.artist} - ${definition.title}${definition.mix ? ` (${definition.mix})` : ""}`;
}

function spotifyQuery(definition: IdentityDefinition): string {
  return `track:${JSON.stringify(definition.title)} artist:${JSON.stringify(definition.artist)}`;
}

function addUnique(values: string[], value: string): void {
  if (!values.includes(value)) values.push(value);
}
