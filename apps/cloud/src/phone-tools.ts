import catalog from "../../apple/DJBoothKit/Sources/DJBoothKit/Resources/phone-tools.json";

// The approval page and native executor share this exact catalog. Nanocodex
// checks its digest before admitting tools on the grant-bound socket.
export const phoneToolCatalog = catalog;
export const phoneTools = catalog.map((entry) => ({
  name: entry.definition.name,
  description: entry.definition.description,
  parameters: entry.definition.parameters,
  strict: entry.definition.strict,
  parallelSafe: entry.parallel_safe,
  timeoutMs: entry.timeout_ms,
  handler() {
    throw new Error("Open DJ Booth on your phone to query its state.");
  },
}));

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
export async function phoneToolDigest(): Promise<string> {
  const bytes = new TextEncoder().encode(`nanocodex-app-tool-catalog-v1\0${canonical(catalog)}`);
  return `0x${[...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
