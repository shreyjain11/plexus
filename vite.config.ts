/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Drop ONNX Runtime's WebAssembly binaries from the build output.
 *
 * They get emitted because onnxruntime-web contains a literal
 * `new URL("ort-wasm-simd-threaded.asyncify.wasm", import.meta.url)`, which
 * Vite resolves at build time — so `dist/` gains ~27 MB per variant. None of it
 * is ever fetched: transformers.js points the runtime at its own pinned CDN
 * copy on startup, and it has to, because which variant is correct (asyncify /
 * jspi / jsep) is a function of the visitor's browser, not of our build.
 *
 * Deleting an asset a chunk still references is only safe while that reference
 * stays dead, so it is not left to trust: `e2e/local-model.spec.ts` loads the
 * real model in a real browser and fails on any 404.
 */
function dropUnusedOrtWasm(): Plugin {
  return {
    name: "plexus:drop-unused-ort-wasm",
    apply: "build",
    generateBundle(_options, bundle) {
      for (const [file, asset] of Object.entries(bundle)) {
        if (asset.type === "asset" && /ort-wasm.*\.wasm$/.test(file)) delete bundle[file];
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), dropUnusedOrtWasm()],
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
