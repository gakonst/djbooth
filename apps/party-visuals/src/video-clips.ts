export type VideoClip = {
  /** YouTube video ID; the URL stays available when embedding is restricted. */
  id: string;
  title: string;
  url: string;
  matches: string[];
};

// Artist-channel sources verified through YouTube's oEmbed metadata. Original
// music videos also accompany remixes/edits as muted related footage.
const video = (id: string, title: string, ...matches: string[]): VideoClip => ({
  id,
  title,
  url: `https://www.youtube.com/watch?v=${id}`,
  matches,
});

export const VIDEO_CLIPS: VideoClip[] = [
  video("wagn8Wrmzuc", "Lady Gaga — Judas", "judas"),
  video("sOnqjkJTMaA", "Michael Jackson — Thriller", "thriller"),
  video("E1mU6h4Xdxc", "Rihanna — Disturbia", "disturbia"),
  video("auzfTPp4moA", "Yeah Yeah Yeahs — Heads Will Roll", "heads will roll"),
  video("7YvAYIJSSZY", "Rockwell — Somebody’s Watching Me", "somebody's watching me"),
  video("VbD_kBJc_gI", "David Bowie — Let’s Dance", "let's dance"),
  video(
    "6M6samPEMpM",
    "Backstreet Boys — Everybody (Backstreet’s Back)",
    "everybody backstreet's back",
  ),
  video("PLolag3YSYU", "Nelly Furtado — Maneater", "maneater"),
  video("elueA2rofoo", "Britney Spears — Gimme More", "gimme more"),
  video("qeMFqkcPYcg", "Eurythmics — Sweet Dreams", "sweet dreams are made of this"),
  video("3tmd-ClpJxA", "Taylor Swift — Look What You Made Me Do", "look what you made me do"),
  video("DyDfgMOUjCI", "Billie Eilish — bad guy", "bad guy"),
  video("HUHC9tYz8ik", "Billie Eilish — bury a friend", "bury a friend"),
  video("4NRXx6U8ABQ", "The Weeknd — Blinding Lights", "blinding lights"),
  video("Zi_XLOBDo_Y", "Michael Jackson — Billie Jean", "billie jean"),
  video("K0HSD_i2DvA", "Daft Punk — Around the World", "around the world"),
  video("EDwb9jOVRtU", "Madonna — Hung Up", "hung up"),
  video("GuJQSAiODqI", "Madonna — Vogue", "vogue"),
  video("dX3k_QDnzHE", "M83 — Midnight City", "midnight city"),
  video("hN5X4kGhAtU", "Empire of the Sun — We Are the People", "we are the people"),
  video("sOS9aOIXPEk", "Daft Punk — Something About Us", "something about us"),
  video("XEjLoHdbVeE", "ABBA — Gimme! Gimme! Gimme!", "gimme gimme gimme"),
  video(
    "hAx6mYeC6pY",
    "Sophie Ellis-Bextor — Murder on the Dancefloor",
    "murder on the dancefloor",
  ),
  video("HyHNuVaZJ-k", "Gorillaz — Feel Good Inc.", "feel good inc"),
  video("Ijk4j-r7qPA", "Franz Ferdinand — Take Me Out", "take me out"),
  video("HZwMX6T5Jhk", "Kanye West — Love Lockdown", "love lockdown"),
  video("SDTZ7iX4vTQ", "Foster the People — Pumped Up Kicks", "pumped up kicks"),
  video("T_DDaVpYiVY", "Bob Sinclar — Rock This Party", "rock this party"),
  video("sTJ1XwGDcA4", "Kool & the Gang — Fresh", "fresh"),
  video("0J3vgcE5i2o", "Nelly Furtado — Promiscuous", "promiscuous"),
  video(
    "LaTGrV58wec",
    "C+C Music Factory — Gonna Make You Sweat",
    "gonna make you sweat",
    "gonna make u sweat",
  ),
  video("5WeCorPABHA", "Deep Dish — Flashdance", "flashdance"),
  video("X8LUd51IuiA", "Sage the Gemini — Gas Pedal", "gas pedal"),
];

const normalize = (text: string) =>
  text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

export function clipForTrack(
  track: { title: string | null; artist: string | null } | null,
): VideoClip | null {
  if (!track?.title) return null;
  const title = ` ${normalize(track.title)} `;
  return (
    VIDEO_CLIPS.find((clip) =>
      clip.matches.some((match) => title.includes(` ${normalize(match)} `)),
    ) ?? null
  );
}

/** Title similarity alone cannot establish an exact recording match. */
export function isOriginalVideoMatch(
  track: { title: string | null; artist: string | null },
  clip: VideoClip,
): boolean {
  const title = normalize(track.title ?? "");
  if (/\b(remix|mix|edit|rework|dub|vip|mashup|cover|version|live|extract)\b/.test(title))
    return false;
  const artist = normalize(clip.title.split(" — ")[0]!);
  return normalize(track.artist ?? "").includes(artist) || title.includes(artist);
}
