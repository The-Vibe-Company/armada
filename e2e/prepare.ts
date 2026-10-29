// Local equivalent of .github/actions/dashboard-demo, on a throwaway Postgres database.
import { demoEnv } from "./demo-env";

for (const command of ["build", "demo:seed", "a11y"]) {
  const child = Bun.spawn(["bun", "run", command, ...(command === "a11y" ? ["seed"] : [])], {
    cwd: new URL("../packages/dashboard", import.meta.url).pathname,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      ...demoEnv,
      NODE_ENV: command === "build" ? "production" : "test",
      ARMADA_DEMO_DATABASE_URL: demoEnv.ARMADA_DATABASE_URL,
    },
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await child.exited) !== 0) process.exit(1);
}
