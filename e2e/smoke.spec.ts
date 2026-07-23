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
  await expect(page.locator(".node__shape")).toHaveCount(4);

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

  // Confirm it actually parses/renders as a standalone document.
  await page.goto("data:image/svg+xml," + encodeURIComponent(svg));
  await expect(page.locator("ellipse")).toHaveCount(2);
  await expect(page.locator("line")).toHaveCount(4);
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
  await expect(page.locator(".label-editor")).toBeVisible();
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
  await expect(page.locator(".node__shape")).toHaveCount(4);

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTitle(/Save diagram as JSON/).click(),
  ]);
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(c as Buffer);
  const json = Buffer.concat(chunks).toString("utf8");

  const parsed = JSON.parse(json);
  expect(parsed.v).toBe(2);
  expect(Array.isArray(parsed.doc.nodes)).toBeTruthy();
  expect(parsed.doc.nodes.length).toBe(5); // 4 shapes + 1 text box

  await page.getByTitle("Clear canvas").click();
  await expect(page.locator(".node__shape")).toHaveCount(0);

  await page.setInputFiles('input[type="file"]', {
    name: "plexus.json",
    mimeType: "application/json",
    buffer: Buffer.from(json, "utf8"),
  });
  await expect(page.locator(".node__shape")).toHaveCount(4);
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
