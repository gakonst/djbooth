#!/usr/bin/env node

import { Cli, z } from "incur";

import {
  AnlzFile,
  BeatGridTag,
  createMySettingFile,
  getAnlzPaths,
  getMySettingPaths,
  LogicalOperator,
  readMySettingFile,
  RekordboxXml,
  SmartList,
  updateConfig,
  version,
  walkAnlzDirectories,
} from "./index.js";
import type {
  ConditionInput,
  MySettingFilename,
  NodeKeyType,
  TrackAttributes,
  TrackSelector,
} from "./index.js";

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

const settingsCli = Cli.create("settings", {
  description: "Read and write Rekordbox My Settings binary files.",
});

settingsCli.command("list", {
  description: "Find My Settings files below a directory.",
  args: z.object({ root: z.string().describe("Directory to scan") }),
  options: z.object({ deep: z.boolean().default(false).describe("Scan recursively") }),
  run(c) {
    const paths = getMySettingPaths(c.args.root, c.options.deep);
    return { count: paths.length, paths };
  },
});

settingsCli.command("show", {
  description: "Parse and show a My Settings file.",
  args: z.object({ path: z.string().describe("Settings file") }),
  run(c) {
    const file = readMySettingFile(c.args.path);
    return {
      ...file.toJSON(),
      allowedValues: Object.fromEntries(file.keys().map((key) => [key, file.allowedValues(key)])),
    };
  },
});

settingsCli.command("set", {
  description: "Update one setting and write a checksummed binary.",
  args: z.object({
    path: z.string().describe("Settings file"),
    key: z.string().describe("Setting name"),
    value: z.string().describe("Symbolic setting value"),
  }),
  options: z.object({
    output: z.string().optional().describe("Destination; defaults to the source file"),
  }),
  run(c) {
    const file = readMySettingFile(c.args.path);
    file.set(c.args.key, c.args.value);
    const output = c.options.output ?? c.args.path;
    file.save(output);
    return { output, ...file.toJSON() };
  },
});

settingsCli.command("create", {
  description: "Create a default My Settings binary.",
  args: z.object({
    filename: z
      .enum(["MYSETTING.DAT", "MYSETTING2.DAT", "DJMMYSETTING.DAT", "DEVSETTING.DAT"])
      .describe("Settings format"),
    output: z.string().describe("Destination file"),
  }),
  options: z.object({
    version: z.string().optional().describe("DEVSETTING Rekordbox version"),
  }),
  run(c) {
    const file = createMySettingFile(c.args.filename as MySettingFilename);
    if (c.options.version !== undefined) file.version = c.options.version;
    file.save(c.args.output);
    return { output: c.args.output, ...file.toJSON() };
  },
});

cli.command(settingsCli);

function paginateTagValue(value: unknown, offset: number, limit: number): unknown {
  if (Array.isArray(value))
    return { count: value.length, items: value.slice(offset, offset + limit), limit, offset };
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        Array.isArray(item) ? item.slice(offset, offset + limit) : item,
      ]),
    );
  return value;
}

function numberList(value: string): Array<number> {
  const values = value.split(",").map((item) => Number(item.trim()));
  if (values.some((item) => !Number.isFinite(item)))
    throw new TypeError(`Invalid comma-separated number list '${value}'`);
  return values;
}

const anlzCli = Cli.create("anlz", {
  description: "Read and write Rekordbox ANLZ analysis files.",
});

anlzCli.command("scan", {
  description: "Find directories and DAT/EXT/2EX files recursively.",
  args: z.object({ root: z.string().describe("USBANLZ root directory") }),
  run(c) {
    const directories = walkAnlzDirectories(c.args.root).map((directory) => ({
      directory,
      files: getAnlzPaths(directory),
    }));
    return { count: directories.length, directories };
  },
});

anlzCli.command("info", {
  description: "Show bounded ANLZ file and tag metadata.",
  args: z.object({ path: z.string().describe("ANLZ DAT, EXT, or 2EX file") }),
  run(c) {
    return AnlzFile.parseFile(c.args.path).summary();
  },
});

anlzCli.command("tag", {
  description: "Parse one tag by four-character type or semantic name.",
  args: z.object({
    path: z.string().describe("ANLZ DAT, EXT, or 2EX file"),
    key: z.string().describe("Tag type such as PQTZ or name such as beat_grid"),
  }),
  options: z.object({
    limit: z.number().int().min(1).max(100_000).default(1_000).describe("Array items to return"),
    offset: z.number().int().min(0).default(0).describe("Array items to skip"),
  }),
  run(c) {
    const tag = AnlzFile.parseFile(c.args.path).getTag(c.args.key);
    return {
      ...tag.summary(),
      value: paginateTagValue(tag.get(), c.options.offset, c.options.limit),
    };
  },
});

anlzCli.command("set-path", {
  description: "Replace the PPTH audio path and save the rebuilt ANLZ file.",
  args: z.object({
    path: z.string().describe("ANLZ DAT, EXT, or 2EX file"),
    audioPath: z.string().describe("New audio path"),
  }),
  options: z.object({
    output: z.string().optional().describe("Destination; defaults to the source file"),
  }),
  run(c) {
    const file = AnlzFile.parseFile(c.args.path);
    file.setPath(c.args.audioPath);
    const output = c.options.output ?? c.args.path;
    file.save(output);
    return { output, path: file.get("path") };
  },
});

anlzCli.command("set-beat-grid", {
  description: "Replace every existing PQTZ beat, BPM, and time value.",
  args: z.object({ path: z.string().describe("ANLZ DAT file") }),
  options: z.object({
    beats: z.string().describe("Comma-separated beat numbers"),
    bpms: z.string().describe("Comma-separated BPM values"),
    output: z.string().optional().describe("Destination; defaults to the source file"),
    times: z.string().describe("Comma-separated times in seconds"),
  }),
  run(c) {
    const file = AnlzFile.parseFile(c.args.path);
    const tag = file.getTag("PQTZ");
    if (!(tag instanceof BeatGridTag)) throw new TypeError("PQTZ tag has an unexpected handler");
    tag.set(numberList(c.options.beats), numberList(c.options.bpms), numberList(c.options.times));
    const output = c.options.output ?? c.args.path;
    file.save(output);
    return { beatGrid: tag.get(), output };
  },
});

cli.command(anlzCli);

const smartlistCli = Cli.create("smartlist", {
  description: "Parse, build, and compile Rekordbox smart playlists.",
});

smartlistCli.command("parse", {
  description: "Parse smart-playlist XML.",
  args: z.object({ xml: z.string().describe("Smart-playlist NODE XML") }),
  run(c) {
    const smartList = SmartList.fromXml(c.args.xml);
    return { ...smartList.toJSON(), sql: smartList.compileSql() };
  },
});

smartlistCli.command("build", {
  description: "Build smart-playlist XML from JSON conditions.",
  args: z.object({ playlistId: z.number().int().describe("Unsigned playlist ID") }),
  options: z.object({
    autoUpdate: z.number().int().min(0).max(1).default(0).describe("Automatic update flag"),
    conditions: z
      .string()
      .default("[]")
      .describe("JSON array of {property,operator,valueLeft,valueRight?,unit?}"),
    logical: z.enum(["all", "any"]).default("all").describe("Condition combination mode"),
  }),
  run(c) {
    const parsed = JSON.parse(c.options.conditions) as Array<{
      operator: number;
      property: string;
      unit?: string;
      valueLeft: string | number;
      valueRight?: string | number;
    }>;
    if (!Array.isArray(parsed)) throw new TypeError("--conditions must be a JSON array");
    const smartList = new SmartList(
      c.options.logical === "all" ? LogicalOperator.ALL : LogicalOperator.ANY,
      c.options.autoUpdate,
    );
    smartList.playlistId = c.args.playlistId;
    for (const condition of parsed) smartList.addCondition(condition as ConditionInput);
    return { smartList: smartList.toJSON(), xml: smartList.toXml() };
  },
});

smartlistCli.command("sql", {
  description: "Compile smart-playlist XML to parameterized SQLite SQL.",
  args: z.object({ xml: z.string().describe("Smart-playlist NODE XML") }),
  options: z.object({
    tableAlias: z.string().optional().describe("Optional content-table alias"),
  }),
  run(c) {
    return SmartList.fromXml(c.args.xml).compileSql({ tableAlias: c.options.tableAlias });
  },
});

cli.command(smartlistCli);

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
