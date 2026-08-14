/** Return whether the embedded assistant should run for a workbench query string. */
export function assistantEnabledFromSearch(search: string): boolean {
  const value = new URLSearchParams(search).get("assistant");
  return value !== "0" && value !== "false";
}

export type DjBoothView = "booth" | "library";

/** Resolve one same-origin workstation route into its top-level view. */
export function djBoothViewFromPath(pathname: string): DjBoothView {
  return pathname === "/booth" || pathname.startsWith("/booth/") ? "booth" : "library";
}

/** Build the browser URL for an embedded-assistant or agent-hosted workbench. */
export function workbenchUrl(serverUrl: string, assistantEnabled: boolean): string {
  const url = new URL(serverUrl);
  if (assistantEnabled) url.searchParams.delete("assistant");
  else url.searchParams.set("assistant", "0");
  return url.toString();
}
