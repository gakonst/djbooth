import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { App } from "./App.js";
import "./styles.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry(failureCount, error) {
        const status = typeof error === "object" && error && "status" in error ? error.status : 0;
        return Number(status) >= 400 && Number(status) < 500 ? false : failureCount < 2;
      },
      staleTime: 10_000,
    },
  },
});

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root mount point");

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
