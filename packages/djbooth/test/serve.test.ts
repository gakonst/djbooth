import { describe, expect, it, vi } from "vitest";

import { DjLinkError } from "@gakonst/djlink";

import { startDjBoothServer, type DjBoothServerDependencies } from "../src/serve.js";

function linkStatus(pid: number, resumed: boolean) {
  return {
    bindIp: "169.254.1.1",
    broadcastIp: "169.254.255.255",
    logPath: "/tmp/djbooth.log",
    pid,
    playerNumber: 17,
    playlists: 4,
    remoteDeckPreparationSupported: true as const,
    remoteTransportSupported: true,
    resumed,
    running: true as const,
    socketPath: "/tmp/djbooth.sock",
    sourceKind: "rekordbox" as const,
    sourcePath: "/Library/master.db",
    tracks: 100,
    uptimeMs: 10,
  };
}

function dependencies(options: { resumed?: boolean; webError?: Error } = {}) {
  const closeWeb = vi.fn(async () => undefined);
  const stopLink = vi.fn(async () => ({ stopped: true, wasRunning: true, pid: 42 }));
  const startLink = vi.fn<DjBoothServerDependencies["startRekordboxDjLink"]>(async () =>
    linkStatus(42, options.resumed ?? false),
  );
  const closeSonos = vi.fn(async () => undefined);
  const startSonos = vi.fn<DjBoothServerDependencies["startSonosBridge"]>(async ({ room }) => ({
    close: closeSonos,
    coordinatorIp: "192.168.1.20",
    room,
    streamUrl: "http://192.168.1.10:4183/master.mp3",
  }));
  const value: DjBoothServerDependencies = {
    async startLibraryServer() {
      if (options.webError) throw options.webError;
      return {
        close: closeWeb,
        host: "127.0.0.1",
        port: 4179,
        token: "token",
        url: "http://127.0.0.1:4179/",
      };
    },
    startRekordboxDjLink: startLink,
    stopDjLink: stopLink,
    startSonosBridge: startSonos,
  };
  return { closeSonos, closeWeb, startLink, startSonos, stopLink, value };
}

describe("combined djbooth server", () => {
  it("closes the web API and a DJ Link daemon created by this session", async () => {
    const fake = dependencies();
    const server = await startDjBoothServer({ assistant: false }, fake.value);

    expect(server.url).toBe("http://127.0.0.1:4179/?assistant=0");
    expect(server.boothUrl).toBe("http://127.0.0.1:4179/booth");
    await expect(server.close()).resolves.toEqual({ linkStopped: true });
    await server.close();
    expect(fake.closeWeb).toHaveBeenCalledTimes(1);
    expect(fake.stopLink).toHaveBeenCalledTimes(1);
  });

  it("reuses and leaves an existing matching DJ Link daemon running", async () => {
    const fake = dependencies({ resumed: true });
    const server = await startDjBoothServer({}, fake.value);

    await expect(server.close()).resolves.toEqual({ linkStopped: false });
    expect(fake.closeWeb).toHaveBeenCalledTimes(1);
    expect(fake.stopLink).not.toHaveBeenCalled();
  });

  it("takes ownership when reconciliation replaces a resumed DJ Link daemon", async () => {
    const fake = dependencies({ resumed: true });
    fake.startLink
      .mockResolvedValueOnce(linkStatus(42, true))
      .mockResolvedValueOnce(linkStatus(84, false));
    const server = await startDjBoothServer({}, fake.value);

    await expect(server.reconcileLink()).resolves.toMatchObject({ pid: 84, resumed: false });
    expect(server.link).toMatchObject({ pid: 84 });
    await expect(server.close()).resolves.toEqual({ linkStopped: true });
    expect(fake.stopLink).toHaveBeenCalledTimes(1);
  });

  it("lets the DJ Link runtime reuse its durable Stagehand identity across worker restarts", async () => {
    const fake = dependencies();
    fake.startLink
      .mockResolvedValueOnce(linkStatus(42, false))
      .mockResolvedValueOnce(linkStatus(84, false));
    const server = await startDjBoothServer({}, fake.value);

    await server.reconcileLink();
    const first = fake.startLink.mock.calls[0]?.[0];
    const second = fake.startLink.mock.calls[1]?.[0];
    expect(first?.stagehandSessionNonce).toBeUndefined();
    expect(second?.stagehandSessionNonce).toBe(first?.stagehandSessionNonce);
    expect(first?.stagehandProtocolNonce).toBeUndefined();
    expect(second?.stagehandProtocolNonce).toBe(first?.stagehandProtocolNonce);
    await server.close();
  });

  it("pins an explicitly configured Stagehand session IP", async () => {
    const fake = dependencies();
    vi.stubEnv("DJBOOTH_STAGEHAND_SESSION_IP", "169.254.51.174");
    try {
      await startDjBoothServer({}, fake.value);
      expect(fake.startLink.mock.calls[0]?.[0].stagehandSessionIp).toBe("169.254.51.174");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("does not claim an externally replaced resumed DJ Link daemon", async () => {
    const fake = dependencies();
    fake.startLink
      .mockResolvedValueOnce(linkStatus(42, false))
      .mockResolvedValueOnce(linkStatus(84, true));
    const server = await startDjBoothServer({}, fake.value);

    await server.reconcileLink();
    await expect(server.close()).resolves.toEqual({ linkStopped: false });
    expect(fake.stopLink).not.toHaveBeenCalled();
  });

  it("stops a newly created DJ Link daemon when web startup fails", async () => {
    const fake = dependencies({ webError: new Error("port busy") });

    await expect(startDjBoothServer({}, fake.value)).rejects.toThrow("port busy");
    expect(fake.stopLink).toHaveBeenCalledTimes(1);
  });

  it("owns a Sonos master-mix bridge for the managed runtime", async () => {
    const fake = dependencies();
    const server = await startDjBoothServer({ sonos: "Kitchen" }, fake.value);

    expect(fake.startSonos).toHaveBeenCalledWith({ room: "Kitchen", port: 0 });
    expect(server.sonos).toMatchObject({ room: "Kitchen", coordinatorIp: "192.168.1.20" });
    await server.close();
    expect(fake.closeSonos).toHaveBeenCalledTimes(1);
  });

  it("retries a transient native link startup failure", async () => {
    const fake = dependencies();
    fake.startLink
      .mockRejectedValueOnce(new DjLinkError("START_FAILED", "interface settling"))
      .mockResolvedValueOnce(linkStatus(42, false));

    const server = await startDjBoothServer({}, fake.value);

    expect(fake.startLink).toHaveBeenCalledTimes(2);
    await server.close();
  });
});
