// Test support: a fake `fetch` that replays recorded Linear and GitHub
// responses (no network), and a builder for normalized issues.

import { parseConfig } from "../src/config.ts";
import { GITHUB_GRAPHQL } from "../src/github.ts";
import { type Fetch, LINEAR_ENDPOINT } from "../src/linear.ts";
import type { Issue } from "../src/types.ts";
import githubPulls from "./fixtures/github-pulls.json";
import linearProgram from "./fixtures/linear-program.json";

export const NOW = new Date("2026-03-04T10:00:00.000Z");

export const DEMO_TOML = `
[project]
name = "Widgets"
slug = "widgets"

[tracker]
program_root = "DEMO-1"

[github]
repository = "acme/widgets"
`;

export const demoConfig = () => parseConfig(DEMO_TOML);

export interface Call {
  url: string;
  operation: string;
  variables: Record<string, unknown>;
  authorization: string | null;
}

/** Replays the recorded responses in order, per GraphQL operation name. */
export function recordedFetch(
  overrides: { github?: unknown; linear?: (recorded: typeof linearProgram) => void } = {},
): { fetch: Fetch; calls: Call[] } {
  const recorded = structuredClone(linearProgram);
  overrides.linear?.(recorded);
  const queues: Record<string, unknown[]> = Object.fromEntries(
    Object.entries(recorded).map(([op, responses]) => [op, [...responses]]),
  );
  const calls: Call[] = [];
  const fetch: Fetch = async (url, init) => {
    const body = JSON.parse(String(init.body)) as { query: string; variables: Record<string, unknown> };
    const operation = body.query.match(/query\s+(\w+)/)?.[1] ?? "?";
    const authorization = new Headers(init.headers).get("Authorization");
    calls.push({ url, operation, variables: body.variables, authorization });
    if (url === GITHUB_GRAPHQL) return Response.json(overrides.github ?? githubPulls);
    if (url !== LINEAR_ENDPOINT) throw new Error(`unexpected URL ${url}`);
    const next = queues[operation]?.shift();
    if (!next) throw new Error(`no recorded response left for ${operation}`);
    return Response.json(next);
  };
  return { fetch, calls };
}

let seq = 0;
export function issue(id: string, over: Partial<Issue> = {}): Issue {
  return {
    id,
    uuid: `uuid-${++seq}`,
    title: id,
    url: `https://linear.app/acme/issue/${id}`,
    status: "Backlog",
    statusType: "backlog",
    assignee: null,
    delegate: null,
    labels: [],
    parentId: null,
    createdAt: "2026-03-01T09:00:00.000Z",
    updatedAt: "2026-03-01T09:00:00.000Z",
    startedAt: null,
    completedAt: null,
    canceledAt: null,
    agentPhase: null,
    agentRuntime: null,
    blockedBy: [],
    prs: [],
    ...over,
  };
}
