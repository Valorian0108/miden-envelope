import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// The SDK ships a 21 MB WASM module plus a Web Worker. Plain Vite handles the
// single-threaded (`st`) build; if the worker fails to resolve, add
// `@miden-sdk/vite-plugin` rather than hand-rolling asset rules.
//
// `pnpm dev:mock` runs Vite in mode "mock", which aliases the SDK to the
// in-memory stand-in in demo/mock-sdk.ts so the library's send and fetch paths
// can run on machines with no SDK binary. Plain `pnpm dev` keeps the real SDK.
export default defineConfig(({ mode }) => ({
  server: { port: 5173, host: "127.0.0.1" },
  optimizeDeps: { exclude: ["@miden-sdk/miden-sdk"] },
  build: {
    target: "esnext",
    // Public surface only: the demo at /, the film at /shell.html, the
    // preview at /preview.html. The root index.html is a dev harness and
    // the stage*.html pages are measurement rigs — none of them ship.
    rollupOptions: {
      input: {
        index: fileURLToPath(new URL("./demo/index.html", import.meta.url)),
        shell: fileURLToPath(new URL("./shell.html", import.meta.url)),
        preview: fileURLToPath(new URL("./preview.html", import.meta.url)),
      },
    },
  },
  resolve:
    mode === "mock"
      ? {
          alias: {
            "@miden-sdk/miden-sdk": fileURLToPath(
              new URL("./demo/mock-sdk.ts", import.meta.url),
            ),
          },
        }
      : undefined,
}));
