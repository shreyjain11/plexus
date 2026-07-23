import { defineConfig } from "@playwright/test";

/**
 * Smoke tests run against the Vite dev server. The fake-media-stream launch
 * flags let the hand-tracking path initialize headlessly with a synthetic
 * camera (a real pinch gesture cannot be simulated — see e2e/smoke.spec.ts).
 */
export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:5173",
    acceptDownloads: true,
    launchOptions: {
      args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
    },
  },
  webServer: {
    command: "npm run dev -- --port 5173 --strictPort",
    url: "http://localhost:5173",
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
