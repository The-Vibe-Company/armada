/** Local fixture-only dashboard. Never point this command at a real Armada deployment. */
const dashboardPort = 3100;
const mockPort = 54399;
const mockUrl = `http://127.0.0.1:${mockPort}`;
const env = {
  ...process.env,
  NEXT_PUBLIC_SUPABASE_URL: mockUrl,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "e2e-anon-key",
  NEXT_PUBLIC_AUTH_PROVIDERS: "",
  ARMADA_MCP_URL: `${mockUrl}/mcp`,
  ARMADA_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  ARMADA_DATABASE_URL: "",
  STATS_TOKEN: "",
  GITHUB_APP_CLIENT_ID: "Iv1.e2e",
  GITHUB_APP_CLIENT_SECRET: "e2e-client-secret",
  GITHUB_APP_SLUG: "armada-tvc",
  GITHUB_APP_ID: "8675309",
  MOCK_PORT: String(mockPort),
  DASHBOARD_ORIGIN: `http://127.0.0.1:${dashboardPort}`,
  NODE_OPTIONS: "--require=./e2e/github-fetch.cjs",
};

// Refuse occupied ports rather than silently reusing an unrelated server.
for (const port of [mockPort, dashboardPort]) {
  try {
    const probe = Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } });
    probe.stop(true);
  } catch {
    console.error(`Port ${port} is occupied. Stop the existing process before running bun run dev.`);
    process.exit(1);
  }
}
const children = [
  Bun.spawn(["bun", "e2e/mock-supabase.ts"], { cwd: "apps/dashboard", env, stdout: "inherit", stderr: "inherit" }),
  Bun.spawn(["bun", "--bun", "next", "dev", "-p", String(dashboardPort), "-H", "127.0.0.1"], {
    cwd: "apps/dashboard",
    env,
    stdout: "inherit",
    stderr: "inherit",
  }),
];
const stop = () => {
  for (const child of children) child.kill();
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
console.log(
  "Fixture-only dashboard on port 3100. Sign in as alice@example.com with code 123456. No real sandboxes are launched.",
);
try {
  const first = await Promise.race(children.map((child) => child.exited));
  process.exitCode = first;
} finally {
  stop();
  await Promise.all(children.map((child) => child.exited));
}
