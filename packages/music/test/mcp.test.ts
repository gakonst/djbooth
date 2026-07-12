import type { Executor, ResolvedProvider } from "@cloudflare/codemode";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";

import {
  createLocalMusicCodeMcpServer,
  createMusicCodeMcpServer,
  createMusicMcpServer,
  type MusicCliDependencies,
} from "../src/index.js";

const dependencies: MusicCliDependencies = {
  resolveTracks: async (source) => ({ source }),
  spotifySession: async () => ({ loggedIn: false }),
  searchSoulseek: async (query) => ({ query }),
  ytdlpEngines: async () => ({ native: { available: true } }),
  inspectYtdlp: async (url) => ({ url }),
  rekordboxStatus: () => ({ rekordboxPid: 42 }),
};

const localSandboxTest = process.platform === "win32" ? it.skip : it;

async function connect(server: McpServer): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "music-test", version: "1.0.0" });
  await client.connect(clientTransport);
  return client;
}

describe("music MCP adapters", () => {
  it("exposes the CLI command map as six normal MCP tools", async () => {
    const server = createMusicMcpServer({ dependencies });
    const client = await connect(server);
    try {
      const { tools } = await client.listTools();
      expect(tools.map(({ name }) => name).sort()).toEqual([
        "rekordbox_status",
        "slsk_search",
        "spots_session",
        "tracks_resolve",
        "ytdlp_engines",
        "ytdlp_inspect",
      ]);

      const result = await client.callTool({ name: "rekordbox_status", arguments: {} });
      const content = result.content as Array<{ type: string; text: string }>;
      expect(JSON.parse(content[0]!.text)).toEqual({
        rekordboxPid: 42,
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("collapses the same command map into one CodeMode tool", async () => {
    let providers: ResolvedProvider[] | undefined;
    const executor: Executor = {
      async execute(_code, resolved) {
        providers = Array.isArray(resolved) ? resolved : undefined;
        const status = providers?.[0]?.fns.rekordbox_status;
        if (!status) return { result: undefined, error: "missing rekordbox_status" };
        return { result: await status({}) };
      },
    };
    const server = await createMusicCodeMcpServer({ dependencies, executor });
    const client = await connect(server);
    try {
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(1);
      expect(tools[0]?.name).toBe("code");
      expect(tools[0]?.description).toContain("rekordbox_status");

      const result = await client.callTool({
        name: "code",
        arguments: { code: "async () => codemode.rekordbox_status({})" },
      });
      const content = result.content as Array<{ type: string; text: string }>;
      expect(JSON.parse(content[0]!.text)).toEqual({ rekordboxPid: 42 });
      expect(providers?.[0]?.name).toBe("codemode");
    } finally {
      await client.close();
      await server.close();
    }
  });

  localSandboxTest(
    "runs CodeMode locally in the default isolated runtime",
    async () => {
      const server = await createLocalMusicCodeMcpServer({ dependencies, timeoutMs: 10_000 });
      const client = await connect(server);
      try {
        const result = await client.callTool({
          name: "code",
          arguments: { code: "async () => codemode.rekordbox_status({})" },
        });
        const content = result.content as Array<{ type: string; text: string }>;
        if (result.isError) throw new Error(content[0]!.text);
        expect(result.isError).not.toBe(true);
        expect(JSON.parse(content[0]!.text)).toEqual({ rekordboxPid: 42 });
      } finally {
        await client.close();
        await server.close();
      }
    },
    20_000,
  );
});
