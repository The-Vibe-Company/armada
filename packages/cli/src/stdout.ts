interface OutputStream {
  write(text: string): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
}

export function createStdoutWriter(stream: OutputStream, exit: (code: number) => never): (text: string) => void {
  const handleError = (error: unknown): never => {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "EPIPE") {
      exit(0);
    }
    throw error;
  };
  stream.on("error", handleError);
  return (text) => {
    try {
      stream.write(text);
    } catch (error) {
      handleError(error);
    }
  };
}
