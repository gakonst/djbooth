import { TracksError } from "./errors.js";

export function parseTimestamp(value: string | number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : undefined;

  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);

  const rawParts = trimmed.split(":");
  if (rawParts.some((part) => part === "")) return undefined;
  const parts = rawParts.map(Number);
  if (parts.some((part) => !Number.isFinite(part)) || parts.length < 2 || parts.length > 3)
    return undefined;

  if (parts.some((part) => part < 0)) return undefined;
  if (parts.at(-1)! >= 60) return undefined;
  if (parts.length === 3 && parts[1]! >= 60) return undefined;

  if (parts.length === 2) return parts[0]! * 60 + parts[1]!;
  return parts[0]! * 3600 + parts[1]! * 60 + parts[2]!;
}

export function requireTimestamp(value: string): number {
  const seconds = parseTimestamp(value);
  if (seconds === undefined) {
    throw new TracksError(
      "INVALID_SOURCE",
      `Invalid timestamp ${JSON.stringify(value)}; use seconds, MM:SS, or HH:MM:SS`,
      { exitCode: 2 },
    );
  }
  return seconds;
}

export function formatTimestamp(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return [hours, minutes, remainder].map((part) => String(part).padStart(2, "0")).join(":");
}
