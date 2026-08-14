import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LiveHardwareMonitor } from "@gakonst/dj-monitor";

import { App } from "./App.js";
import { assistantEnabledFromSearch, djBoothViewFromPath } from "../workbench-mode.js";
import "@gakonst/dj-monitor/styles.css";
import "./styles.css";
import "./assistant.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry(failureCount, error) {
        const status = typeof error === "object" && error && "status" in error ? error.status : 0;
        return Number(status) >= 400 && Number(status) < 500 ? false : failureCount < 2;
      },
      // The local event stream and explicit refresh own cache freshness. Avoid repeating SQLite
      // reads merely because a panel remounted or the browser network state changed.
      staleTime: Number.POSITIVE_INFINITY,
    },
  },
});

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root mount point");
const assistantEnabled = assistantEnabledFromSearch(window.location.search);
const boothView = djBoothViewFromPath(window.location.pathname) === "booth";

createRoot(root).render(
  <StrictMode>
    {boothView ? (
      <div className="hardware-view">
        <nav className="view-switcher" aria-label="DJ booth views">
          <a href={assistantEnabled ? "/" : "/?assistant=0"}>Library</a>
          <a aria-current="page" href="/booth">
            Live booth
          </a>
        </nav>
        <LiveHardwareMonitor />
      </div>
    ) : (
      <QueryClientProvider client={queryClient}>
        <App assistantEnabled={assistantEnabled} />
      </QueryClientProvider>
    )}
  </StrictMode>,
);
