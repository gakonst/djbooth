import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";
import { HardwareMonitor, LiveHardwareMonitor } from "../../dj-monitor/src/HardwareMonitor.js";
import type { DashboardSnapshot } from "../../dj-monitor/src/types.js";
import "../../dj-monitor/src/styles.css";
import "./decks-view.css";

function DecksView() {
  const [preview, setPreview] = useState<DashboardSnapshot | null>(null);
  const [mode, setMode] = useState<"live" | "replay">("replay");
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (
        event.source !== parent ||
        event.origin !== location.origin ||
        event.data?.type !== "party-preview"
      )
        return;
      setPreview(event.data.snapshot ?? null);
      setMode(event.data.mode === "live" ? "live" : "replay");
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, []);
  return (
    <div className="hardware-view">
      {preview ? (
        <HardwareMonitor snapshot={preview} status="live" mode={mode} />
      ) : (
        <LiveHardwareMonitor />
      )}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<DecksView />);
