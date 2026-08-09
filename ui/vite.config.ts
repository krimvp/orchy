import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// `npm run ui:dev` serves this and sends every call to the daemon.
export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    proxy: {
      "/api": { target: "http://127.0.0.1:4000", changeOrigin: true },
    },
  },
});
