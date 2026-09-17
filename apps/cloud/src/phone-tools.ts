import { hostedToolCatalogDigest } from "nanocodex/tools/hosted-catalog";
import catalog from "../../apple/DJBoothKit/Sources/DJBoothKit/Resources/phone-tools.json";

// The approval page and native executor share this exact catalog. Nanocodex
// checks its digest before admitting tools on the grant-bound socket.
export const phoneToolCatalog = catalog;
export const phoneTools = catalog.map((entry) => ({
  name: entry.definition.name,
  provider: entry.provider,
  remoteName: entry.remote_name,
  description: entry.definition.description,
  parameters: entry.definition.parameters,
  strict: entry.definition.strict,
  parallelSafe: entry.parallel_safe,
  timeoutMs: entry.timeout_ms,
  handler() {
    throw new Error("Open DJ Booth on your phone to query its state.");
  },
}));

export async function phoneToolDigest(): Promise<string> {
  return hostedToolCatalogDigest(catalog);
}

// The native app owns this MCP catalog. The relay caches only its signed metadata.
export { default as appMcpTools } from "../../apple/DJBoothKit/Sources/DJBoothKit/Resources/app-mcp.json";
