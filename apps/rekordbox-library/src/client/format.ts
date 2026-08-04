export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "—";
  const rounded = Math.round(seconds);
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const remaining = rounded % 60;
  return hours > 0
    ? `${String(hours)}:${String(minutes).padStart(2, "0")}:${String(remaining).padStart(2, "0")}`
    : `${String(minutes)}:${String(remaining).padStart(2, "0")}`;
}

export function formatBpm(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value) || value <= 0) return "—";
  const normalized = value > 1_000 ? value / 100 : value;
  return Number.isInteger(normalized) ? String(normalized) : normalized.toFixed(1);
}

export function formatBytes(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value) || value < 0) return "—";
  if (value < 1_024) return `${String(value)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let amount = value;
  let index = -1;
  do {
    amount /= 1_024;
    index += 1;
  } while (amount >= 1_024 && index < units.length - 1);
  return `${amount >= 10 ? amount.toFixed(0) : amount.toFixed(1)} ${units[index]}`;
}

export function formatSampleRate(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value) || value <= 0) return "—";
  return `${(value / 1_000).toFixed(value % 1_000 === 0 ? 0 : 1)} kHz`;
}

export function formatBitRate(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value) || value <= 0) return "—";
  const kbps = value > 10_000 ? value / 1_000 : value;
  return `${Math.round(kbps)} kbps`;
}

export function compactCount(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "0";
  return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(
    value,
  );
}

export function pathBasename(value: string | null | undefined): string {
  if (!value) return "Unknown file";
  return value.split(/[\\/]/u).filter(Boolean).at(-1) ?? value;
}

export function titleInitials(title: string | null | undefined, artist: string | null | undefined) {
  const words = `${artist ?? ""} ${title ?? ""}`.trim().split(/\s+/u).filter(Boolean);
  return (words[0]?.[0] ?? "M") + (words[1]?.[0] ?? "");
}

export function artworkHue(id: string): number {
  let hash = 0;
  for (const character of id) hash = (hash * 31 + character.charCodeAt(0)) | 0;
  return Math.abs(hash) % 360;
}
