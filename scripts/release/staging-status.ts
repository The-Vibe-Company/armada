const context = "staging/smoke";
const title = "staging red";
const historyLimit = 50;

interface CommitStatus {
  context: string;
  state: string;
}

export async function findLastGreen(
  commits: readonly string[],
  statuses: (sha: string) => AsyncIterable<CommitStatus>,
) {
  for (const sha of commits.slice(0, historyLimit)) {
    for await (const status of statuses(sha)) {
      if (status.context !== context) continue;
      if (status.state === "success") return sha;
      break;
    }
  }
}

export function stagingFailureBody(sha: string, lastGreen: string | undefined, runUrl: string, journal: string) {
  const failures = new Set<string>();
  for (const line of journal.split("\n")) {
    let row: { pass?: unknown; step?: unknown; code?: unknown } | null;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (row?.pass !== false || typeof row.step !== "string" || !/^[a-zA-Z0-9_-]{1,120}$/.test(row.step)) continue;
    const code =
      typeof row.code === "string" && /^[a-zA-Z0-9_-]{1,120}$/.test(row.code) ? row.code : "code unavailable";
    failures.add(`- \`${row.step}\` — \`${code}\``);
  }
  const range = lastGreen
    ? `\`${lastGreen}..${sha}\``
    : `\`${sha}\` (no green status found in the last 50 main commits)`;
  return [
    "Ordinary main staging smoke failed.",
    `SHA range: ${range}`,
    `Workflow: ${runUrl}`,
    "Failing smoke steps:",
    ...(failures.size ? failures : ["- No structured failure recorded. See the workflow log."]),
  ].join("\n\n");
}

if (import.meta.main) {
  const {
    GITHUB_API_URL: apiUrl,
    GITHUB_REPOSITORY: repository,
    GH_TOKEN: token,
    RELEASE_SHA: sha,
    RUN_URL: runUrl,
    SMOKE_OUTCOME: outcome,
    STAGING_HISTORY: history = "",
  } = process.env;
  if (!apiUrl || !repository || !token || !sha || !/^[a-f0-9]{40}$/.test(sha) || !runUrl) {
    throw new Error("Missing staging status context");
  }
  if (outcome !== "failure" && outcome !== "success") throw new Error("Invalid staging smoke outcome");

  async function api<T>(path: string, method = "GET", body?: object) {
    const response = await fetch(`${apiUrl}/repos/${repository}/${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: body && JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`GitHub staging status request failed: ${method} ${path} (${response.status})`);
    return (await response.json()) as T;
  }

  async function* pages<T>(path: string, filter = "") {
    for (let page = 1; ; page++) {
      const rows = await api<T[]>(`${path}?per_page=100&page=${page}${filter}`);
      yield* rows;
      if (rows.length < 100) return;
    }
  }

  async function openIssue() {
    for await (const issue of pages<{ title: string; number: number; pull_request?: object }>(
      "issues",
      "&state=open",
    )) {
      if (issue.title === title && !issue.pull_request) return issue.number;
    }
  }

  if (outcome === "success") {
    await api(`statuses/${sha}`, "POST", { state: "success", context, target_url: runUrl });
    const issue = await openIssue();
    if (issue !== undefined) {
      await api(`issues/${issue}/comments`, "POST", { body: `Staging smoke passed on \`${sha}\`. ${runUrl}` });
      await api(`issues/${issue}`, "PATCH", { state: "closed", state_reason: "completed" });
    }
  } else {
    const commits = history.split("\n").filter((commit) => /^[a-f0-9]{40}$/.test(commit));
    if (commits[0] !== sha) throw new Error("Staging history does not start at the tested SHA");
    const lastGreen = await findLastGreen(commits, (commit) => pages(`commits/${commit}/statuses`));
    const journal = (await Promise.all(process.argv.slice(2).map((path) => Bun.file(path).text()))).join("\n");
    const body = stagingFailureBody(sha, lastGreen, runUrl, journal);
    const issue = await openIssue();
    if (issue === undefined) await api("issues", "POST", { title, body });
    else await api(`issues/${issue}/comments`, "POST", { body });
  }
}
