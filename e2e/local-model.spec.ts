import { test, expect, type Page } from "@playwright/test";

/**
 * The in-browser model tier, for real.
 *
 * Everything else about tier 3 is provable offline: `tests/local.test.ts`
 * drives the answerer with a fake embedder, and the smoke suite proves nothing
 * is downloaded unasked. Neither of those touches the part that can only fail
 * in a browser — a module worker, a 23 MB model, and an ONNX runtime fetched
 * from a CDN we deliberately do not bundle.
 *
 * That last one is why this file exists rather than being a nice-to-have.
 * `vite.config.ts` deletes ORT's WebAssembly from the build on the grounds that
 * transformers.js never asks for our copy. This test is the thing that keeps
 * that claim honest: it fails on any 404, so if the runtime ever does reach for
 * a local file, the build stops being quietly broken.
 *
 * Gated behind E2E_LOCAL_MODEL because it costs ~30 MB and a minute or two;
 * `npm run test:e2e:model` sets it. Run it after touching the worker, the
 * bundler config, or the transformers.js version.
 */

const GATE = process.env.E2E_LOCAL_MODEL === undefined;

/** A phrasing with no tier-1 rule behind it: only the model can answer this. */
const LOOSE = "we're missing a data store in this picture";

/**
 * Collect the failures that matter. The dev server has no serverless
 * functions, so tier 2's probe of `/api/voice` 404s locally and is expected —
 * that is precisely the "no key, no route" path this tier exists to cover.
 */
function watchFailures(page: Page): string[] {
  const bad: string[] = [];
  page.on("response", (r) => {
    if (r.status() >= 400 && !r.url().includes("/api/voice")) bad.push(`${r.status()} ${r.url()}`);
  });
  page.on("requestfailed", (r) => {
    const url = r.url();
    if (!url.includes("/api/voice")) bad.push(`${r.failure()?.errorText ?? "failed"} ${url}`);
  });
  page.on("pageerror", (e) => bad.push(`pageerror: ${String(e)}`));
  return bad;
}

test.describe("the in-browser model, actually loaded", () => {
  test.skip(GATE, "set E2E_LOCAL_MODEL=1 — this downloads ~30 MB");
  test.setTimeout(600_000);

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("plexus.tour.v3", "done");
      if (!localStorage.getItem("plexus.theme")) localStorage.setItem("plexus.theme", "light");
    });
    await page.goto("/");
    await expect(page.locator(".canvas")).toBeVisible();
  });

  test("downloads on request, then parses a sentence the grammar declined", async ({ page }) => {
    const bad = watchFailures(page);

    const note = page.locator(".voice__opt-note");
    await expect(note).toContainText("30 MB");

    // `check()` fails unless the box flips on the spot, which makes this the
    // regression test for a bug only a real network shows: the checkbox used
    // to be driven by the loader, and the loader is itself a dynamic import,
    // so the click did visibly nothing until a chunk arrived. Locally that is
    // a millisecond and invisible; over the wire it reads as broken.
    await page.getByTestId("voice-local").check();
    // 30 MB is worth a progress reading rather than a dead checkbox.
    await expect(note).toContainText(/downloading|starting/, { timeout: 60_000 });
    await expect(note).toContainText("runs offline, free", { timeout: 540_000 });

    const input = page.getByTestId("voice-input");
    await input.fill(LOOSE);
    await input.press("Enter");

    // Both halves of the tier at once: the model found `add`, and the lexical
    // table found `cylinder` — a plain box here would mean only half of it ran.
    await expect(page.locator(".node")).toHaveCount(1, { timeout: 30_000 });
    await expect(page.locator(".node ellipse.node__lid")).toHaveCount(1);
    await expect(page.locator(".voice__last")).not.toHaveClass(/--warn/);

    expect(bad, `network/page failures: ${bad.join(" | ")}`).toEqual([]);
  });

  test("stays on across a reload, and then really does run offline", async ({ page, context }) => {
    await page.getByTestId("voice-local").check();
    const note = page.locator(".voice__opt-note");
    await expect(note).toContainText("runs offline, free", { timeout: 540_000 });

    await page.reload();
    await expect(page.getByTestId("voice-local")).toBeChecked();
    await expect(note).toContainText("runs offline, free", { timeout: 300_000 });

    // The label promises "runs offline". Hold it to that: sever every route to
    // the model and the runtime, leaving only the app's own origin.
    const origin = new URL(page.url()).origin;
    await context.route("**/*", (route) => {
      const sameOrigin = route.request().url().startsWith(origin);
      return sameOrigin ? route.continue() : route.abort();
    });

    const input = page.getByTestId("voice-input");
    await input.fill(LOOSE);
    await input.press("Enter");
    await expect(page.locator(".node ellipse.node__lid")).toHaveCount(1, { timeout: 60_000 });
  });
});
