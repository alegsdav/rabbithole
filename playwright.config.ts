import { defineConfig, devices } from "@playwright/test";

/**
 * Cross-engine smoke tests against the seeded demo database (scripts/dev-seed.ts),
 * served by a production build on port 3101. Run: npm run e2e
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 45_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: { baseURL: "http://localhost:3101" },
  webServer: {
    command: "npx next build && DATABASE_PATH=./data/demo.db npx next start -p 3101",
    url: "http://localhost:3101",
    reuseExistingServer: true,
    timeout: 240_000,
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "chrome", use: { ...devices["Desktop Chrome"], channel: "chrome" } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
    { name: "mobile-safari", use: { ...devices["iPhone 15"] } },
  ],
});
