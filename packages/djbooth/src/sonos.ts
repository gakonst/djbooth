import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { createSocket } from "node:dgram";
import { createServer, request as httpRequest, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { networkInterfaces } from "node:os";
import { promisify } from "node:util";

const SONOS_DEVICE = "urn:schemas-upnp-org:device:ZonePlayer:1";
const AV_TRANSPORT = "urn:schemas-upnp-org:service:AVTransport:1";
const ZONE_TOPOLOGY = "urn:schemas-upnp-org:service:ZoneGroupTopology:1";
const DEFAULT_STATE_API = "http://127.0.0.1:4182";
const execFileAsync = promisify(execFile);

export type SonosBridgeStatus = {
  room: string;
  coordinatorIp: string;
  streamUrl: string;
};

export type RunningSonosBridge = SonosBridgeStatus & {
  close(): Promise<void>;
};

export type SonosBridgeOptions = {
  room: string;
  port?: number;
  stateApiUrl?: string;
  discoveryTimeoutMs?: number;
  audioReadyTimeoutMs?: number;
};

type SonosZone = {
  coordinatorUuid: string;
  location?: string;
  room: string;
  uuid: string;
};

type SonosTarget = {
  coordinatorIp: string;
  room: string;
};

/** Relay the DJM master stream to one Sonos group and take ownership of its transport. */
export async function startSonosBridge(options: SonosBridgeOptions): Promise<RunningSonosBridge> {
  const stateApiUrl = options.stateApiUrl ?? DEFAULT_STATE_API;
  await assertFfmpeg();
  await waitForMasterAudio(stateApiUrl, options.audioReadyTimeoutMs ?? 20_000);
  const target = await discoverSonosTarget(options.room, options.discoveryTimeoutMs ?? 1_750);
  const routeIp = await localRouteTo(target.coordinatorIp);
  const token = randomBytes(18).toString("base64url");
  const streamPath = `/${token}/master.mp3`;
  const playlistPath = `/${token}/live.m3u`;
  const relay = await startAudioRelay({
    port: options.port ?? 0,
    routeIp,
    stateApiUrl,
    streamPath,
    playlistPath,
  });
  const streamUrl = relay.playlistUrl;
  try {
    await setSonosUri(target.coordinatorIp, streamUrl);
    await playSonos(target.coordinatorIp);
  } catch (error) {
    await relay.close();
    throw error;
  }
  let closePromise: Promise<void> | undefined;
  return {
    room: target.room,
    coordinatorIp: target.coordinatorIp,
    streamUrl,
    close() {
      closePromise ??= (async () => {
        try {
          if ((await currentSonosUri(target.coordinatorIp)) === streamUrl) {
            await stopSonos(target.coordinatorIp);
          }
        } catch {
          // The relay still must close if the speaker disappeared or changed groups.
        }
        await relay.close();
      })();
      return closePromise;
    },
  };
}

async function assertFfmpeg(): Promise<void> {
  try {
    const { stdout } = await execFileAsync("ffmpeg", ["-hide_banner", "-encoders"], {
      timeout: 5_000,
    });
    if (!stdout.includes("libmp3lame")) throw new Error("libmp3lame encoder unavailable");
  } catch (error) {
    throw new Error("Sonos output requires ffmpeg with the libmp3lame encoder on PATH", {
      cause: error,
    });
  }
}

async function waitForMasterAudio(stateApiUrl: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(new URL("/health", stateApiUrl), {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) {
        const health = (await response.json()) as { masterAudioConnected?: boolean };
        if (health.masterAudioConnected) return;
      }
    } catch (error) {
      lastError = error;
    }
    await delay(250);
  }
  throw new Error(
    `DJM master audio did not become available at ${stateApiUrl} within ${String(timeoutMs)}ms`,
    lastError === undefined ? undefined : { cause: lastError },
  );
}

async function discoverSonosTarget(room: string, timeoutMs: number): Promise<SonosTarget> {
  const locations = await discoverLocations(timeoutMs);
  if (locations.length === 0) {
    throw new Error("No Sonos players responded on the local network");
  }
  const topology = await readTopology(locations);
  const visible = topology.filter((zone) => zone.room.trim().length > 0);
  const requested = room.trim();
  let selected: SonosZone | undefined;
  if (requested.toLocaleLowerCase() === "auto") {
    const rooms = [...new Set(visible.map((zone) => zone.room))];
    if (rooms.length !== 1) {
      throw new Error(
        `Sonos room is ambiguous; choose one of: ${rooms.sort().join(", ") || "none"}`,
      );
    }
    selected = visible.find((zone) => zone.room === rooms[0]);
  } else {
    selected = visible.find(
      (zone) => zone.room.toLocaleLowerCase() === requested.toLocaleLowerCase(),
    );
  }
  if (!selected) {
    const rooms = [...new Set(visible.map((zone) => zone.room))].sort();
    throw new Error(`Sonos room '${room}' was not found; available rooms: ${rooms.join(", ")}`);
  }
  const coordinator = topology.find((zone) => zone.uuid === selected.coordinatorUuid);
  const coordinatorLocation = coordinator?.location;
  if (!coordinatorLocation) {
    throw new Error(`Could not resolve the coordinator for Sonos room '${selected.room}'`);
  }
  return {
    coordinatorIp: new URL(coordinatorLocation).hostname,
    room: selected.room,
  };
}

async function discoverLocations(timeoutMs: number): Promise<string[]> {
  const interfaces = Object.values(networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .filter((entry) => entry.family === "IPv4" && !entry.internal)
    .map((entry) => entry.address);
  const locations = new Set<string>();
  await Promise.all(
    interfaces.map(async (address) => {
      const socket = createSocket({ type: "udp4", reuseAddr: true });
      socket.on("message", (message) => {
        const location = /^location:\s*(.+)$/im.exec(message.toString("utf8"))?.[1]?.trim();
        if (location) locations.add(location);
      });
      try {
        await new Promise<void>((resolveBind, rejectBind) => {
          socket.once("error", rejectBind);
          socket.bind(0, address, () => {
            socket.off("error", rejectBind);
            resolveBind();
          });
        });
        socket.setMulticastInterface(address);
        const query = Buffer.from(
          [
            "M-SEARCH * HTTP/1.1",
            "HOST: 239.255.255.250:1900",
            'MAN: "ssdp:discover"',
            "MX: 1",
            `ST: ${SONOS_DEVICE}`,
            "",
            "",
          ].join("\r\n"),
        );
        await new Promise<void>((resolveSend, rejectSend) => {
          socket.send(query, 1900, "239.255.255.250", (error) =>
            error ? rejectSend(error) : resolveSend(),
          );
        });
        await delay(timeoutMs);
      } catch {
        // An interface may not support multicast; the other active interfaces still participate.
      } finally {
        socket.close();
      }
    }),
  );
  return [...locations];
}

async function readTopology(locations: string[]): Promise<SonosZone[]> {
  let lastError: unknown;
  for (const location of locations) {
    try {
      const endpoint = new URL("/ZoneGroupTopology/Control", location);
      const response = await soap(endpoint, ZONE_TOPOLOGY, "GetZoneGroupState", {});
      const encoded = /<ZoneGroupState>([\s\S]*?)<\/ZoneGroupState>/.exec(response)?.[1];
      if (!encoded) throw new Error("Sonos topology response omitted ZoneGroupState");
      const zones = parseZoneGroupState(decodeXml(encoded));
      if (zones.length > 0) return zones;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error("Unable to read Sonos group topology", { cause: lastError });
}

export function parseZoneGroupState(xml: string): SonosZone[] {
  const zones: SonosZone[] = [];
  for (const groupMatch of xml.matchAll(/<ZoneGroup\b([^>]*)>([\s\S]*?)<\/ZoneGroup>/g)) {
    const group = parseAttributes(groupMatch[1] ?? "");
    const coordinatorUuid = group.Coordinator;
    if (!coordinatorUuid) continue;
    for (const memberMatch of (groupMatch[2] ?? "").matchAll(/<ZoneGroupMember\b([^>]*)\/?\s*>/g)) {
      const member = parseAttributes(memberMatch[1] ?? "");
      if (!member.UUID || member.Invisible === "1") continue;
      zones.push({
        coordinatorUuid,
        ...(member.Location ? { location: member.Location } : {}),
        room: decodeXml(member.ZoneName ?? ""),
        uuid: member.UUID,
      });
    }
  }
  return zones;
}

function parseAttributes(value: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const match of value.matchAll(/([\w:.-]+)="([^"]*)"/g)) {
    if (match[1]) attributes[match[1]] = decodeXml(match[2] ?? "");
  }
  return attributes;
}

async function localRouteTo(targetIp: string): Promise<string> {
  const socket = createSocket("udp4");
  try {
    await new Promise<void>((resolveConnect, rejectConnect) => {
      socket.once("error", rejectConnect);
      socket.connect(1400, targetIp, () => {
        socket.off("error", rejectConnect);
        resolveConnect();
      });
    });
    const address = socket.address();
    if (typeof address === "string") throw new Error("Sonos route did not resolve to IPv4");
    return address.address;
  } finally {
    socket.close();
  }
}

async function setSonosUri(ip: string, streamUrl: string): Promise<void> {
  await soap(
    new URL(`http://${ip}:1400/MediaRenderer/AVTransport/Control`),
    AV_TRANSPORT,
    "SetAVTransportURI",
    { InstanceID: "0", CurrentURI: streamUrl, CurrentURIMetaData: "" },
  );
}

async function playSonos(ip: string): Promise<void> {
  await soap(new URL(`http://${ip}:1400/MediaRenderer/AVTransport/Control`), AV_TRANSPORT, "Play", {
    InstanceID: "0",
    Speed: "1",
  });
}

async function stopSonos(ip: string): Promise<void> {
  await soap(new URL(`http://${ip}:1400/MediaRenderer/AVTransport/Control`), AV_TRANSPORT, "Stop", {
    InstanceID: "0",
  });
}

async function currentSonosUri(ip: string): Promise<string | undefined> {
  const response = await soap(
    new URL(`http://${ip}:1400/MediaRenderer/AVTransport/Control`),
    AV_TRANSPORT,
    "GetMediaInfo",
    { InstanceID: "0" },
  );
  const encoded = /<CurrentURI>([\s\S]*?)<\/CurrentURI>/.exec(response)?.[1];
  return encoded === undefined ? undefined : decodeXml(encoded);
}

async function soap(
  endpoint: URL,
  service: string,
  action: string,
  values: Record<string, string>,
): Promise<string> {
  const parameters = Object.entries(values)
    .map(([name, value]) => `<${name}>${encodeXml(value)}</${name}>`)
    .join("");
  const body = `<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="${service}">${parameters}</u:${action}></s:Body></s:Envelope>`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": 'text/xml; charset="utf-8"',
      soapaction: `"${service}#${action}"`,
    },
    body,
    signal: AbortSignal.timeout(5_000),
  });
  const text = await response.text();
  if (!response.ok) {
    const detail = /<errorDescription>([^<]+)<\/errorDescription>/.exec(text)?.[1];
    throw new Error(
      `Sonos ${action} failed with HTTP ${String(response.status)}${detail ? `: ${decodeXml(detail)}` : ""}`,
    );
  }
  return text;
}

async function startAudioRelay(options: {
  port: number;
  routeIp: string;
  stateApiUrl: string;
  streamPath: string;
  playlistPath: string;
}): Promise<{ playlistUrl: string; close(): Promise<void> }> {
  const sockets = new Set<Socket>();
  let advertisedPort = 0;
  const server = createServer((request, response) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { allow: "GET, HEAD" });
      response.end();
      return;
    }
    if (request.url === options.playlistPath) {
      const audioUrl = `http://${options.routeIp}:${String(advertisedPort)}${options.streamPath}`;
      const playlist = Buffer.from(`#EXTM3U\n#EXTINF:-1,djbooth master\n${audioUrl}\n`);
      response.writeHead(200, {
        "cache-control": "no-store",
        "content-length": playlist.length,
        "content-type": "audio/x-mpegurl",
      });
      response.end(request.method === "HEAD" ? undefined : playlist);
      return;
    }
    if (request.url !== options.streamPath) {
      response.writeHead(404);
      response.end();
      return;
    }
    proxyMasterAudio(response, request.method === "HEAD", options.stateApiUrl);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(options.port, "0.0.0.0", () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Sonos relay did not bind to TCP");
  advertisedPort = address.port;
  let closePromise: Promise<void> | undefined;
  return {
    playlistUrl: `http://${options.routeIp}:${String(address.port)}${options.playlistPath}`,
    close() {
      closePromise ??= new Promise<void>((resolveClose, rejectClose) => {
        for (const socket of sockets) socket.destroy();
        server.close((error) => (error ? rejectClose(error) : resolveClose()));
      });
      return closePromise;
    },
  };
}

function proxyMasterAudio(response: ServerResponse, headOnly: boolean, stateApiUrl: string): void {
  const upstream = httpRequest(new URL("/v1/audio/master.mp3", stateApiUrl), {
    method: headOnly ? "HEAD" : "GET",
  });
  response.once("close", () => upstream.destroy());
  upstream.on("response", (source) => {
    response.writeHead(source.statusCode ?? 502, {
      "cache-control": "no-store",
      "content-type": source.headers["content-type"] ?? "audio/mpeg",
      "icy-name": "djbooth master",
    });
    if (headOnly) {
      source.destroy();
      response.end();
    } else {
      source.pipe(response);
    }
  });
  upstream.on("error", (error) => {
    if (!response.headersSent) response.writeHead(502, { "content-type": "text/plain" });
    response.end(`DJ mixer stream unavailable: ${error.message}\n`);
  });
  upstream.end();
}

function encodeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function decodeXml(value: string): string {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&");
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
