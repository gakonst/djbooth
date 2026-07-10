#!/usr/bin/env node

import { Cli, z } from "incur";

import { RekordboxXml, updateConfig, version } from "./index.js";
import type { NodeKeyType, TrackAttributes, TrackSelector } from "./index.js";

const cli = Cli.create("rekordbox", {
  version,
  description: "Inspect and modify Rekordbox libraries and export formats.",
  sync: {
    suggestions: [
      "inspect my Rekordbox configuration",
      "summarize a Rekordbox XML export",
      "inspect an ANLZ file",
      "list playlists in my Rekordbox library",
    ],
  },
});

cli.command("status", {
  description: "Show implementation and runtime status.",
  output: z.object({
    name: z.string(),
    version: z.string(),
    runtime: z.string(),
    phase: z.string(),
  }),
  run() {
    return {
      name: "@gakonst/rekordbox",
      version,
      runtime: process.version,
      phase: "active-port",
    };
  },
});

const configCli = Cli.create("config", {
  description: "Discover Rekordbox installations and library paths.",
}).command("show", {
  description: "Show detected Rekordbox paths and versions.",
  options: z.object({
    appDir: z.string().optional().describe("Pioneer application-data directory"),
    installDir: z.string().optional().describe("Pioneer/Rekordbox installation root"),
    rekordbox5Dirname: z.string().optional().describe("Exact Rekordbox 5 directory name"),
    rekordbox6Dirname: z.string().optional().describe("Exact Rekordbox 6 directory name"),
    rekordbox7Dirname: z.string().optional().describe("Exact Rekordbox 7 directory name"),
  }),
  examples: [{ description: "Auto-detect Rekordbox installations" }],
  run(c) {
    return updateConfig({
      pioneerAppDir: c.options.appDir,
      pioneerInstallDir: c.options.installDir,
      rekordbox5Dirname: c.options.rekordbox5Dirname,
      rekordbox6Dirname: c.options.rekordbox6Dirname,
      rekordbox7Dirname: c.options.rekordbox7Dirname,
    });
  },
});

cli.command(configCli);

function playlistPath(xml: RekordboxXml, path: string | undefined) {
  return path ? xml.getPlaylist(...path.split("/").filter(Boolean)) : xml.rootPlaylistFolder;
}

function trackSelector(options: {
  index?: number;
  location?: string;
  trackId?: number;
}): TrackSelector {
  if (options.trackId !== undefined) return { trackId: options.trackId };
  if (options.location !== undefined) return { location: options.location };
  return { index: options.index ?? 0 };
}

const xmlCli = Cli.create("xml", {
  description: "Read and write Rekordbox collection XML files.",
});

xmlCli.command("info", {
  description: "Show collection, product, and playlist metadata.",
  args: z.object({ path: z.string().describe("Rekordbox XML file") }),
  run(c) {
    return new RekordboxXml(c.args.path).summary();
  },
});

xmlCli.command("tracks", {
  description: "List typed collection track metadata.",
  args: z.object({ path: z.string().describe("Rekordbox XML file") }),
  options: z.object({
    limit: z.number().int().min(1).max(10_000).default(100).describe("Maximum tracks to return"),
    offset: z.number().int().min(0).default(0).describe("Tracks to skip"),
  }),
  run(c) {
    const xml = new RekordboxXml(c.args.path);
    return {
      count: xml.numTracks,
      limit: c.options.limit,
      offset: c.options.offset,
      tracks: xml.getTracks().slice(c.options.offset, c.options.offset + c.options.limit),
    };
  },
});

xmlCli.command("playlists", {
  description: "Show a playlist subtree.",
  args: z.object({ path: z.string().describe("Rekordbox XML file") }),
  options: z.object({
    playlist: z.string().optional().describe("Slash-delimited playlist path"),
  }),
  run(c) {
    const xml = new RekordboxXml(c.args.path);
    const node = playlistPath(xml, c.options.playlist);
    return { node: node.toJSON(), tree: node.treeString() };
  },
});

xmlCli.command("create", {
  description: "Create an empty Rekordbox XML file.",
  args: z.object({ output: z.string().describe("Destination XML file") }),
  options: z.object({
    company: z.string().default("").describe("Product company"),
    formatVersion: z.string().default("1.0.0").describe("Rekordbox XML format version"),
    name: z.string().default("rekordbox-ts").describe("Product name"),
    version: z.string().default("0.0.0").describe("Product version"),
  }),
  run(c) {
    const xml = new RekordboxXml({
      company: c.options.company,
      formatVersion: c.options.formatVersion,
      name: c.options.name,
      version: c.options.version,
    });
    xml.save(c.args.output);
    return { output: c.args.output, ...xml.summary() };
  },
});

const xmlTrackCli = Cli.create("track", {
  description: "Inspect and mutate XML collection tracks.",
});

xmlTrackCli.command("show", {
  description: "Show one track selected by index, ID, or location.",
  args: z.object({ path: z.string().describe("Rekordbox XML file") }),
  options: z.object({
    index: z.number().int().min(0).optional().describe("Zero-based collection index"),
    location: z.string().optional().describe("Track filesystem location"),
    trackId: z.number().int().optional().describe("Track ID"),
  }),
  run(c) {
    return new RekordboxXml(c.args.path).getTrack(trackSelector(c.options));
  },
});

xmlTrackCli.command("add", {
  description: "Add a track and save the XML document.",
  args: z.object({
    path: z.string().describe("Rekordbox XML file"),
    location: z.string().describe("Audio-file location"),
  }),
  options: z.object({
    album: z.string().optional().describe("Album"),
    artist: z.string().optional().describe("Artist"),
    genre: z.string().optional().describe("Genre"),
    name: z.string().optional().describe("Track title"),
    output: z.string().optional().describe("Destination; defaults to the source file"),
    rating: z.number().int().min(0).max(5).optional().describe("Rating from zero to five"),
    trackId: z.number().int().positive().optional().describe("Explicit track ID"),
  }),
  run(c) {
    const xml = new RekordboxXml(c.args.path);
    const attributes: TrackAttributes = {
      Album: c.options.album,
      Artist: c.options.artist,
      Genre: c.options.genre,
      Name: c.options.name,
      Rating: c.options.rating,
      TrackID: c.options.trackId,
    };
    const track = xml.addTrack(c.args.location, attributes);
    const output = c.options.output ?? c.args.path;
    xml.save(output);
    return { output, track };
  },
});

xmlTrackCli.command("remove", {
  description: "Remove a track and save the XML document.",
  args: z.object({ path: z.string().describe("Rekordbox XML file") }),
  options: z.object({
    location: z.string().optional().describe("Track filesystem location"),
    output: z.string().optional().describe("Destination; defaults to the source file"),
    trackId: z.number().int().optional().describe("Track ID"),
  }),
  run(c) {
    if (c.options.trackId === undefined && c.options.location === undefined)
      throw new TypeError("Either --track-id or --location is required");
    const xml = new RekordboxXml(c.args.path);
    const selector: TrackSelector =
      c.options.trackId !== undefined
        ? { trackId: c.options.trackId }
        : { location: c.options.location! };
    const track = xml.getTrack(selector);
    const removed = track.toJSON();
    xml.removeTrack(track);
    const output = c.options.output ?? c.args.path;
    xml.save(output);
    return { output, removed };
  },
});

const xmlPlaylistCli = Cli.create("playlist", {
  description: "Inspect and mutate XML playlists and folders.",
});

xmlPlaylistCli.command("add", {
  description: "Add a playlist or folder and save the XML document.",
  args: z.object({
    path: z.string().describe("Rekordbox XML file"),
    name: z.string().describe("New playlist or folder name"),
  }),
  options: z.object({
    folder: z.boolean().default(false).describe("Create a folder instead of a playlist"),
    keyType: z.enum(["TrackID", "Location"]).default("TrackID").describe("Playlist key type"),
    output: z.string().optional().describe("Destination; defaults to the source file"),
    parent: z.string().optional().describe("Slash-delimited parent folder path"),
  }),
  run(c) {
    const xml = new RekordboxXml(c.args.path);
    const parent = playlistPath(xml, c.options.parent);
    const node = c.options.folder
      ? parent.addPlaylistFolder(c.args.name)
      : parent.addPlaylist(c.args.name, c.options.keyType as NodeKeyType);
    const output = c.options.output ?? c.args.path;
    xml.save(output);
    return { node: node.toJSON(), output };
  },
});

xmlPlaylistCli.command("remove", {
  description: "Remove a playlist or folder and save the XML document.",
  args: z.object({
    path: z.string().describe("Rekordbox XML file"),
    name: z.string().describe("Playlist or folder name"),
  }),
  options: z.object({
    output: z.string().optional().describe("Destination; defaults to the source file"),
    parent: z.string().optional().describe("Slash-delimited parent folder path"),
  }),
  run(c) {
    const xml = new RekordboxXml(c.args.path);
    playlistPath(xml, c.options.parent).removePlaylist(c.args.name);
    const output = c.options.output ?? c.args.path;
    xml.save(output);
    return { output, removed: c.args.name };
  },
});

xmlPlaylistCli.command("add-track", {
  description: "Add a track key to a playlist and save the XML document.",
  args: z.object({
    path: z.string().describe("Rekordbox XML file"),
    playlist: z.string().describe("Slash-delimited playlist path"),
    key: z.string().describe("Track ID or location, according to playlist KeyType"),
  }),
  options: z.object({
    output: z.string().optional().describe("Destination; defaults to the source file"),
  }),
  run(c) {
    const xml = new RekordboxXml(c.args.path);
    const playlist = playlistPath(xml, c.args.playlist);
    const key = playlist.keyType === "TrackID" ? Number.parseInt(c.args.key, 10) : c.args.key;
    playlist.addTrack(key);
    const output = c.options.output ?? c.args.path;
    xml.save(output);
    return { entries: playlist.entries, key, output, playlist: c.args.playlist };
  },
});

xmlPlaylistCli.command("remove-track", {
  description: "Remove a track key from a playlist and save the XML document.",
  args: z.object({
    path: z.string().describe("Rekordbox XML file"),
    playlist: z.string().describe("Slash-delimited playlist path"),
    key: z.string().describe("Track ID or location, according to playlist KeyType"),
  }),
  options: z.object({
    output: z.string().optional().describe("Destination; defaults to the source file"),
  }),
  run(c) {
    const xml = new RekordboxXml(c.args.path);
    const playlist = playlistPath(xml, c.args.playlist);
    const key = playlist.keyType === "TrackID" ? Number.parseInt(c.args.key, 10) : c.args.key;
    playlist.removeTrack(key);
    const output = c.options.output ?? c.args.path;
    xml.save(output);
    return { entries: playlist.entries, key, output, playlist: c.args.playlist };
  },
});

xmlCli.command(xmlTrackCli);
xmlCli.command(xmlPlaylistCli);
cli.command(xmlCli);

cli.serve();

export default cli;
