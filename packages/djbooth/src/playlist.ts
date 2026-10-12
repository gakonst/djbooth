import { dirname, resolve } from "node:path";
import { playlistCli } from "@gakonst/rekordbox/cli";
import { analyzeTracks } from "@gakonst/rekordbox/analyzer";
import {
  defaultTrackLibraryRoot,
  importManifestToRekordbox,
  RekordboxPipelineStore,
  sha256File,
} from "@gakonst/tracks";
import { z } from "incur";

playlistCli.command("ready", {
  description:
    "Make downloaded import tracks available in their ordered playlist while acquisition continues.",
  args: z.object({ source: z.string().describe("Source URL of an existing import") }),
  options: z.object({ path: z.string().optional().describe("Rekordbox master.db path") }),
  async run({ args, options }) {
    const store = new RekordboxPipelineStore({
      source: args.source,
      outputDirectory: defaultTrackLibraryRoot(),
      ...(options.path ? { dbPath: options.path } : {}),
    });
    const manifest = await store.load();
    if (!manifest) throw new Error("No import found for this source");
    const total = manifest.entries.length;
    manifest.entries = manifest.entries.filter(
      (entry) => entry.acquisition.status === "downloaded",
    );
    const skipped: number[] = [];
    const verified = await Promise.all(
      manifest.entries.map(async (entry) => {
        if (entry.acquisition.status !== "downloaded") return false;
        for (const item of [
          entry.acquisition.download,
          ...(entry.acquisition.alternatives ?? []),
        ]) {
          const actual = await sha256File(resolve(store.artifactDirectory, item.mediaPath)).catch(
            () => undefined,
          );
          if (!actual || actual !== item.sha256) {
            skipped.push(entry.order);
            return false;
          }
        }
        return true;
      }),
    );
    manifest.entries = manifest.entries.filter((_, index) => verified[index]);
    if (!manifest.entries.length) throw new Error("No tracks have downloaded yet");
    const paths = [
      ...new Set(
        manifest.entries.flatMap((entry) =>
          entry.acquisition.status === "downloaded"
            ? [entry.acquisition.download, ...(entry.acquisition.alternatives ?? [])].map((item) =>
                resolve(store.artifactDirectory, item.mediaPath),
              )
            : [],
        ),
      ),
    ];
    process.stderr.write(`[playlist] analyzing ${paths.length} downloaded recordings\n`);
    const analysis = await analyzeTracks(paths, {
      rhythmMode: "auto",
      onProgress(progress) {
        process.stderr.write(
          `[analysis] ${progress.phase} ${progress.completed}/${progress.total}\n`,
        );
      },
    });
    process.stderr.write(`[playlist] updating ${manifest.entries.length}/${total} tracks\n`);
    const result = await importManifestToRekordbox({
      manifest,
      dbPath: store.location.dbPath,
      dbDirectory: store.location.dbDirectory,
      mediaBaseDirectory: store.artifactDirectory,
      analysisDirectories: Object.fromEntries(
        analysis.results.map((item, index) => [paths[index]!, dirname(item.summaryPath)]),
      ),
    });
    // Acquisition owns the pipeline snapshot. Do not overwrite its concurrent
    // progress with this partial view; the normal import reuses these rows.
    process.stderr.write(`[complete] ${result.imported.length}/${total} tracks available\n`);
    return {
      playlistId: result.playlistId,
      playlistName: result.plan.playlistName,
      available: result.imported.length,
      total,
      skipped,
      tracks: result.imported,
    };
  },
});

export { playlistCli };
