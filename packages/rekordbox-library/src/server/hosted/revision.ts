import { createHash } from "node:crypto";

export function hostedRevision(provider: "spotify" | "soundcloud", parts: unknown[]): string {
  return `${provider}:${createHash("sha256").update(JSON.stringify(parts)).digest("hex")}`;
}
