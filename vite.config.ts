import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const repoRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: "web",
  base: process.env.GITHUB_PAGES === "true" ? "/arkade-standing-match/" : "/",
  build: {
    outDir: "../dist",
    emptyOutDir: true,
  },
  server: {
    fs: {
      allow: [repoRoot],
    },
    host: "127.0.0.1",
    port: 5173,
  },
});
