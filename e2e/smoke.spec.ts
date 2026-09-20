import { test, expect, type Page } from "@playwright/test";

interface Pt {
  x: number;
  y: number;
}

/** Draw a stroke in the canvas via synthetic mouse (Chromium turns these into
 * pointer events, exercising the exact production drawing path). */
async function drawStroke(page: Page, pts: Pt[]): Promise<void> {
  const first = pts[0]!;
  await page.mouse.move(first.x, first.y);
  await page.mouse.down();
  for (let i = 1; i < pts.length; i++) {
    await page.mouse.move(pts[i]!.x, pts[i]!.y, { steps: 4 });
  }
  await page.mouse.up();
}

function rectPts(x: number, y: number, w: number, h: number): Pt[] {
  const pts: Pt[] = [];
  const seg = (ax: number, ay: number, bx: number, by: number, n: number) => {
    for (let i = 1; i <= n; i++) pts.push({ x: ax + ((bx - ax) * i) / n, y: ay + ((by - ay) * i) / n });
  };
  pts.push({ x, y });
  seg(x, y, x + w, y, 8);
  seg(x + w, y, x + w, y + h, 6);
  seg(x + w, y + h, x, y + h, 8);
  seg(x, y + h, x, y, 6);
  pts.push({ x: x + 2, y: y + 2 }); // close the loop
  return pts;
}

function circlePts(cx: number, cy: number, r: number, n = 30): Pt[] {
  const pts: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2 * 0.96; // small gap so it reads as closed
    pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  return pts;
}

test.beforeEach(async ({ page }) => {
  // Seed the tour as completed so the guided overlay doesn't sit on top of
  // every spec (the tour test uses its own fresh context), and pin the theme
  // to light — but only when unset, so theme-persistence tests still work.
  await page.addInitScript(() => {
    localStorage.setItem("plexus.tour.v3", "done");
    if (!localStorage.getItem("plexus.theme")) localStorage.setItem("plexus.theme", "light");
  });
  await page.goto("/");
  await expect(page.locator(".canvas")).toBeVisible();
});

test("draws a box that is recognized as a rectangle node", async ({ page }) => {
  await drawStroke(page, rectPts(360, 200, 190, 120));
  await expect(page.locator(".node rect.node__shape")).toHaveCount(1);
  await expect(page.locator(".node ellipse.node__shape")).toHaveCount(0);
});

test("draws a circle that is recognized as an ellipse node", async ({ page }) => {
  await drawStroke(page, circlePts(600, 320, 85));
  await expect(page.locator(".node ellipse.node__shape")).toHaveCount(1);
  await expect(page.locator(".node rect.node__shape")).toHaveCount(0);
});

test("connects two boxes with an arrow that survives dragging a node", async ({ page }) => {
  await drawStroke(page, rectPts(340, 380, 160, 120)); // box A, center ~ (420,440)
  await drawStroke(page, rectPts(820, 380, 160, 120)); // box B, center ~ (900,440)
  await expect(page.locator(".node rect.node__shape")).toHaveCount(2);

  // Connector from inside A to inside B → snaps to both, arrowhead on by default.
  await drawStroke(page, [
    { x: 420, y: 440 },
    { x: 560, y: 440 },
    { x: 700, y: 440 },
    { x: 900, y: 440 },
  ]);
  const edge = page.locator(".edge__line");
  await expect(edge).toHaveCount(1);
  await expect(edge).toHaveAttribute("marker-end", /plexus-arrow/);

  // Switch to Select and drag box B; the attached edge must re-route, not vanish.
  await page.keyboard.press("v");
  await page.mouse.move(900, 440);
  await page.mouse.down();
  await page.mouse.move(940, 560, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator(".edge__line")).toHaveCount(1);
  await expect(page.locator(".node rect.node__shape")).toHaveCount(2);
});

test("double-click opens the inline label editor and commits on Enter", async ({ page }) => {
  await drawStroke(page, rectPts(400, 240, 180, 120)); // center ~ (490,300)
  await expect(page.locator(".node rect.node__shape")).toHaveCount(1);

  await page.keyboard.press("v");
  await page.mouse.dblclick(490, 300);
  const editor = page.locator(".label-editor");
  await expect(editor).toBeVisible();
  await editor.fill("KINASE");
  await page.keyboard.press("Enter");
  await expect(page.locator(".node__label")).toHaveText("KINASE");
});

test("a stroke that starts and ends inside one node is rejected, not a phantom edge", async ({ page }) => {
  await drawStroke(page, rectPts(380, 240, 220, 140)); // center ~ (490,310)
  await expect(page.locator(".node rect.node__shape")).toHaveCount(1);

  // Straight line entirely within the node → both ends snap to it.
  await drawStroke(page, [
    { x: 430, y: 310 },
    { x: 470, y: 310 },
    { x: 510, y: 310 },
    { x: 550, y: 310 },
  ]);
  await expect(page.locator(".hud__value")).toHaveText("SELF-LOOP SKIPPED");
  await expect(page.locator(".edge__line")).toHaveCount(0);

  // And undo must revert the node draw, not a phantom edge.
  await page.keyboard.press(process.platform === "darwin" ? "Meta+z" : "Control+z");
  await expect(page.locator(".node rect.node__shape")).toHaveCount(0);
});

test("exports a standalone, valid SVG with shapes and an arrow marker", async ({ page }) => {
  await page.getByRole("button", { name: /Sample/ }).click();
  await expect(page.locator(".node__shape")).toHaveCount(6);

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTitle("Export SVG (⌘/Ctrl-E)").click(),
  ]);
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(c as Buffer);
  const svg = Buffer.concat(chunks).toString("utf8");

  expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
  expect(svg).toMatch(/viewBox="[-\d. ]+"/);
  expect(svg).toContain("<marker");
  expect(svg).toContain("<rect");
  expect(svg).toContain("<ellipse");
  expect(svg).toContain("<polygon"); // diamond + hexagon
  expect(svg).toContain("<path"); // cylinder silhouette (and arrow marker)

  // Confirm it actually parses/renders as a standalone document.
  await page.goto("data:image/svg+xml," + encodeURIComponent(svg));
  await expect(page.locator("ellipse")).toHaveCount(3); // 2 nodes + cylinder lid
  await expect(page.locator("polygon")).toHaveCount(2); // diamond + hexagon
  await expect(page.locator("line")).toHaveCount(6);
});

// ---------------------------------------------------------------------------
// v2: text boxes, palette insert, resize, edge labels, zoom, persistence, redo
// ---------------------------------------------------------------------------

const MOD = process.platform === "darwin" ? "Meta" : "Control";

test("text tool places a text box and commits a label", async ({ page }) => {
  await page.getByTitle(/Text \(T\)/).click();
  await page.mouse.click(520, 300); // drop a text box on the canvas
  const editor = page.locator(".label-editor");
  await expect(editor).toBeVisible();
  await editor.fill("Milestone");
  await page.keyboard.press("Enter");

  await expect(page.locator(".node--text")).toHaveCount(1);
  await expect(page.locator(".node--text .node__label")).toHaveText("Milestone");
  // A text box carries a label but no drawn shape.
  await expect(page.locator(".node--text .node__shape")).toHaveCount(0);
});

test("an empty text box is discarded instead of leaving invisible junk", async ({ page }) => {
  await page.getByTitle(/Text \(T\)/).click();
  await page.mouse.click(520, 300);
  // Wait for focus, not just visibility — the editor focuses itself a tick
  // after mounting, and an Escape that lands before focus would go to the
  // window instead of the editor.
  await expect(page.locator(".label-editor")).toBeFocused();
  await page.keyboard.press("Escape"); // committed nothing
  await expect(page.locator(".node--text")).toHaveCount(0);
});

test("the shape palette inserts a diamond and selects it", async ({ page }) => {
  await page.getByTitle(/Insert diamond/).click();
  await expect(page.locator(".node--diamond polygon.node__shape")).toHaveCount(1);
  await expect(page.locator(".node--diamond.node--selected")).toHaveCount(1);
  // Inserting flips the app into Select mode so it can be manipulated at once.
  await expect(page.locator(".status")).toContainText("SELECT");
});

test("dragging a resize handle grows the node", async ({ page }) => {
  await drawStroke(page, rectPts(360, 220, 180, 120));
  await expect(page.locator(".node rect.node__shape")).toHaveCount(1);

  await page.keyboard.press("v");
  await page.mouse.click(450, 280); // select the node (down+up, no drag)
  await expect(page.locator(".node--selected")).toHaveCount(1);

  const shape = page.locator("rect.node__shape").first();
  const before = (await shape.boundingBox())!;

  const se = page.locator(".handles__grip--se");
  await expect(se).toBeVisible();
  const hb = (await se.boundingBox())!;
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(hb.x + 90, hb.y + 70, { steps: 10 });
  await page.mouse.up();

  const after = (await shape.boundingBox())!;
  expect(after.width).toBeGreaterThan(before.width + 45);
  expect(after.height).toBeGreaterThan(before.height + 35);
});

test("double-clicking an edge opens its label editor", async ({ page }) => {
  await drawStroke(page, rectPts(340, 360, 150, 110)); // A center ~ (415,415)
  await drawStroke(page, rectPts(780, 360, 150, 110)); // B center ~ (855,415)
  await expect(page.locator(".node rect.node__shape")).toHaveCount(2);
  await drawStroke(page, [
    { x: 415, y: 415 },
    { x: 635, y: 415 },
    { x: 855, y: 415 },
  ]);
  await expect(page.locator(".edge__line")).toHaveCount(1);

  await page.keyboard.press("v");
  await page.mouse.dblclick(635, 415); // midpoint of the horizontal connector
  const editor = page.locator(".label-editor");
  await expect(editor).toBeVisible();
  await editor.fill("yes");
  await page.keyboard.press("Enter");
  await expect(page.locator(".edge__label")).toHaveText("yes");
});

test("drawing after zoom lands the shape under the cursor (CTM regression)", async ({ page }) => {
  const zin = page.getByRole("button", { name: "Zoom in" });
  await zin.click();
  await zin.click();
  await expect(page.locator(".zoom__pct")).toHaveText("144%");

  const target = { x: 470, y: 250, w: 200, h: 140 };
  await drawStroke(page, rectPts(target.x, target.y, target.w, target.h));

  const shape = page.locator("rect.node__shape").first();
  await expect(shape).toBeVisible();
  const bb = (await shape.boundingBox())!;
  // The recognized rect should render back roughly where it was drawn on screen —
  // proof the getScreenCTM inverse still maps pointers correctly when zoomed.
  expect(Math.abs(bb.x - target.x)).toBeLessThan(45);
  expect(Math.abs(bb.y - target.y)).toBeLessThan(45);
  expect(Math.abs(bb.width - target.w)).toBeLessThan(55);
});

test("autosave restores the diagram after a reload", async ({ page }) => {
  await drawStroke(page, rectPts(380, 240, 180, 120));
  await expect(page.locator(".node rect.node__shape")).toHaveCount(1);

  await page.waitForTimeout(1100); // let the 800ms debounced autosave flush
  await page.reload();
  await expect(page.locator(".canvas")).toBeVisible();
  await expect(page.locator(".node rect.node__shape")).toHaveCount(1);
});

test("Save downloads a valid JSON doc and Open restores it", async ({ page }) => {
  await page.getByRole("button", { name: /Sample/ }).click();
  await expect(page.locator(".node__shape")).toHaveCount(6);

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTitle(/Save diagram as JSON/).click(),
  ]);
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(c as Buffer);
  const json = Buffer.concat(chunks).toString("utf8");

  const parsed = JSON.parse(json);
  expect(parsed.v).toBe(3);
  expect(Array.isArray(parsed.doc.nodes)).toBeTruthy();
  expect(parsed.doc.nodes.length).toBe(7); // 6 shapes + 1 text box

  await page.getByTitle("Clear canvas").click();
  await expect(page.locator(".node__shape")).toHaveCount(0);

  await page.setInputFiles('input[type="file"]', {
    name: "plexus.json",
    mimeType: "application/json",
    buffer: Buffer.from(json, "utf8"),
  });
  await expect(page.locator(".node__shape")).toHaveCount(6);
  await expect(page.locator(".node--text")).toHaveCount(1);
});

test("redo restores a node that was undone", async ({ page }) => {
  await drawStroke(page, rectPts(360, 220, 180, 120));
  await expect(page.locator(".node rect.node__shape")).toHaveCount(1);

  await page.keyboard.press(`${MOD}+z`); // undo
  await expect(page.locator(".node rect.node__shape")).toHaveCount(0);

  await page.keyboard.press(`${MOD}+Shift+z`); // redo
  await expect(page.locator(".node rect.node__shape")).toHaveCount(1);
});

test("falls back to mouse when camera permission is denied", async ({ page, context }) => {
  await context.addInitScript(() => {
    const reject = () => Promise.reject(new DOMException("denied", "NotAllowedError"));
    if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = reject as never;
  });
  await page.reload();

  await page.getByRole("button", { name: /Enable hand tracking/ }).click();
  await expect(page.locator(".camera__note--warn")).toBeVisible();
  await expect(page.locator(".camera__stage")).toBeHidden();

  // Drawing must still work with the camera denied.
  await drawStroke(page, rectPts(360, 220, 180, 120));
  await expect(page.locator(".node rect.node__shape")).toHaveCount(1);
});

test("initializes hand tracking with a fake camera without crashing", async ({ page, context }) => {
  await context.grantPermissions(["camera"]);
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));

  await page.getByRole("button", { name: /Enable hand tracking/ }).click();

  // With no real network to the model CDN this may reach "running" (preview
  // visible) or a handled error note — both are graceful. A real pinch gesture
  // cannot be simulated headlessly, so we assert no crash rather than a stroke.
  await expect(async () => {
    const running = await page.locator(".camera__stage").isVisible();
    const note = await page.locator(".camera__note--warn").isVisible();
    expect(running || note).toBeTruthy();
  }).toPass({ timeout: 30_000 });

  expect(pageErrors).toEqual([]);
});

// ---------------------------------------------------------------------------
// v3: write mode, new shapes, guided tour, command palette, dark mode
// ---------------------------------------------------------------------------

test("write mode: hand-written strokes become typed text (H, then HI)", async ({ page }) => {
  await page.keyboard.press("w");
  await expect(page.locator(".status")).toContainText("WRITE");

  // H — two verticals and a crossbar (stroke order deliberately human).
  await drawStroke(page, [{ x: 500, y: 260 }, { x: 500, y: 350 }]);
  await drawStroke(page, [{ x: 570, y: 260 }, { x: 570, y: 350 }]);
  await drawStroke(page, [{ x: 500, y: 305 }, { x: 570, y: 305 }]);
  // The 650ms pen-up pause commits the glyph.
  await expect(page.locator(".node--text .node__label")).toHaveText("H", { timeout: 3000 });

  // I — a single vertical close enough to append, not to start a new word.
  await drawStroke(page, [{ x: 605, y: 260 }, { x: 605, y: 350 }]);
  await expect(page.locator(".node--text .node__label")).toHaveText("HI", { timeout: 3000 });
});

test("write mode rejects a scribble with a HUD hint instead of typing junk", async ({ page }) => {
  await page.keyboard.press("w");
  const pts: Pt[] = [];
  for (let i = 0; i <= 40; i++) {
    const t = i / 40;
    pts.push({ x: 480 + t * 120 + 40 * Math.sin(t * 29), y: 300 + 50 * Math.sin(t * 23) });
  }
  await drawStroke(page, pts);
  await expect(page.locator(".hud__value")).toHaveText("NOT A LETTER", { timeout: 3000 });
  await expect(page.locator(".node--text")).toHaveCount(0);
});

test("palette inserts triangle, hexagon, parallelogram, and cylinder", async ({ page }) => {
  await page.getByTitle(/Insert triangle/).click();
  await page.getByTitle(/Insert hexagon/).click();
  await page.getByTitle(/Insert parallelogram/).click();
  await page.getByTitle(/Insert cylinder/).click();
  await expect(page.locator(".node--triangle polygon.node__shape")).toHaveCount(1);
  await expect(page.locator(".node--hexagon polygon.node__shape")).toHaveCount(1);
  await expect(page.locator(".node--parallelogram polygon.node__shape")).toHaveCount(1);
  await expect(page.locator(".node--cylinder path.node__shape")).toHaveCount(1);
  await expect(page.locator(".node--cylinder .node__lid")).toHaveCount(1);
});

test("drawing a triangle recognizes it as a triangle node", async ({ page }) => {
  const pts: Pt[] = [];
  const verts = [
    { x: 560, y: 200 },
    { x: 700, y: 420 },
    { x: 420, y: 420 },
  ];
  for (let e = 0; e < 3; e++) {
    const a = verts[e]!;
    const b = verts[(e + 1) % 3]!;
    for (let i = 0; i < 12; i++) {
      pts.push({ x: a.x + ((b.x - a.x) * i) / 12, y: a.y + ((b.y - a.y) * i) / 12 });
    }
  }
  pts.push({ x: verts[0]!.x + 4, y: verts[0]!.y + 4 });
  await drawStroke(page, pts);
  await expect(page.locator(".node--triangle polygon.node__shape")).toHaveCount(1);
});

test("first-run guided tour advances on a real draw, and skip persists", async ({ browser }) => {
  // A genuinely fresh context: no seeded storage, so this IS the first run.
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto("/");
  await expect(page.locator(".canvas")).toBeVisible();

  // Welcome card, then start.
  const card = page.locator(".tour-card");
  await expect(card).toBeVisible();
  await page.getByRole("button", { name: "Start the tour" }).click();
  await expect(card).toContainText("Draw a box");

  // Doing the action for real advances the tour by itself.
  await drawStroke(page, rectPts(500, 240, 190, 130));
  await expect(card).toContainText("Link two shapes", { timeout: 4000 });

  await page.getByRole("button", { name: "End tour" }).click();
  await expect(card).toHaveCount(0);

  // "Done" persisted: a reload keeps the tour away.
  await page.reload();
  await expect(page.locator(".canvas")).toBeVisible();
  await expect(page.locator(".tour-card")).toHaveCount(0);
  await ctx.close();
});

test("⌘K command palette fuzzy-runs an action", async ({ page }) => {
  await page.keyboard.press(`${MOD}+k`);
  const input = page.locator(".palette__input");
  await expect(input).toBeVisible();
  await input.fill("insert rect");
  await page.keyboard.press("Enter");
  await expect(page.locator(".palette")).toHaveCount(0);
  await expect(page.locator(".node rect.node__shape")).toHaveCount(1);

  // Esc closes without running anything.
  await page.keyboard.press(`${MOD}+k`);
  await page.keyboard.press("Escape");
  await expect(page.locator(".palette")).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// v4: voice commands
//
// Driven through the panel's text box rather than a microphone: it runs the
// exact same parse → plan → commit pipeline that speech does, so these cover
// the real code path without needing audio in CI.
// ---------------------------------------------------------------------------

test("a typed voice command builds a labelled graph as one undo step", async ({ page }) => {
  const input = page.getByTestId("voice-input");
  await input.fill("connect intake to review to ship");
  await input.press("Enter");

  await expect(page.locator(".node rect.node__shape")).toHaveCount(3);
  await expect(page.locator(".node__label")).toHaveText(["Intake", "Review", "Ship"]);
  await expect(page.locator(".edge__line")).toHaveCount(2);

  // The whole utterance is a single history entry.
  await input.blur();
  await page.keyboard.press(`${MOD}+z`);
  await expect(page.locator(".node rect.node__shape")).toHaveCount(0);
});

test("voice keeps editing the node it just created", async ({ page }) => {
  const input = page.getByTestId("voice-input");
  await input.fill("add a database called store");
  await input.press("Enter");
  await expect(page.locator(".node--cylinder path.node__shape")).toHaveCount(1);

  await input.fill("make it orange");
  await input.press("Enter");
  await expect(page.locator(".node--cylinder path.node__shape")).toHaveAttribute("fill", "#fdf2e7");

  await input.fill("rename store to archive");
  await input.press("Enter");
  await expect(page.locator(".node__label")).toHaveText("Archive");
});

test("voice drives app control as well as the document", async ({ page }) => {
  const input = page.getByTestId("voice-input");
  await input.fill("load the sample");
  await input.press("Enter");
  await expect(page.locator(".node__shape")).toHaveCount(6);

  await input.fill("dark mode");
  await input.press("Enter");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

  await input.fill("tidy up");
  await input.press("Enter");
  await expect(page.locator(".hud__value")).toHaveText("TIDIED THE LAYOUT");
  await expect(page.locator(".node__shape")).toHaveCount(6); // rearranged, not lost
});

test("a phrase the parser does not know is reported, not guessed at", async ({ page }) => {
  const input = page.getByTestId("voice-input");
  await input.fill("summon a unicorn");
  await input.press("Enter");

  await expect(page.locator(".voice__detail")).toHaveText("not understood");
  await expect(page.locator(".node__shape")).toHaveCount(0);
});

test("the voice panel stays usable without speech recognition", async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>;
    delete w.SpeechRecognition;
    delete w.webkitSpeechRecognition;
  });
  await page.reload();
  await expect(page.locator(".canvas")).toBeVisible();

  await expect(page.locator(".voice__note")).toContainText("no speech recognition");
  const input = page.getByTestId("voice-input");
  await input.fill("add a decision called pass");
  await input.press("Enter");
  await expect(page.locator(".node--diamond polygon.node__shape")).toHaveCount(1);
});

test("theme toggle flips to dark and survives a reload", async ({ page }) => {
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.locator(".theme-toggle").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

  await page.reload();
  await expect(page.locator(".canvas")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});
