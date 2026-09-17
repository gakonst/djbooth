import { cloudWorkflow } from "./cloud-workflow.js";
import { cloudAgent } from "./cloud-agent.js";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { FileSessionStore } from "@gakonst/spots";
import { MasterDatabase } from "@gakonst/rekordbox";
import { inspectImportDetails } from "@gakonst/tracks/pipeline-state";
import { CloudSnapshots } from "./cloud-snapshots.js";
import {
  CloudProcessingError,
  processCloudImport,
  type ImportProgress,
  type CloudImportOptions,
} from "./cloud-worker.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

/** R2 stores database backups and immutable artifacts; SQLite always runs on local disk. */
export async function runPlaylistContainer(
  options: { onProgress?: (value: ImportProgress) => void } = {},
): Promise<void> {
  const id = required("DJBOOTH_IMPORT_ID");
  if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error("Invalid playlist request ID");
  const source = required("DJBOOTH_IMPORT_SOURCE");
  const token = "container-binding";
  const endpoint = "http://djbooth.internal";
  const root = "/data";
  const dbPath = join(root, "master.db");
  const controller = new AbortController();
  const storage = new CloudSnapshots(endpoint, controller.signal);
  let progress: ImportProgress = {
    status: "running",
    phase: "restore",
    current: 0,
    total: 1,
    message: "Preparing playlist container",
  };
  const report = () => {
    try {
      options.onProgress?.(progress);
    } catch {
      /* diagnostics */
    }
  };
  report();
  const reporting = setInterval(report, 2_000);
  reporting.unref();
  let snapshotFailed = false;
  let snapshot: Promise<void> | undefined;
  const save = (): Promise<void> =>
    (snapshot ??= (async () => {
      if (!existsSync(dbPath)) return;
      const path = `/tmp/djbooth-${randomUUID()}.db`;
      const db = new MasterDatabase({ path: dbPath, readonly: true, playlistXml: false });
      try {
        await db.backup(path);
      } finally {
        db.close();
      }
      try {
        // Publish the consistent database last, only after its referenced files are uploaded.
        await storage.saveArtifacts(root);
        await storage.upload(path, "master.db");
        snapshotFailed = false;
      } finally {
        await rm(path, { force: true });
      }
    })().finally(() => {
      snapshot = undefined;
    }));
  const checkpoint = async () => {
    await snapshot?.catch(() => undefined);
    await save();
  };
  const paths: CloudImportOptions = {
    dbPath,
    endpoint,
    token,
    namespace: `cloud:${id}`,
    outputDirectory: join(root, "audio"),
    artifactsOnly: process.env.DJBOOTH_ANALYSIS_REPAIR === "1",
    checkpoint,
    resolve: async (request: unknown, signal: AbortSignal) => {
      const response = await fetch(`${endpoint}/resolve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
        signal: AbortSignal.any([signal, AbortSignal.timeout(600_000)]),
      });
      if (!response.ok)
        throw new CloudProcessingError(
          response.status === 422
            ? "No verified tracklist was found for this set."
            : "Cloud tracklist research is temporarily unavailable.",
        );
      return response.json();
    },
  };
  const workflow = cloudWorkflow({
    source,
    paths,
    save: checkpoint,
    signal: controller.signal,
    progress: (value) => {
      progress = value;
    },
  });
  let agentReady = false;
  const agent = cloudAgent({
    id,
    source,
    save: checkpoint,
    signal: controller.signal,
    progress: (value) => {
      progress = value;
    },
  });
  const server = createServer(async (request, response) => {
    if (
      request.method === "POST" &&
      ((process.env.DJBOOTH_AGENT === "1" && request.url === "/exec") ||
        (process.env.DJBOOTH_WORKFLOW === "1" && request.url === "/workflow"))
    ) {
      if (!agentReady) {
        response.writeHead(503).end("Workspace is restoring; retry shortly.");
        return;
      }
      try {
        let body = "";
        for await (const chunk of request) {
          body += chunk;
          if (body.length > 65536) throw new Error("Request too large");
        }
        const result = await (request.url === "/workflow" ? workflow : agent)(JSON.parse(body));
        response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(result));
      } catch (error) {
        response
          .writeHead(400)
          .end(
            JSON.stringify({ error: error instanceof Error ? error.message : "Invalid command" }),
          );
      }
      return;
    }
    if (request.method !== "GET" || !["/status", "/"].includes(request.url ?? "")) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    let report;
    if (agentReady && existsSync(dbPath)) {
      try {
        const db = new MasterDatabase({ path: dbPath, readonly: true, playlistXml: false });
        try {
          report = inspectImportDetails(db, source);
        } finally {
          db.close();
        }
      } catch {
        /* Status remains available while the database is busy. */
      }
    }
    response.end(JSON.stringify({ ...progress, report }));
  });
  const closed = new Promise<void>((resolve) => server.once("close", resolve));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(8080, "0.0.0.0", resolve);
  });
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    controller.abort();
    server.close();
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  let timer: ReturnType<typeof setInterval> | undefined;
  try {
    if (process.env.SPOTIFY_REFRESH_TOKEN) {
      await new FileSessionStore().save({
        version: 1,
        clientId: required("SPOTIFY_CLIENT_ID"),
        redirectUri: process.env.SPOTIFY_REDIRECT_URI ?? "http://127.0.0.1:4381/callback",
        token: {
          accessToken: "",
          tokenType: "Bearer",
          expiresAt: 0,
          scopes: [],
          refreshToken: process.env.SPOTIFY_REFRESH_TOKEN,
        },
      });
    }
    await mkdir(root, { recursive: true });
    await storage.restore(root);
    if (!existsSync(dbPath)) MasterDatabase.createManaged(dbPath).close();
    timer = setInterval(() => {
      void save().catch(() => {
        snapshotFailed = true;
      });
    }, 60_000);
    let providerPlaylistFile: string | undefined;
    const providerInput = await fetch(`${endpoint}/provider-playlist`, {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]),
    });
    if (providerInput.ok) {
      const body = await providerInput.text();
      if (body.length > 8 * 1024 * 1024) throw new Error("Provider playlist input is too large");
      providerPlaylistFile = "/tmp/provider-playlist.json";
      await writeFile(providerPlaylistFile, body, { mode: 0o600 });
    } else if (providerInput.status !== 404) throw new Error("Provider playlist input unavailable");
    if (providerPlaylistFile) paths.providerPlaylistFile = providerPlaylistFile;
    if (process.env.DJBOOTH_AGENT === "1" || process.env.DJBOOTH_WORKFLOW === "1") {
      agentReady = true;
      progress = {
        status: "running",
        phase: "import",
        current: 0,
        total: 1,
        message: "Preparing download",
      };
      await closed;
      return;
    }
    let result: ImportProgress;
    try {
      result = await processCloudImport(
        source,
        {
          dbPath,
          ...(providerPlaylistFile ? { providerPlaylistFile } : {}),
          endpoint,
          token,
          namespace: `cloud:${id}`,
          outputDirectory: join(root, "audio"),
          artifactsOnly: process.env.DJBOOTH_ANALYSIS_REPAIR === "1",
          resolve: async (request, signal) => {
            const response = await fetch(`${endpoint}/resolve`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(request),
              signal: AbortSignal.any([signal, AbortSignal.timeout(600_000)]),
            });
            if (!response.ok)
              throw new CloudProcessingError(
                response.status === 422
                  ? "No verified tracklist was found for this set. Retry when more tracklist evidence is available."
                  : "Cloud tracklist research failed. Retry to resume.",
              );
            return response.json();
          },
          checkpoint: async () => {
            await snapshot?.catch(() => undefined);
            await save();
          },
        },
        controller.signal,
        (value) => {
          progress = value;
        },
      );
    } catch (error) {
      result = {
        status: "failed",
        phase: "failed",
        current: 0,
        total: 1,
        message:
          error instanceof CloudProcessingError
            ? error.message
            : "Download or analysis needs attention. Check cloud provider configuration, then retry to resume.",
      };
    }
    clearInterval(timer);
    timer = undefined;
    await snapshot?.catch(() => undefined);
    progress = {
      ...progress,
      status: "running",
      phase: "backup",
      current: 0,
      total: 1,
      message: "Saving playlist for future retries",
    };
    await save();
    progress = result;
  } catch {
    progress = {
      status: "failed",
      phase: "failed",
      current: 0,
      total: 1,
      message: snapshotFailed
        ? "Cloud backup failed. Retry to resume."
        : "Cloud processing could not finish. Check container and storage configuration, then retry.",
    };
  } finally {
    if (timer) clearInterval(timer);
  }
  // Keep only the tiny status server alive until the Durable Object acknowledges
  // completion and stops this container. The phone need not remain connected.
  report();
  await closed;
  clearInterval(reporting);
  process.removeListener("SIGTERM", stop);
  process.removeListener("SIGINT", stop);
}
