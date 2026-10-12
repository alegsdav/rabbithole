import { readFileSync } from "node:fs";

import { expect, test, type Page } from "@playwright/test";

const token = readFileSync("data/demo-session.txt", "utf8").split("SESSION_TOKEN=")[1]?.trim() ?? "";

async function signInAsDemo(page: Page) {
  await page.context().addCookies([{ name: "authjs.session-token", value: token, domain: "localhost", path: "/", httpOnly: true, sameSite: "Lax" }]);
}

function collectProblems(page: Page): string[] {
  const problems: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") problems.push(msg.text());
  });
  page.on("pageerror", (err) => problems.push(err.message));
  return problems;
}

test("landing page offers Google sign-in", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Sign in with Google" })).toBeVisible();
});

test("home renders lanes from cache, scrolls, and plays a video in a modal", async ({ page, isMobile }) => {
  const problems = collectProblems(page);
  await signInAsDemo(page);
  const started = Date.now();
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Software Architecture" })).toBeVisible();
  expect(Date.now() - started).toBeLessThan(3000);

  const grid = page.getByRole("region", { name: "Software Architecture videos" });
  await expect(grid.locator("[data-card]").first()).toBeVisible();
  // Two rows, laid out in columns.
  expect(await grid.evaluate((el) => getComputedStyle(el).gridTemplateRows.split(" ").length)).toBe(2);
  expect(await grid.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);

  // Keyboard: arrow keys move along the row.
  await grid.locator("[data-card]").first().focus();
  await page.keyboard.press("ArrowRight");
  expect(await grid.evaluate((el) => [...el.querySelectorAll("[data-card]")].indexOf(document.activeElement as Element))).toBe(2);

  if (!isMobile) {
    await grid.hover();
    await page.getByRole("button", { name: "Scroll Software Architecture right" }).click();
    await expect.poll(() => grid.evaluate((el) => el.scrollLeft)).toBeGreaterThan(200);
  }

  await grid.getByRole("button", { name: /Big Buck Bunny 60fps/ }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('iframe[src*="youtube.com/embed/aqz-KE-bpKQ"]')).toBeAttached({ timeout: 15_000 });
  await expect(dialog.getByRole("link", { name: /Open on YouTube/ })).toHaveAttribute("href", "https://www.youtube.com/watch?v=aqz-KE-bpKQ");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  // No CSP violations or script errors from our own page. The YouTube embed probes
  // browser features (e.g. compute-pressure) the page doesn't grant; those notices are its own.
  expect(problems.filter((p) => !/youtube|googlevideo|doubleclick|ytimg|google\.com|^Permissions policy violation/i.test(p))).toEqual([]);
});

test("settings shows quota and the disconnect control", async ({ page }) => {
  await signInAsDemo(page);
  await page.goto("/settings");
  await expect(page.getByRole("meter", { name: "Quota used today" })).toBeAttached();
  await expect(page.getByRole("button", { name: "Disconnect and delete my data" })).toBeVisible();
});

test("API refuses cross-site and unauthenticated requests", async ({ request }) => {
  const cross = await request.post("/api/lanes", { data: { name: "x" }, headers: { origin: "https://evil.example", "x-rabbithole": "1" } });
  expect(cross.status()).toBe(403);
  const anon = await request.post("/api/lanes", { data: { name: "x" }, headers: { origin: "http://localhost:3101", "x-rabbithole": "1" } });
  expect(anon.status()).toBe(401);
});
