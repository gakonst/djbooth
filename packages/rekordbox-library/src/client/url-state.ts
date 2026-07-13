import { useCallback, useEffect, useState } from "react";

export type LibraryUrlState = {
  playlistId: string | null;
  trackId: string | null;
  query: string;
  filter: string;
};

function readUrlState(): LibraryUrlState {
  const params = new URLSearchParams(window.location.search);
  return {
    playlistId: params.get("playlist"),
    trackId: params.get("track"),
    query: params.get("q") ?? "",
    filter: params.get("filter") ?? "all",
  };
}

export function useLibraryUrlState() {
  const [state, setState] = useState<LibraryUrlState>(readUrlState);

  useEffect(() => {
    const onPopState = () => setState(readUrlState());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const update = useCallback(
    (next: Partial<LibraryUrlState>, options: { replace?: boolean } = {}) => {
      const params = new URLSearchParams(window.location.search);
      const values = { ...state, ...next };
      setParam(params, "playlist", values.playlistId);
      setParam(params, "track", values.trackId);
      setParam(params, "q", values.query);
      setParam(params, "filter", values.filter === "all" ? null : values.filter);
      const url = `${window.location.pathname}${params.size ? `?${params.toString()}` : ""}`;
      window.history[options.replace ? "replaceState" : "pushState"]({}, "", url);
      setState(values);
    },
    [state],
  );

  return { state, update };
}

function setParam(params: URLSearchParams, key: string, value: string | null | undefined): void {
  if (value == null || value.trim() === "") params.delete(key);
  else params.set(key, value);
}
