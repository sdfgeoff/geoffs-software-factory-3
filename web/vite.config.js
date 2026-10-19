import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
export default defineConfig({
  root: resolve("web"),
  plugins: [react()],
  build: { outDir: resolve("dist"), emptyOutDir: true },
  server: {
    host: "0.0.0.0",
    port: 5173,
    proxy: { "/api": "http://127.0.0.1:3001" },
  },
});
