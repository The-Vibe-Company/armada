// One API snapshot, never a polling loop. Include queue/setup and aggregate gates.
const fs = require("node:fs");
const run = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const jobs = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
const required = jobs.filter((job) => job.name !== "CI budget (120s)" && job.name !== "Binary (darwin-x64)");
const failures = [];
for (const job of required) {
  if (job.conclusion !== "success") failures.push(`${job.name}: ${job.conclusion || job.status}`);
  if (job.completed_at) {
    const seconds = (Date.parse(job.completed_at) - Date.parse(run.run_started_at)) / 1000;
    if (seconds > 120) failures.push(`${job.name}: verdict after ${seconds}s`);
  }
}
const elapsed = (Date.now() - Date.parse(run.run_started_at)) / 1000;
if (!required.length || !Number.isFinite(elapsed) || elapsed > 120) {
  failures.push(`Workflow verdict took ${elapsed.toFixed(1)}s (limit 120s)`);
}
const report = failures.length
  ? `## CI budget failed\n\n${failures.map((failure) => `- ${failure}`).join("\n")}\n\nAuthor: reduce the critical path; do not raise the budget or weaken tests.\n`
  : `## CI budget passed\n\nVerdict at ${elapsed.toFixed(1)}s of 120s.\n`;
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, report);
console.log(report);
if (failures.length) process.exitCode = 1;
