import type { Executor, ResolvedProvider } from "@cloudflare/codemode";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Cli, z } from "incur";
import { describe, expect, it } from "vitest";

import {
  createLocalDjBoothCodeMcpServer,
  createDjBoothCodeMcpServer,
  createDjBoothMcpServer,
} from "../src/index.js";

function createTestDjBoothCli(): ReturnType<typeof Cli.create> {
  const cli = Cli.create("djbooth");
  cli.command(
    Cli.create("status", {
      run: () => ({ rekordboxPid: 42 }),
    }),
  );
  cli.command(
    Cli.create("slsk").command("info", {
      run: () => ({ connected: false }),
    }),
  );

  const soundcloudAuth = Cli.create("auth").command("status", {
    run: () => ({ loggedIn: false }),
  });
  cli.command(Cli.create("soundcloud").command(soundcloudAuth));

  const spotsAuth = Cli.create("auth").command("status", {
    run: () => ({ loggedIn: false }),
  });
  cli.command(Cli.create("spots").command(spotsAuth));

  cli.command(
    Cli.create("resolve", {
      args: z.object({ source: z.string() }),
      run: ({ args }) => ({ source: args.source }),
    }),
  );
  cli.command(
    Cli.create("ytdlp-ts").command("engines", {
      run: () => ({ native: { available: true } }),
    }),
  );
  return cli;
}

const localSandboxTest = process.platform === "win32" ? it.skip : it;

const toolCalls = [
  { name: "status", arguments: {} },
  { name: "slsk_info", arguments: {} },
  { name: "soundcloud_auth_status", arguments: {} },
  { name: "spots_auth_status", arguments: {} },
  { name: "resolve", arguments: { source: "https://youtu.be/example" } },
  { name: "ytdlp-ts_engines", arguments: {} },
] as const;

async function connect(server: McpServer): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "djbooth-test", version: "1.0.0" });
  await client.connect(clientTransport);
  return client;
}

describe("djbooth MCP adapters", () => {
  it("exposes the composed CLI command map as normal MCP tools", async () => {
    const server = createDjBoothMcpServer({ cli: createTestDjBoothCli() });
    const client = await connect(server);
    try {
      const { tools } = await client.listTools();
      expect(tools.map(({ name }) => name).sort()).toEqual([
        "resolve",
        "slsk_info",
        "soundcloud_auth_status",
        "spots_auth_status",
        "status",
        "ytdlp-ts_engines",
      ]);

      const result = await client.callTool({ name: "status", arguments: {} });
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
        const status = providers?.[0]?.fns.status;
        if (!status) return { result: undefined, error: "missing status" };
        return { result: await status({}) };
      },
    };
    const server = await createDjBoothCodeMcpServer({ cli: createTestDjBoothCli(), executor });
    const client = await connect(server);
    try {
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(1);
      expect(tools[0]?.name).toBe("code");
      expect(tools[0]?.description).toContain("status");

      const result = await client.callTool({
        name: "code",
        arguments: { code: "async () => codemode.status({})" },
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
      const server = await createLocalDjBoothCodeMcpServer({
        cli: createTestDjBoothCli(),
        timeoutMs: 10_000,
      });
      const client = await connect(server);
      try {
        const result = await client.callTool({
          name: "code",
          arguments: { code: "async () => codemode.status({})" },
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

  localSandboxTest(
    "runs every Incur tool concurrently through normal and local CodeMode MCP",
    async () => {
      const rounds = 20;
      const normalServer = createDjBoothMcpServer({ cli: createTestDjBoothCli() });
      const normalClient = await connect(normalServer);
      try {
        const results = await Promise.all(
          Array.from({ length: rounds }, () =>
            toolCalls.map(({ name, arguments: args }) =>
              normalClient.callTool({ name, arguments: args }),
            ),
          ).flat(),
        );
        expect(results).toHaveLength(rounds * toolCalls.length);
        expect(results.every(({ isError }) => isError !== true)).toBe(true);
      } finally {
        await normalClient.close();
        await normalServer.close();
      }

      const codeServer = await createLocalDjBoothCodeMcpServer({
        cli: createTestDjBoothCli(),
        timeoutMs: 20_000,
      });
      const codeClient = await connect(codeServer);
      try {
        const calls = Array.from({ length: rounds }, () => [
          "codemode.status({})",
          "codemode.slsk_info({})",
          "codemode.soundcloud_auth_status({})",
          "codemode.spots_auth_status({})",
          'codemode.resolve({ source: "https://youtu.be/example" })',
          'codemode["ytdlp-ts_engines"]({})',
        ]).flat();
        const result = await codeClient.callTool({
          name: "code",
          arguments: { code: `async () => Promise.all([${calls.join(",")}])` },
        });
        const content = result.content as Array<{ type: string; text: string }>;
        if (result.isError) throw new Error(content[0]!.text);
        expect(JSON.parse(content[0]!.text)).toHaveLength(rounds * toolCalls.length);
      } finally {
        await codeClient.close();
        await codeServer.close();
      }
    },
    30_000,
  );
});
