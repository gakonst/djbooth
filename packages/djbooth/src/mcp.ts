import type { Executor } from "@cloudflare/codemode";
import { codeMcpServer } from "@cloudflare/codemode/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Cli, Mcp } from "incur";
import { NodeRuntime, type BindingDefinition } from "secure-exec";
import { z } from "zod";

import { createDjBoothCli, DJBOOTH_MCP_TOOL_FILTER, DJBOOTH_VERSION } from "./cli.js";

export type DjBoothMcpOptions = {
  cli?: ReturnType<typeof createDjBoothCli>;
  instructions?: string;
};

export type DjBoothCodeMcpOptions = DjBoothMcpOptions & {
  executor: Executor;
  description?: string;
};

export type LocalDjBoothCodeMcpOptions = DjBoothMcpOptions & {
  description?: string;
  timeoutMs?: number;
};

const DEFAULT_INSTRUCTIONS =
  "Resolve DJ sets, inspect Spotify and media metadata, search Soulseek, and inspect Rekordbox. Prefer metadata-only inspection before downloading audio.";

/** Deny-by-default local executor with a virtual filesystem and no network access. */
export class SecureExecDjBoothExecutor implements Executor {
  constructor(readonly timeoutMs = 30_000) {}

  async execute(
    code: string,
    providersOrFns:
      | import("@cloudflare/codemode").ResolvedProvider[]
      | Record<string, (...args: unknown[]) => Promise<unknown>>,
  ): Promise<import("@cloudflare/codemode").ExecuteResult> {
    const providers = Array.isArray(providersOrFns)
      ? providersOrFns
      : [{ name: "codemode", fns: providersOrFns }];
    const bindings: Record<string, BindingDefinition> = {};
    const namespaces: Record<string, Record<string, string>> = {};

    for (const [providerIndex, provider] of providers.entries()) {
      const binding = `codemode-${providerIndex}`;
      const methods: Record<string, string> = {};
      for (const method of Object.keys(provider.fns)) {
        methods[method] = binding;
      }
      bindings[binding] = {
        description: `${provider.name} method dispatcher`,
        inputSchema: {
          type: "object",
          properties: {
            method: { type: "string" },
            input: { type: "object", additionalProperties: true },
          },
          required: ["method", "input"],
          additionalProperties: false,
        },
        timeoutMs: this.timeoutMs,
        async handler(value: unknown) {
          const request = value as { method?: string; input?: unknown };
          const handler = request.method ? provider.fns[request.method] : undefined;
          if (!handler)
            throw new Error(`Unknown ${provider.name} method '${request.method ?? ""}'`);
          return handler(request.input ?? {});
        },
      };
      namespaces[provider.name] = methods;
    }

    const runtime = await NodeRuntime.create({ bindings });
    try {
      const result = await runtime.run(localSandboxSource(code, namespaces), {
        timeout: this.timeoutMs,
      });
      const logs = result.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      if (result.exitCode !== 0) {
        return {
          result: undefined,
          error: result.stderr.trim() || `Sandbox exited with code ${result.exitCode}`,
          ...(logs.length > 0 ? { logs } : {}),
        };
      }
      return { result: result.value, ...(logs.length > 0 ? { logs } : {}) };
    } catch (error) {
      return { result: undefined, error: error instanceof Error ? error.message : String(error) };
    } finally {
      await runtime.dispose();
    }
  }
}

/** Build the normal typed MCP server from the same command map as the djbooth CLI. */
export function createDjBoothMcpServer(options: DjBoothMcpOptions = {}): McpServer {
  const cli = options.cli ?? createDjBoothCli();
  const commands = Cli.toCommands.get(cli as never);
  if (!commands) throw new Error("Could not read the djbooth command map");

  const server = new McpServer(
    { name: "djbooth", version: DJBOOTH_VERSION },
    { instructions: options.instructions ?? DEFAULT_INSTRUCTIONS },
  );

  for (const tool of Mcp.collectTools(commands, [], [], DJBOOTH_MCP_TOOL_FILTER)) {
    const shape = {
      ...tool.command.args?.shape,
      ...tool.command.options?.shape,
    } as Record<string, z.ZodType>;
    const hasInput = Object.keys(shape).length > 0;
    server.registerTool(
      tool.name,
      {
        ...(tool.description ? { description: tool.description } : {}),
        ...(hasInput ? { inputSchema: shape } : {}),
        ...(tool.annotations ? { annotations: tool.annotations } : {}),
      },
      async (...callArgs: unknown[]) => {
        const params = hasInput ? (callArgs[0] as Record<string, unknown>) : {};
        return Mcp.callTool(tool, params, { name: "djbooth", version: DJBOOTH_VERSION });
      },
    );
  }

  return server;
}

/** Collapse the normal djbooth MCP server into one sandboxed TypeScript `code` tool. */
export async function createDjBoothCodeMcpServer(
  options: DjBoothCodeMcpOptions,
): Promise<McpServer> {
  return codeMcpServer({
    server: createDjBoothMcpServer(options),
    executor: options.executor,
    ...(options.description ? { description: options.description } : {}),
  });
}

/** Build the zero-config local CodeMode server using Secure Exec isolation. */
export function createLocalDjBoothCodeMcpServer(
  options: LocalDjBoothCodeMcpOptions = {},
): Promise<McpServer> {
  return createDjBoothCodeMcpServer({
    ...options,
    executor: new SecureExecDjBoothExecutor(options.timeoutMs),
  });
}

/** Serve the normal MCP adapter over stdio. */
export async function serveDjBoothMcp(options: DjBoothMcpOptions = {}): Promise<void> {
  await createDjBoothMcpServer(options).connect(new StdioServerTransport());
}

/** Serve the single-tool CodeMode adapter over stdio with a caller-supplied sandbox executor. */
export async function serveDjBoothCodeMcp(options: DjBoothCodeMcpOptions): Promise<void> {
  await (await createDjBoothCodeMcpServer(options)).connect(new StdioServerTransport());
}

/** Serve zero-config local CodeMode over stdio. */
export async function serveLocalDjBoothCodeMcp(
  options: LocalDjBoothCodeMcpOptions = {},
): Promise<void> {
  await (await createLocalDjBoothCodeMcpServer(options)).connect(new StdioServerTransport());
}

/** Legacy type alias for callers using the former product name. */
export type MusicMcpOptions = DjBoothMcpOptions;

/** Legacy type alias for callers using the former product name. */
export type MusicCodeMcpOptions = DjBoothCodeMcpOptions;

/** Legacy type alias for callers using the former product name. */
export type LocalMusicCodeMcpOptions = LocalDjBoothCodeMcpOptions;

/** Legacy API alias for callers using the former product name. */
export { SecureExecDjBoothExecutor as SecureExecMusicExecutor };

/** Legacy API alias for callers using the former product name. */
export const createMusicMcpServer = createDjBoothMcpServer;

/** Legacy API alias for callers using the former product name. */
export const createMusicCodeMcpServer = createDjBoothCodeMcpServer;

/** Legacy API alias for callers using the former product name. */
export const createLocalMusicCodeMcpServer = createLocalDjBoothCodeMcpServer;

/** Legacy API alias for callers using the former product name. */
export const serveMusicMcp = serveDjBoothMcp;

/** Legacy API alias for callers using the former product name. */
export const serveMusicCodeMcp = serveDjBoothCodeMcp;

/** Legacy API alias for callers using the former product name. */
export const serveLocalMusicCodeMcp = serveLocalDjBoothCodeMcp;

function localSandboxSource(
  code: string,
  namespaces: Record<string, Record<string, string>>,
): string {
  return `
import { execFileSync } from "node:child_process";
const invoke = async (command, method, input) => {
  const response = JSON.parse(execFileSync(
    command,
    [command, "--json", JSON.stringify({ method, input: input ?? {} })],
    { encoding: "utf8" },
  ));
  if (!response.ok) throw new Error(response.error ?? command + " failed");
  return response.result;
};
const namespaces = ${JSON.stringify(namespaces)};
for (const [namespace, methods] of Object.entries(namespaces)) {
  globalThis[namespace] = Object.fromEntries(
    Object.entries(methods).map(([method, command]) => [
      method,
      async (input = {}) => invoke(command, method, input),
    ]),
  );
}
globalThis.__return(await (${code})());
`;
}
