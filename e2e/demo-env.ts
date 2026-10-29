// Throwaway demo values only. Model secrets never reach the dashboard child.
export const demoEnv = {
  NEXT_TELEMETRY_DISABLED: "1",
  NODE_ENV: "test",
  ARMADA_DATABASE_URL:
    process.env.ARMADA_DEMO_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/armada?sslmode=disable",
  ARMADA_DASHBOARD_DEMO: "fleet",
  ARMADA_AUTH_URL: "http://localhost:4822",
  ARMADA_AUTH_OWNER_EMAILS: "olive.owner@example.test",
  ARMADA_AUTH_SECRET: process.env.ARMADA_AUTH_SECRET ?? "e2e-throwaway-demo-session-signing-key",
  ARMADA_AUTH_EMAIL_PASSWORD: "on",
  ARMADA_AUTH_GITHUB_CLIENT_ID: "a11y-demo",
  ARMADA_AUTH_GITHUB_CLIENT_SECRET: "a11y-demo",
};
