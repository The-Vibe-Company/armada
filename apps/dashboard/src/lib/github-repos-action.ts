"use server";

import type { GitHubReposRequest } from "@armada/core/contract";
import { ControlError, createControlClient } from "@/lib/control";
import { readViewer } from "@/lib/data/viewer";
import { mcpUrl } from "@/lib/env";
import { classifyGitHubReposFailure, fetchGitHubReposWith } from "@/lib/github-repos";

export async function listGitHubRepos(input?: GitHubReposRequest) {
  const viewer = await readViewer();
  if (!viewer?.token) return classifyGitHubReposFailure(401, "unauthorized");
  const serverUrl = mcpUrl();
  if (!serverUrl) return classifyGitHubReposFailure(503, "unavailable");
  const control = createControlClient({ serverUrl, token: viewer.token, timeoutMs: 25_000 });
  try {
    return await fetchGitHubReposWith((route, body) => control.post<unknown>(route, body), input);
  } catch (error) {
    return error instanceof ControlError
      ? classifyGitHubReposFailure(error.status, error.code, error.message)
      : classifyGitHubReposFailure(503, "unavailable");
  }
}
