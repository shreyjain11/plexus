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
