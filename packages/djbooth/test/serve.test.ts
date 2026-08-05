import { describe, expect, it, vi } from "vitest";

import { startDjBoothServer, type DjBoothServerDependencies } from "../src/serve.js";

function dependencies(options: { resumed?: boolean; webError?: Error } = {}) {
  const closeWeb = vi.fn(async () => undefined);
  const stopLink = vi.fn(async () => ({ stopped: true, wasRunning: true, pid: 42 }));
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
    async startRekordboxDjLink() {
      return {
        bindIp: "169.254.1.1",
        broadcastIp: "169.254.255.255",
        logPath: "/tmp/djbooth.log",
        pid: 42,
        playerNumber: 17,
        playlists: 4,
        remoteDeckPreparationSupported: true,
        remoteTransportSupported: false,
        resumed: options.resumed ?? false,
        running: true,
        socketPath: "/tmp/djbooth.sock",
        sourceKind: "rekordbox",
        sourcePath: "/Library/master.db",
        tracks: 100,
        uptimeMs: 10,
      };
    },
    stopDjLink: stopLink,
  };
  return { closeWeb, stopLink, value };
}

describe("combined djbooth server", () => {
  it("closes the web API and a DJ Link daemon created by this session", async () => {
    const fake = dependencies();
    const server = await startDjBoothServer({ assistant: false }, fake.value);

    expect(server.url).toBe("http://127.0.0.1:4179/?assistant=0");
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

  it("stops a newly created DJ Link daemon when web startup fails", async () => {
    const fake = dependencies({ webError: new Error("port busy") });

    await expect(startDjBoothServer({}, fake.value)).rejects.toThrow("port busy");
    expect(fake.stopLink).toHaveBeenCalledTimes(1);
  });
});
