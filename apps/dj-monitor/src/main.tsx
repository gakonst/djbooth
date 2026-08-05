import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { LiveHardwareMonitor } from "./HardwareMonitor";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root mount point");

createRoot(root).render(
  <StrictMode>
    <LiveHardwareMonitor />
  </StrictMode>,
);
