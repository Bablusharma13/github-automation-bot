import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // `server-only` throws outside the react-server condition; tests run server code directly.
      "server-only": fileURLToPath(new URL("./tests/helpers/server-only-stub.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/helpers/setup-env.ts"],
    // PGlite instances are per-file; keep files isolated.
    pool: "forks",
    testTimeout: 20_000,
    // Each DB-backed file boots an in-process Postgres (PGlite/WASM) and runs the
    // migrations in beforeAll. With ~16 files starting at once this exceeded the default
    // 10s hook timeout on a 12-core machine, so allow more time and cap parallelism.
    hookTimeout: 60_000,
    // A fixed cap rather than a share of CPUs: every worker may hold a PGlite instance,
    // so memory, not cores, is the limit. "50%" (6 workers) failed with WASM/ArrayBuffer
    // allocation errors on a 12-thread machine with 7.4 GB RAM.
    maxWorkers: 3,
  },
});
