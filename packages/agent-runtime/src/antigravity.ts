import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { AcpDriver } from "./acp.ts";
import { HarnessError } from "./errors.ts";
import type { Driver, DriverContext } from "./protocol.ts";
import { createRedactor } from "./state.ts";

type AntigravityCredential =
  | { method: "google"; token: Record<string, unknown> }
  | { method: "gemini-api-key"; apiKey: string };

const appDataDir = "antigravity-acp";
const caBundles = [
  "/etc/ssl/certs/ca-certificates.crt",
  "/etc/pki/tls/certs/ca-bundle.crt",
  "/etc/ssl/ca-bundle.pem",
  "/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem",
  "/etc/ssl/cert.pem",
];

function secretLeaves(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (value && typeof value === "object") return Object.values(value).flatMap(secretLeaves);
  return [];
}

function withDirectory(path: string, create: boolean, use: (anchoredPath: string) => void) {
  if (create) {
    try {
      mkdirSync(path, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(fd);
    if (info.uid !== process.getuid?.() || (info.mode & (create ? 0o777 : 0o022)) !== (create ? 0o700 : 0))
      throw new Error("unsafe_antigravity_directory");
    use(`/proc/self/fd/${fd}`);
  } finally {
    closeSync(fd);
  }
}

function writeToken(directory: string, token: Record<string, unknown>) {
  const target = join(directory, "antigravity-oauth-token");
  const existing = lstatSync(target, { throwIfNoEntry: false });
  if (existing && !existing.isFile()) throw new Error("unsafe_antigravity_token_file");
  const temporary = join(directory, `.token-${crypto.randomUUID()}`);
  try {
    writeFileSync(temporary, JSON.stringify({ token }), { flag: "wx", mode: 0o600 });
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export class AntigravityDriver implements Driver {
  private readonly acp: AcpDriver;
  private readonly redact: ReturnType<typeof createRedactor>;

  constructor(options: {
    executable: string;
    root: string;
    cwd: string;
    credential: AntigravityCredential;
    registerSecrets(values: readonly string[]): void;
  }) {
    const { credential, root } = options;
    const secrets = credential.method === "google" ? secretLeaves(credential.token) : [credential.apiKey];
    options.registerSecrets(secrets);
    this.redact = createRedactor(secrets);
    const home = join(root, "antigravity");
    const tmp = join(root, "antigravity-tmp");
    const env: Record<string, string> = {
      GEMINI_HOME: home,
      AGY_CLI_DISABLE_AUTO_UPDATE: "1",
      AGY_ACP_FORCE_FILE_STORAGE: "1",
      TMPDIR: tmp,
    };
    const caBundle = caBundles.find((path) => existsSync(path));
    if (caBundle) env.SSL_CERT_FILE = caBundle;

    try {
      withDirectory(root, false, (directory) => {
        withDirectory(join(directory, "antigravity-tmp"), true, () => {});
        withDirectory(join(directory, "antigravity"), true, (profile) => {
          if (credential.method === "google")
            withDirectory(join(profile, appDataDir), true, (data) => writeToken(data, credential.token));
        });
      });
    } catch {
      throw new HarnessError("harness_initialization_failed", "initialization");
    }

    if (credential.method === "google") env.SSH_CONNECTION = "127.0.0.1 1 127.0.0.1 22";
    else env.GEMINI_API_KEY = credential.apiKey;
    this.acp = new AcpDriver({
      executable: options.executable,
      cwd: options.cwd,
      args: ["acp", "--gemini-dir", home, "--app-data-dir", appDataDir],
      env,
      acceptV2WithV1Shape: true,
      authMethodId: credential.method === "google" ? "oauth-personal" : "gemini-api-key",
      modelSelection: "config-option",
    });
  }

  start(context: DriverContext) {
    return this.acp.start({
      ...context,
      emit: (event) => context.emit(JSON.parse(this.redact(JSON.stringify(event)))),
    });
  }

  close() {
    return this.acp.close();
  }
}
