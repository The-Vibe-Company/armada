// One snapshot: required queue/setup and aggregate verdict, never this diagnostic's own queue.
const fs = require("node:fs");
const run = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const jobs = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
// The required verdict and its prerequisites, not arbitrary informational jobs.
const names = new Set([
  "Classify expensive checks",
  "Migration versions",
  "Lint and typecheck",
  "Native runtime contracts",
  "Golden PostgreSQL concurrency",
  "Golden OS recipe (actual provider image)",
  "Binary (linux-x64)",
  "Binary (linux-arm64)",
  "Binary (darwin-arm64)",
  "Lint, typecheck and test",
]);
const required = jobs.filter((job) => names.has(job.name) || /^Unit tests \(\d+\/\d+\)$/.test(job.name));
const failures = [];
for (const job of required) {
  if (job.conclusion !== "success") failures.push(`${job.name}: ${job.conclusion || job.status}`);
  if (!job.completed_at) failures.push(`${job.name}: missing completion time`);
  if (job.completed_at) {
    const seconds = (Date.parse(job.completed_at) - Date.parse(run.run_started_at)) / 1000;
    if (seconds > 120) failures.push(`${job.name}: verdict after ${seconds}s`);
  }
}
// This separate job may wait for a runner: its own clock is not admission latency.
const elapsed =
  (Math.max(...required.map((job) => Date.parse(job.completed_at))) - Date.parse(run.run_started_at)) / 1000;
if (!required.length || !Number.isFinite(elapsed) || elapsed > 120) {
  failures.push(`Required path verdict took ${elapsed.toFixed(1)}s (limit 120s)`);
}
const report = failures.length
  ? `## CI budget failed\n\n${failures.map((failure) => `- ${failure}`).join("\n")}\n\nNon-required timing diagnostic; code verification is reported separately.\n`
  : `## CI budget passed\n\nVerdict at ${elapsed.toFixed(1)}s of 120s.\n`;
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, report);
console.log(report);
if (failures.length) process.exitCode = 1;
