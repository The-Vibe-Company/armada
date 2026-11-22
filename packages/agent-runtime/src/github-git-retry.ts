type WriteStderr = (bytes: Buffer) => Promise<void>;

const githubAuthFailure =
  /^fatal: (?:Authentication failed for 'https:\/\/github\.com\/[^'\r\n]+'|unable to access 'https:\/\/github\.com\/[^'\r\n]+': The requested URL returned error: 401)\r?$/m;
const diagnosticTailBytes = 8192;

export async function retryGitHubAuthentication(
  run: (writeStderr: WriteStderr) => Promise<number>,
  writeStderr: WriteStderr,
  push = false,
) {
  let tail = Buffer.alloc(0);
  const code = await run(async (bytes) => {
    const pending = Buffer.concat([tail, bytes]);
    const forward = Math.max(0, pending.length - diagnosticTailBytes);
    tail = pending.subarray(forward);
    if (forward) await writeStderr(pending.subarray(0, forward));
  });
  const diagnostic = tail.toString();
  const discoveryRejected = code === 128 && githubAuthFailure.test(diagnostic.trimEnd().split("\n").at(-1) ?? "");
  if (push ? discoveryRejected : code > 0 && githubAuthFailure.test(diagnostic)) return run(writeStderr);
  await writeStderr(tail);
  return code;
}
