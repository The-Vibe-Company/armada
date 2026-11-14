interface ShutdownServer {
  stop(closeActiveConnections?: boolean): Promise<void>;
  workerDone: Promise<void>;
}

interface ShutdownResources {
  beginDrain(): void;
  workersDone: Promise<void>;
  stopSockets(): Promise<void>;
  closeDocker(): Promise<void> | undefined;
  requests: ReadonlySet<Promise<unknown>>;
  closeMcp(): Promise<void>;
  closePools(): Promise<unknown>;
}

/** Keep shared services alive until their users and the native HTTP drain have finished. */
export function installServerShutdown(server: ShutdownServer, resources: ShutdownResources): void {
  const stop = server.stop.bind(server);
  let shutdown: Promise<void> | undefined;
  server.stop = (closeActiveConnections?: boolean) => {
    if (shutdown) {
      if (closeActiveConnections) void stop(true);
      return shutdown;
    }
    resources.beginDrain();
    // Requests may still use the gateway and SQL while finishing a launch.
    // Drain handlers and POST response streams; idle GET SSE needs MCP close to finish.
    // SQL stays alive until the native HTTP drain completes.
    const socketsStopped = resources.stopSockets();
    const stopped = stop(closeActiveConnections);
    shutdown = Promise.all([
      resources.workersDone,
      resources.closeDocker(),
      socketsStopped,
      (async () => {
        while (resources.requests.size) await Promise.allSettled([...resources.requests]);
      })(),
    ])
      .then(() => resources.closeMcp())
      .then(() => stopped)
      .then(() => resources.closePools())
      .then(() => {});
    server.workerDone = shutdown;
    return shutdown;
  };
}
