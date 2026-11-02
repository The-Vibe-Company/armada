import { groupPinScript } from "./group-pin.ts";

/**
 * Kept as standalone JavaScript because it runs in a detached Node process.
 * The launch configuration, including the worker environment, is sent over
 * stdin and is never placed in the supervisor's argv or environment.
 */
export const supervisorScript = String.raw`(() => {
  const { spawn } = require("node:child_process");
  const crypto = require("node:crypto");
  const fs = require("node:fs");
  const net = require("node:net");
  const path = require("node:path");
  const PIN_RUNNER_SCRIPT = ${JSON.stringify(groupPinScript)};

  let input = "";
  let initialized = false;
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    if (initialized) return;
    input += chunk;
    if (input.length > 8 * 1024 * 1024) return finishInputError("local supervisor configuration is too large");
    const newline = input.indexOf("\n");
    if (newline >= 0) initialize(input.slice(0, newline));
  });
  process.stdin.on("end", () => {
    if (!initialized) initialize(input.trim());
  });

  let config;
  let server;
  let pin;
  let state = "starting";
  let output = "";
  let pendingRedaction = "";
  let startError;
  let cliFailure = false;
  let cliClosed = false;
  let stopping = false;
  let closed = false;
  let finalWrite = Promise.resolve();
  let activeConnections = 0;
  let launchAnswered = false;
  let shutdownTimer;
  let resolveStarted;
  let resolvePinClosed;
  const started = new Promise((resolve) => { resolveStarted = resolve; });
  const pinClosedPromise = new Promise((resolve) => { resolvePinClosed = resolve; });
  const deliveries = new Map();
  const pendingDeliveries = new Map();
  let controlQueue = Promise.resolve();
  let pinControlBuffer = "";
  let pinClosed = false;
  let groupTerminationConfirmed = false;
  let treeKillInProgress = false;

  function errorCode(error) {
    return error && typeof error === "object" ? error.code : undefined;
  }

  function uuid(value) {
    return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
  }

  function sameWorker(a, b) {
    return a && b && a.project === b.project && a.ticket === b.ticket && a.session === b.session &&
      a.generation === b.generation && a.handle === b.handle;
  }

  function sameWorkspace(a, b) {
    return a && b && a.id === b.id && a.path === b.path && a.node === b.node;
  }

  function appendVisible(text) {
    if (text) output = (output + text).slice(-config.outputTail);
  }

  function redact(text, flush) {
    const secret = typeof config.env.ARMADA_WORKER_TOKEN === "string" ? config.env.ARMADA_WORKER_TOKEN : "";
    if (!secret) {
      appendVisible(text);
      return;
    }
    pendingRedaction += text;
    while (pendingRedaction.length >= secret.length) {
      const found = pendingRedaction.indexOf(secret);
      if (found >= 0) {
        appendVisible(pendingRedaction.slice(0, found));
        appendVisible("[redacted]");
        pendingRedaction = pendingRedaction.slice(found + secret.length);
        continue;
      }
      break;
    }
    if (flush) {
      if (pendingRedaction) appendVisible("[redacted]");
      pendingRedaction = "";
      return;
    }
    let held = 0;
    const limit = Math.min(secret.length - 1, pendingRedaction.length);
    for (let size = limit; size > 0; size -= 1) {
      if (secret.startsWith(pendingRedaction.slice(-size))) {
        held = size;
        break;
      }
    }
    appendVisible(pendingRedaction.slice(0, pendingRedaction.length - held));
    pendingRedaction = held ? pendingRedaction.slice(-held) : "";
  }

  function observation() {
    return { state, reply: output };
  }

  async function persistFinal() {
    const temporary = config.paths.state + ".tmp-" + crypto.randomBytes(6).toString("hex");
    try {
      const metadata = {
        version: 1,
        worker: config.worker,
        workspace: config.workspace,
        provenance: config.provenance,
        // Worker output can contain prompts, message bodies and secrets. It
        // stays in supervisor memory and is never copied to durable metadata.
        observation: { state },
        deliveries: deliveries.size,
        closed: true,
      };
      await fs.promises.writeFile(temporary, JSON.stringify(metadata), { flag: "wx", mode: 0o600 });
      await fs.promises.rename(temporary, config.paths.state);
      await fs.promises.chmod(config.paths.state, 0o600);
    } catch (error) {
      await fs.promises.unlink(temporary).catch(() => {});
      throw error;
    }
  }

  // The liveness contract (version 1) is written once the CLI runs inside the pinned
  // process group. A later host that finds this endpoint dead without a final record
  // may check whether that group still exists; without the contract it knows nothing.
  // The file names the group only: no command, environment, output or token.
  let contractWrite = Promise.resolve();
  function persistContract(group) {
    if (!config.paths.pin || !Number.isInteger(group) || group < 1) return;
    const temporary = config.paths.pin + ".tmp-" + crypto.randomBytes(6).toString("hex");
    contractWrite = (async () => {
      const contract = {
        version: 1,
        worker: config.worker,
        workspace: config.workspace,
        group,
        platform: process.platform,
        establishedAt: new Date().toISOString(),
      };
      await fs.promises.writeFile(temporary, JSON.stringify(contract), { flag: "wx", mode: 0o600 });
      await fs.promises.rename(temporary, config.paths.pin);
    })().catch(() => fs.promises.unlink(temporary).catch(() => {}));
  }

  let serverClosing = false;
  function maybeCloseServer() {
    if (serverClosing || !closed || activeConnections !== 0 || !launchAnswered || !server || !server.listening) return;
    clearTimeout(shutdownTimer);
    serverClosing = true;
    finalWrite.finally(() => {
      if (activeConnections !== 0) {
        serverClosing = false;
        return;
      }
      server.close(() => {
        // The group ended under this supervisor; its final record (if any) is the proof now.
        const removals = [fs.promises.unlink(config.paths.socket).catch(() => {})];
        if (config.paths.pin) removals.push(contractWrite.then(() => fs.promises.unlink(config.paths.pin)).catch(() => {}));
        Promise.all(removals).finally(() => {
          // The final metadata is intentionally retained for a new host to adopt
          // a completed worker once. It contains no command or environment data.
          fs.promises.lstat(config.paths.state).catch(() => null).then((metadata) => {
            if (!metadata) return fs.promises.rmdir(config.paths.directory).catch(() => {});
          }).finally(() => process.exit(0));
        });
      });
    });
  }

  function rejectPendingDeliveries(error) {
    for (const pending of pendingDeliveries.values()) pending.reject(error);
    pendingDeliveries.clear();
  }

  function finish() {
    if (closed || !pinClosed || !groupTerminationConfirmed) return;
    closed = true;
    redact("", true);
    if (startError || cliFailure) state = "failed";
    else if (stopping && (state === "running" || state === "starting")) state = "stopped";
    else if (!cliClosed) state = "failed";
    finalWrite = persistFinal().catch(() => {});
    rejectPendingDeliveries(new Error("worker process group closed"));
    maybeCloseServer();
  }

  function confirmNoPinStarted() {
    pinClosed = true;
    groupTerminationConfirmed = true;
    resolvePinClosed();
    finish();
  }

  function pinClosedWithoutProof() {
    if (pinClosed) return;
    pinClosed = true;
    resolvePinClosed();
    if (groupTerminationConfirmed) {
      finish();
      return;
    }
    if (process.platform === "win32" && stopping && treeKillInProgress) return;
    markUnknownPinExit();
  }

  function markUnknownPinExit() {
    // A dead group leader does not prove that its CLI descendants are dead.
    // Keep the endpoint live and omit the tombstone so a host cannot release
    // the workspace or signal a PID that may already have been reused.
    cliFailure = true;
    state = "failed";
    rejectPendingDeliveries(new Error("worker group leader exited before tree termination was confirmed"));
  }

  function livePinPid() {
    if (closed || pinClosed || !pin || !Number.isInteger(pin.pid) || pin.pid < 1) return undefined;
    // The ChildProcess object is the identity proof. Never signal a persisted
    // or already-reaped PID, even while its stdio is closing.
    if (pin.exitCode != null || pin.signalCode != null) return undefined;
    return pin.pid;
  }

  function signalPosixGroup(pid, signal) {
    if (process.platform === "win32" || livePinPid() !== pid) return false;
    try {
      process.kill(-pid, signal);
      return true;
    } catch (error) {
      if (errorCode(error) === "ESRCH" || errorCode(error) === "EPERM") return false;
      throw error;
    }
  }

  function taskkillExecutable() {
    const systemRoot = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows";
    if (!path.win32.isAbsolute(systemRoot)) throw new Error("Windows SystemRoot is not an absolute path");
    return path.win32.join(systemRoot, "System32", "taskkill.exe");
  }

  function terminateWindowsTree(pid) {
    return new Promise((resolve, reject) => {
      let child;
      let settled = false;
      const timeoutMs = Math.max(10_000, config.stopTimeoutMs + config.killTimeoutMs + 5_000);
      let timer;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      };
      try {
        child = spawn(taskkillExecutable(), ["/PID", String(pid), "/T", "/F"], {
          shell: false,
          stdio: "ignore",
          windowsHide: true,
        });
      } catch (error) {
        fail(new Error("Windows process-tree termination could not start"));
        return;
      }
      timer = setTimeout(() => {
        try { child.kill(); } catch {}
        fail(new Error("Windows process-tree termination timed out"));
      }, timeoutMs);
      child.once("error", () => fail(new Error("Windows process-tree termination could not start")));
      child.once("close", (code) => {
        if (settled) return;
        if (code !== 0) {
          fail(new Error("Windows process-tree termination was not confirmed"));
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve();
      });
    });
  }

  function waitForPinClose(timeoutMs) {
    let timer;
    return Promise.race([
      pinClosedPromise.then(() => true),
      new Promise((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]).finally(() => clearTimeout(timer));
  }

  async function stopGroup() {
    if (closed) return;
    stopping = true;
    if (groupTerminationConfirmed) {
      if (pinClosed) {
        finish();
        return;
      }
      if (!(await waitForPinClose(config.killTimeoutMs)))
        throw new Error("worker process group termination was confirmed but its leader did not close");
      finish();
      return;
    }
    const pid = livePinPid();
    if (pid === undefined)
      throw new Error("worker process group identity is no longer live; refusing to signal an unverified PID");

    if (process.platform === "win32") {
      treeKillInProgress = true;
      try {
        await terminateWindowsTree(pid);
      } catch (error) {
        treeKillInProgress = false;
        if (pinClosed) markUnknownPinExit();
        throw error;
      }
      treeKillInProgress = false;
      groupTerminationConfirmed = true;
    } else {
      if (!signalPosixGroup(pid, "SIGTERM"))
        throw new Error("worker process group could not be signaled; process state is unknown");
      if (await waitForPinClose(config.stopTimeoutMs))
        throw new Error("worker group leader exited before process-tree termination was confirmed");
      if (livePinPid() !== pid || !signalPosixGroup(pid, "SIGKILL"))
        throw new Error("worker process group could not be killed; process state is unknown");
      groupTerminationConfirmed = true;
    }

    if (pinClosed) {
      finish();
      return;
    }
    if (!(await waitForPinClose(config.killTimeoutMs)))
      throw new Error("worker process group termination was sent but its leader did not close");
    finish();
  }

  function settleDelivery(id, error) {
    const pending = pendingDeliveries.get(id);
    if (!pending) return;
    pendingDeliveries.delete(id);
    if (error) {
      cliFailure = true;
      state = "failed";
      pending.reject(error);
    }
    else {
      deliveries.set(pending.key, pending.message);
      pending.resolve();
    }
  }

  function receivePinControl(text) {
    pinControlBuffer += text;
    while (true) {
      const newline = pinControlBuffer.indexOf("\n");
      if (newline < 0) return;
      const line = pinControlBuffer.slice(0, newline);
      pinControlBuffer = pinControlBuffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        state = "failed";
        cliFailure = true;
        continue;
      }
      if (message.type === "started") {
        state = "running";
        persistContract(livePinPid());
        resolveStarted();
      } else if (message.type === "launch-error") {
        startError = new Error(typeof message.message === "string" ? message.message : "worker failed to start");
        cliFailure = true;
        cliClosed = true;
        state = "failed";
        resolveStarted();
      } else if (message.type === "cli-close") {
        cliClosed = true;
        if (startError || cliFailure) state = "failed";
        else if (stopping || message.code === 0 || message.signal !== null) state = "stopped";
        else state = "failed";
      } else if (message.type === "cli-input-error") {
        cliFailure = true;
        state = "failed";
      } else if (message.type === "delivery-ack") {
        if (message.ok === true) settleDelivery(message.id);
        else settleDelivery(message.id, new Error(typeof message.error === "string" ? message.error : "worker input is closed"));
      } else if (message.type === "protocol-error") {
        cliFailure = true;
        state = "failed";
      }
    }
  }

  function deliverToCli(key, message) {
    if (cliClosed || closed || !pin || !pin.stdin.writable) throw new Error("worker is no longer running");
    const id = crypto.randomUUID();
    const payload = JSON.stringify({ type: "deliver", id, key, message }) + "\n";
    return new Promise((resolve, reject) => {
      pendingDeliveries.set(id, { key, message, resolve, reject });
      pin.stdin.write(payload, (error) => {
        if (error) settleDelivery(id, error);
      });
    });
  }

  function serializeControl(action) {
    const previous = controlQueue;
    let release;
    controlQueue = new Promise((resolve) => { release = resolve; });
    return previous.then(action).finally(release);
  }

  function assertIdentity(request) {
    if (!sameWorker(request.worker, config.worker) || !sameWorkspace(request.workspace, config.workspace)) {
      throw new Error("worker reference is stale or mismatched; left the worker untouched");
    }
  }

  async function snapshot() {
    if (closed) await finalWrite;
    return {
      observation: observation(),
      deliveries: deliveries.size,
      closed,
      workspace: config.workspace,
      provenance: config.provenance,
    };
  }

  async function dispatch(request) {
    assertIdentity(request);
    switch (request.op) {
      case "launch":
        await started;
        launchAnswered = true;
        return snapshot();
      case "adopt":
      case "observe":
        return snapshot();
      case "deliver":
        return serializeControl(async () => {
          if (typeof request.deliveryKey !== "string" || request.deliveryKey.length === 0)
            throw new Error("invalid local node request: delivery key is empty");
          if (typeof request.message !== "string") throw new Error("invalid local node request: message must be text");
          const prior = deliveries.get(request.deliveryKey);
          if (prior !== undefined) {
            if (prior !== request.message) throw new Error("delivery key was reused with a different message");
            return snapshot();
          }
          if (closed || cliClosed || state !== "running") throw new Error("worker is no longer running");
          await deliverToCli(request.deliveryKey, request.message);
          return snapshot();
        });
      case "stop":
        return serializeControl(async () => {
          await stopGroup();
          return snapshot();
        });
      default:
        throw new Error("invalid local supervisor operation");
    }
  }

  function reply(socket, value) {
    if (socket.destroyed) return;
    const payload = JSON.stringify(value) + "\n";
    socket.end(payload);
  }

  function listen() {
    server = net.createServer({ allowHalfOpen: true }, (socket) => {
      activeConnections += 1;
      let requestText = "";
      let replied = false;
      const idleTimer = setTimeout(() => socket.destroy(), 10_000);
      idleTimer.unref();
      const done = () => {
        clearTimeout(idleTimer);
        activeConnections -= 1;
        maybeCloseServer();
      };
      socket.setEncoding("utf8");
      socket.on("close", done);
      socket.on("data", (chunk) => {
        if (replied) return;
        requestText += chunk;
        if (Buffer.byteLength(requestText) > 4 * 1024 * 1024) {
          replied = true;
          clearTimeout(idleTimer);
          return reply(socket, { error: "local supervisor request is too large" });
        }
        const newline = requestText.indexOf("\n");
        if (newline < 0) return;
        replied = true;
        clearTimeout(idleTimer);
        let request;
        try {
          request = JSON.parse(requestText.slice(0, newline));
        } catch {
          return reply(socket, { error: "invalid local supervisor request" });
        }
        dispatch(request).then(
          (value) => reply(socket, { ok: true, ...value }),
          (error) => reply(socket, { error: error instanceof Error ? error.message : String(error) }),
        );
      });
    });
    server.on("error", () => process.exit(1));
    server.listen(config.paths.socket, async () => {
      try {
        if (process.platform !== "win32") await fs.promises.chmod(config.paths.socket, 0o600);
        startGroupPin();
      } catch {
        process.exit(1);
      }
    });
  }

  function startGroupPin() {
    try {
      pin = spawn(process.execPath, ["-e", PIN_RUNNER_SCRIPT], {
        cwd: config.workspace.path,
        detached: true,
        env: process.env,
        shell: false,
        stdio: ["pipe", "pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      startError = error instanceof Error ? error : new Error(String(error));
      state = "failed";
      redact("\n" + startError.message + "\n", false);
      cliClosed = true;
      resolveStarted();
      confirmNoPinStarted();
      return;
    }
    const control = pin.stdio[3];
    if (!pin.stdin || !pin.stdout || !pin.stderr || !control) {
      startError = new Error("local process-group pin pipes are unavailable");
      cliClosed = true;
      state = "failed";
      resolveStarted();
      return;
    }
    pin.stdout.setEncoding("utf8");
    pin.stderr.setEncoding("utf8");
    control.setEncoding("utf8");
    pin.stdout.on("data", (chunk) => redact(chunk, false));
    pin.stderr.on("data", (chunk) => redact(chunk, false));
    control.on("data", receivePinControl);
    pin.stdin.on("error", (error) => {
      if (!stopping && !closed) {
        cliFailure = true;
        state = "failed";
        redact("\n" + error.message + "\n", false);
      }
    });
    pin.once("spawn", () => {
      const pinConfig = JSON.stringify({
        cwd: config.workspace.path,
        command: config.command,
        args: config.args,
        env: config.env,
      }) + "\n";
      pin.stdin.write(pinConfig, (error) => {
        if (error) {
          startError = error;
          cliFailure = true;
          state = "failed";
          cliClosed = true;
          resolveStarted();
        }
      });
    });
    pin.once("error", (error) => {
      if (!closed) {
        startError = error;
        cliFailure = true;
        state = "failed";
        redact("\n" + error.message + "\n", false);
        resolveStarted();
        if (pin.pid === undefined) {
          cliClosed = true;
          confirmNoPinStarted();
        }
      }
    });
    pin.once("close", () => pinClosedWithoutProof());
    shutdownTimer = setTimeout(() => {
      if (closed && !launchAnswered) {
        launchAnswered = true;
        maybeCloseServer();
      }
    }, 30_000);
    shutdownTimer.unref();
  }

  async function initialize(line) {
    if (initialized) return;
    initialized = true;
    try {
      config = JSON.parse(line);
      if (!config || !config.worker || !uuid(config.worker.handle) || !config.workspace || !config.paths)
        throw new Error("invalid local supervisor configuration");
      await fs.promises.mkdir(config.paths.directory, { recursive: true, mode: 0o700 });
      const directory = await fs.promises.lstat(config.paths.directory);
      if (!directory.isDirectory() || directory.isSymbolicLink() ||
        (typeof process.getuid === "function" && directory.uid !== process.getuid()) ||
        (directory.mode & 0o077) !== 0) throw new Error("local supervisor directory is not private");
      for (const path of [config.paths.socket, config.paths.state, config.paths.pin].filter(Boolean)) {
        try {
          await fs.promises.lstat(path);
          throw new Error("local supervisor endpoint already exists");
        } catch (error) {
          if (errorCode(error) !== "ENOENT") throw error;
        }
      }
      listen();
    } catch {
      process.exit(1);
    }
  }

  function finishInputError(message) {
    if (initialized) return;
    initialized = true;
    process.stderr.write(message + "\n", () => process.exit(1));
  }
})();`;
