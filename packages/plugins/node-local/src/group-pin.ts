/** Standalone JavaScript for a detached process that pins the worker group. */
export const groupPinScript = String.raw`(() => {
  const { spawn } = require("node:child_process");
  const fs = require("node:fs");

  let input = "";
  let config;
  let child;
  let cliClosed = false;
  let cliStarted = false;
  let cliFailure = false;
  let commandBuffer = "";
  let controlQueue = Promise.resolve();
  const deliveries = new Map();
  let resolveStarted;
  const started = new Promise((resolve) => { resolveStarted = resolve; });

  // This process is the worker process group's live leader. A group SIGTERM
  // reaches the CLI and its descendants, while the pin waits for SIGKILL.
  process.on("SIGTERM", () => {});

  function report(value) {
    try {
      fs.writeSync(3, JSON.stringify(value) + "\n");
    } catch {}
  }

  function startCli(line) {
    try {
      config = JSON.parse(line);
      child = spawn(config.command, config.args, {
        cwd: config.cwd,
        detached: false,
        env: config.env,
        shell: false,
        stdio: "pipe",
        windowsHide: true,
      });
    } catch (error) {
      cliClosed = true;
      cliFailure = true;
      resolveStarted(false);
      report({ type: "launch-error", message: error instanceof Error ? error.message : String(error) });
      return;
    }

    child.stdout.pipe(process.stdout);
    child.stderr.pipe(process.stderr);
    child.stdin.on("error", (error) => {
      cliFailure = true;
      report({ type: "cli-input-error", message: error.message });
    });
    child.once("spawn", () => {
      cliStarted = true;
      report({ type: "started" });
      resolveStarted(true);
    });
    child.once("error", (error) => {
      if (!cliStarted) {
        cliClosed = true;
        cliFailure = true;
        report({ type: "launch-error", message: error.message });
        resolveStarted(false);
      }
    });
    child.once("close", (code, signal) => {
      cliClosed = true;
      if (cliFailure) report({ type: "protocol-error", error: "worker input failed" });
      report({ type: "cli-close", code, signal });
    });
  }

  function queueCommand(request) {
    const previous = controlQueue;
    let release;
    controlQueue = new Promise((resolve) => { release = resolve; });
    return previous.then(async () => {
      await started;
      if (request.type !== "deliver") return;
      if (typeof request.id !== "string" || typeof request.key !== "string" || typeof request.message !== "string") {
        report({ type: "delivery-ack", id: request.id, ok: false, error: "invalid delivery request" });
        return;
      }
      const previousMessage = deliveries.get(request.key);
      if (previousMessage !== undefined) {
        report({
          type: "delivery-ack",
          id: request.id,
          ok: previousMessage === request.message,
          duplicate: previousMessage === request.message,
          error: previousMessage === request.message ? undefined : "delivery key was reused with a different message",
        });
        return;
      }
      if (cliClosed || !child || !child.stdin.writable) {
        report({ type: "delivery-ack", id: request.id, ok: false, error: "worker input is closed" });
        return;
      }
      await new Promise((resolve, reject) => {
        child.stdin.write(request.message + "\n", (error) => error ? reject(error) : resolve());
      }).then(() => {
        deliveries.set(request.key, request.message);
        report({ type: "delivery-ack", id: request.id, ok: true });
      }, (error) => {
        cliFailure = true;
        report({ type: "delivery-ack", id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) });
      });
    }).finally(release);
  }

  function receiveCommands(text) {
    commandBuffer += text;
    while (true) {
      const newline = commandBuffer.indexOf("\n");
      if (newline < 0) return;
      const line = commandBuffer.slice(0, newline);
      commandBuffer = commandBuffer.slice(newline + 1);
      if (!line) continue;
      let request;
      try {
        request = JSON.parse(line);
      } catch {
        report({ type: "protocol-error", error: "invalid pin request" });
        continue;
      }
      queueCommand(request).catch((error) => {
        report({
          type: "delivery-ack",
          id: request.id,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
  }

  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    if (config) {
      receiveCommands(chunk);
      return;
    }
    input += chunk;
    const newline = input.indexOf("\n");
    if (newline < 0) return;
    const line = input.slice(0, newline);
    const remainder = input.slice(newline + 1);
    input = "";
    startCli(line);
    if (remainder) receiveCommands(remainder);
  });
  process.stdin.on("end", () => {
    if (child && child.stdin && !child.stdin.destroyed) child.stdin.end();
  });
})();`;
