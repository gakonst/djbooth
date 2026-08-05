import { readFileSync } from "node:fs";

import { Cli } from "incur";

export const DJBOOTH_VERSION = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;

/** Create the shared root without loading any command implementation. */
export function createDjBoothRoot(
  options: { tools?: { include: string[] } } = {},
): ReturnType<typeof Cli.create> {
  return Cli.create("djbooth", {
    version: DJBOOTH_VERSION,
    description:
      "Agentically drive DJ-set discovery, acquisition, analysis, stems, library management, deck serving, and Rekordbox-compatible exports.",
    hint: "Run djbooth <command> --help for examples and typed options. Workflow stages are direct commands; specialist providers remain grouped.",
    mcp: {
      instructions:
        "Use the narrowest typed djbooth tool that completes the request. Tool descriptions, schemas, and errors are the workflow source of truth.",
      ...(options.tools ? { tools: options.tools } : {}),
    },
  });
}
