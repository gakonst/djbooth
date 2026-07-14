export function playlistDropTrackNumber(
  sourceTrackNumber: number,
  targetTrackNumber: number,
  placement: "before" | "after",
  count: number,
): number {
  const insertion =
    targetTrackNumber +
    (placement === "after" ? 1 : 0) -
    (sourceTrackNumber < targetTrackNumber ? 1 : 0);
  return Math.min(count, Math.max(1, insertion));
}
