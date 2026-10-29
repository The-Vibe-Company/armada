import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { web } from "@e2e-dev/web";
import type { E2EConfig } from "e2e";
import { demoEnv } from "./e2e/demo-env";
import { replayOnly } from "./e2e/replay-only";

const endpoint = process.env.AZURE_AI_ENDPOINT;
if (endpoint && (!process.env.AZURE_AI_API_KEY || !process.env.AZURE_AI_MODEL)) {
  throw new Error("AZURE_AI_ENDPOINT requires AZURE_AI_API_KEY and AZURE_AI_MODEL; run through armada run.");
}
const deployment = endpoint
  ? createOpenAICompatible({
      name: "azure-foundry",
      baseURL: endpoint,
      apiKey: process.env.AZURE_AI_API_KEY,
      supportsStructuredOutputs: true,
    }).chatModel(process.env.AZURE_AI_MODEL as string)
  : undefined;
// e2e includes modelId in run metadata before applying its secret redactor.
// Bind transport methods to the real deployment while exposing a public label.
const model =
  deployment &&
  new Proxy(deployment, {
    get(target, key) {
      if (key === "modelId") return "foundry-dashboard-agent";
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

export default {
  projectId: "armada-dashboard",
  tests: "e2e/tests/**/*.e2e.ts",
  workers: 1,
  retries: 1,
  failOnSkippedFailure: true,
  cache: { ...(endpoint ? {} : { mode: "read-only", strict: true }) },
  agents: { default: model ? { model } : { executor: replayOnly } },
  // Register vault values for e2e's log/report/cache redactor, including model provenance.
  secrets: Object.fromEntries(
    ["AZURE_AI_ENDPOINT", "AZURE_AI_API_KEY", "AZURE_AI_MODEL"].flatMap((name) =>
      process.env[name] ? [[name, process.env[name]]] : [],
    ),
  ),
  credentials: {
    // Public throwaway identity created by packages/dashboard/scripts/a11y.ts.
    owner: { username: "olive.owner@example.test", password: "a11y-demo-password" },
  },
  targets: [
    {
      name: "dashboard",
      engine: web({ viewport: { width: 1440, height: 900 } }),
      app: {
        url: "http://localhost:4822",
        readyUrl: "http://localhost:4822/landing",
        command: {
          executable: "bun",
          args: ["run", "start"],
          cwd: "packages/dashboard",
          env: demoEnv,
          // A built demo with the real email sign-in form enabled; production hides it.
          inheritEnv: [],
          log: ".e2e/logs/dashboard.log",
        },
      },
    },
  ],
} satisfies E2EConfig;
