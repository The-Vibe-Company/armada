import { defineConfig, devices } from "@playwright/test";

const APP_PORT = 3100;
const MOCK_PORT = 54399;
const MOCK_URL = `http://127.0.0.1:${MOCK_PORT}`;

// The app runs a production build against a mock of Supabase and the Armada server (e2e/mock-supabase.ts).
const env = {
  NEXT_PUBLIC_SUPABASE_URL: MOCK_URL,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "e2e-anon-key",
  NEXT_PUBLIC_AUTH_PROVIDERS: "github,google",
  ARMADA_MCP_URL: `${MOCK_URL}/mcp`,
  // 32 zero bytes: a throwaway key for the tests only.
  ARMADA_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  GITHUB_APP_CLIENT_ID: "Iv1.e2e",
  GITHUB_APP_CLIENT_SECRET: "e2e-client-secret",
  GITHUB_APP_SLUG: "armada-tvc",
  GITHUB_APP_ID: "8675309",
  MOCK_PORT: String(MOCK_PORT),
  DASHBOARD_ORIGIN: `http://127.0.0.1:${APP_PORT}`,
};

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.e2e.ts",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  timeout: 30_000,
  expect: { timeout: 8_000 },
  use: {
    baseURL: `http://127.0.0.1:${APP_PORT}`,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "bun e2e/mock-supabase.ts",
      url: `${MOCK_URL}/health`,
      env,
      reuseExistingServer: !process.env.CI,
    },
    {
      command: `bunx next build && NODE_OPTIONS=--require=./e2e/github-fetch.cjs bunx next start -p ${APP_PORT} -H 127.0.0.1`,
      url: `http://127.0.0.1:${APP_PORT}/login`,
      env,
      timeout: 240_000,
      reuseExistingServer: !process.env.CI,
    },
  ],
});
