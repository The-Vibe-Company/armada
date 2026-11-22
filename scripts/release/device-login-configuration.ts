const serverRequired = ["ARMADA_CLI_CONSENT_KEY", "ARMADA_CLI_OAUTH_CLIENT_ID", "ARMADA_CLI_OAUTH_CLIENT_SECRET"];
const dashboardRequired = ["ARMADA_CLI_CONSENT_KEY"];

export function missingDeviceLoginConfiguration(railway: unknown, vercel: unknown) {
  if (!railway || typeof railway !== "object" || Array.isArray(railway))
    throw new Error("Could not read Railway server configuration.");
  if (!vercel || typeof vercel !== "object" || !("envs" in vercel) || !Array.isArray(vercel.envs))
    throw new Error("Could not read Vercel dashboard configuration.");

  const dashboard = vercel.envs;
  const server = railway as Record<string, unknown>;
  const missingServer = serverRequired.filter((name) => !Object.hasOwn(server, name) || server[name] === "");
  const missingDashboard = dashboardRequired.filter(
    (name) => !dashboard.some((entry) => entry?.key === name && [entry.target].flat().includes("production")),
  );
  return [
    ...missingServer.map((name) => `Railway server: ${name}`),
    ...missingDashboard.map((name) => `Vercel dashboard: ${name}`),
  ];
}

async function readDashboardConfiguration() {
  const { VERCEL_PROJECT_ID, VERCEL_ORG_ID, VERCEL_TOKEN } = process.env;
  if (!VERCEL_PROJECT_ID || !VERCEL_ORG_ID || !VERCEL_TOKEN)
    throw new Error("Missing Vercel connection configuration.");
  const url = new URL(`https://api.vercel.com/v10/projects/${encodeURIComponent(VERCEL_PROJECT_ID)}/env`);
  if (VERCEL_ORG_ID.startsWith("team_")) url.searchParams.set("teamId", VERCEL_ORG_ID);
  url.searchParams.set("decrypt", "false");
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${VERCEL_TOKEN}` },
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error("Could not list Vercel dashboard variables.");
  return response.json();
}

if (import.meta.main) {
  try {
    const railway: unknown = await Bun.stdin.json();
    const vercel: unknown = await readDashboardConfiguration();
    const missing = missingDeviceLoginConfiguration(railway, vercel);
    for (const setting of missing) console.error(`::error::Missing CLI device login configuration (${setting})`);
    if (missing.length) process.exitCode = 1;
  } catch {
    console.error("::error::Could not read CLI device login configuration from Railway or Vercel.");
    process.exitCode = 1;
  }
}
