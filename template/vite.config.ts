import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { pyreLocalHost } from "./dev/pyre-local-host";

export default defineConfig({
  // Relative asset URLs: the same bundle is served from `<slug>.<domain>/` and `/a/<slug>/`.
  base: "./",
  plugins: [react(), tailwindcss(), pyreLocalHost()],
  resolve: {
    // `@pyre/app-sdk` is installed from a path (`file:`), so it lives behind a symlink.
    // Keeping the symlinked path makes its own imports (react) resolve from this app's
    // node_modules, and dedupe guarantees a single React instance.
    preserveSymlinks: true,
    dedupe: ["react", "react-dom"],
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
  },
  server: { port: 5173 },
  preview: { port: 4173 },
});
