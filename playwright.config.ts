import { defineConfig } from "@playwright/test";

/**
 * Smoke tests run against the local Vite dev server by default. Set
 * E2E_BASE_URL (e.g. to the production deployment) to run the identical
 * suite against a live site instead — no local server is started then.
 *
 * The fake-media-stream launch flags let the hand-tracking path initialize
 * headlessly with a synthetic camera (a real pinch gesture cannot be
 * simulated — see e2e/smoke.spec.ts).
 */
const externalBaseUrl = process.env.E2E_BASE_URL;

export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: externalBaseUrl ?? "http://localhost:5173",
    acceptDownloads: true,
    launchOptions: {
      args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
    },
  },
  ...(externalBaseUrl
    ? {}
    : {
        webServer: {
          command: "npm run dev -- --port 5173 --strictPort",
          url: "http://localhost:5173",
          reuseExistingServer: true,
          timeout: 120_000,
        },
      }),
});
