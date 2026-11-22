type WriteStderr = (bytes: Buffer) => Promise<void>;

const githubAuthFailure =
  /^fatal: (?:Authentication failed for 'https:\/\/github\.com\/[^'\r\n]+'|unable to access 'https:\/\/github\.com\/[^'\r\n]+': The requested URL returned error: 401)\r?$/m;
const diagnosticTailBytes = 8192;

/** Run each attempt in a fresh Git process so its HTTPS helper acquires a new credential. */
export async function retryGitHubAuthentication(
  run: (writeStderr: WriteStderr) => Promise<number>,
  writeStderr: WriteStderr,
): Promise<number> {
  // Keep the final diagnostic private until we know whether the command needs another attempt.
  // Forward earlier output as it arrives so progress cannot grow the buffer without bound.
  let tail = Buffer.alloc(0);
  const code = await run(async (bytes) => {
    const pending = Buffer.concat([tail, bytes]);
    const forward = Math.max(0, pending.length - diagnosticTailBytes);
    tail = pending.subarray(forward);
    if (forward) await writeStderr(pending.subarray(0, forward));
  });
  if (code > 0 && githubAuthFailure.test(tail.toString())) return run(writeStderr);
  await writeStderr(tail);
  return code;
}
