interface OutputStream {
  write(text: string): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
}

/**
 * A consumer closing stdout is normal pipeline termination, not command failure.
 * Exit immediately so follow/poll work stops too. This says nothing about whether
 * an already-submitted mutation completed; it must not be automatically replayed.
 */
export function createStdoutWriter(stream: OutputStream, exit: (code: number) => never): (text: string) => void {
  const handleError = (error: unknown): never => {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "EPIPE") {
      exit(0);
    }
    throw error;
  };
  // Node-style streams report errors asynchronously; Bun can throw from write.
  stream.on("error", handleError);
  return (text) => {
    try {
      stream.write(text);
    } catch (error) {
      handleError(error);
    }
  };
}
