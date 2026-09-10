import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "frontend",
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": process.env.EVA_BACKEND_URL ?? "http://localhost:3001",
      "/health": process.env.EVA_BACKEND_URL ?? "http://localhost:3001",
    },
  },
});
