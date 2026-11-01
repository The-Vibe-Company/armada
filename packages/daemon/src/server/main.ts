#!/usr/bin/env node
const startedAt = performance.now();
console.log(JSON.stringify({ starting: true }));
try {
  const { runDaemon } = await import("./run.ts");
  await runDaemon(startedAt);
} catch {
  console.error("armadad: could not load the daemon");
  process.exitCode = 1;
}

export {};
