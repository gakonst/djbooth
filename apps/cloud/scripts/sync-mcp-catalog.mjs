import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { hostedAppToolCatalog, hostedToolCatalogDigest } from "nanocodex/tools/hosted-catalog";

const root = new URL("../../apple/DJBoothKit/Sources/DJBoothKit/Resources/", import.meta.url);
const app = JSON.parse(await readFile(new URL("app-mcp.json", root), "utf8"));
const approved = JSON.parse(await readFile(new URL("phone-tools.json", root), "utf8"));
const cloud = approved.find((tool) => tool.definition.name === "djbooth_exec");
if (!cloud) throw new Error("Missing cloud executor schema");
const tools = [
  cloud,
  ...app.map((tool) => ({
    provider: "javascript",
    remote_name: tool.name,
    definition: {
      type: "function",
      name: `mcp__djbooth__${tool.name}`,
      description: tool.description,
      parameters: tool.inputSchema,
      strict: false,
    },
    parallel_safe: tool.annotations?.readOnlyHint === true,
    timeout_ms: Number.MAX_SAFE_INTEGER,
  })),
];
let normalized = hostedAppToolCatalog(
  tools.map((tool) => ({
    name: tool.definition.name,
    provider: tool.provider,
    remoteName: tool.remote_name,
    description: tool.definition.description,
    parameters: tool.definition.parameters,
    strict: tool.definition.strict,
    parallelSafe: tool.parallel_safe,
    timeoutMs: tool.timeout_ms,
    handler() {
      throw new Error("Catalog generation only");
    },
  })),
);
const canonical = (value) =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(",")}]`
    : value && typeof value === "object"
      ? `{${Object.keys(value)
          .sort()
          .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
          .join(",")}}`
      : JSON.stringify(value);
// Swift hashes the bundled canonical array. Store the exact ordering used by
// Nanocodex's digest, which sorts canonical entries rather than tool names.
normalized = normalized.toSorted((a, b) => canonical(a).localeCompare(canonical(b)));
const digest =
  "0x" +
  createHash("sha256")
    .update("nanocodex-app-tool-catalog-v1\0" + canonical(normalized))
    .digest("hex");
if (digest !== (await hostedToolCatalogDigest(normalized)))
  throw new Error("Catalog digest mismatch");
await writeFile(new URL("phone-tools.json", root), JSON.stringify(normalized, null, 2) + "\n");
console.log(`Synchronized ${app.length} app MCP tools and the cloud executor (${digest}).`);
