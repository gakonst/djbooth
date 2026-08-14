import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { LiveHardwareMonitor } from "./HardwareMonitor.js";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root mount point");

createRoot(root).render(
  <StrictMode>
    <div className="hardware-view">
      <LiveHardwareMonitor />
    </div>
  </StrictMode>,
);
