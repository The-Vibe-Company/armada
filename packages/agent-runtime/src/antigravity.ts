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
import { redactKnownTokens } from "@armada/core";
import { type AntigravityCredential, antigravitySecrets } from "@armada/core/antigravity-credential";
import { AcpDriver } from "./acp.ts";
import { HarnessError } from "./errors.ts";
import { githubRuntimeEnvironment } from "./github-tools.ts";
import type { Journal } from "./journal.ts";
import type { Driver, DriverContext, DriverEvent } from "./protocol.ts";
import { createRedactor } from "./state.ts";

const appDataDir = "antigravity-acp";
const caBundles = [
  "/etc/ssl/certs/ca-certificates.crt",
  "/etc/pki/tls/certs/ca-bundle.crt",
  "/etc/ssl/ca-bundle.pem",
  "/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem",
  "/etc/ssl/cert.pem",
];

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

function writeToken(directory: string, token: Extract<AntigravityCredential, { method: "google" }>["token"]) {
  const target = join(directory, "antigravity-oauth-token");
  const existing = lstatSync(target, { throwIfNoEntry: false });
  if (existing && !existing.isFile()) throw new Error("unsafe_antigravity_token_file");
  const temporary = join(directory, `.token-${crypto.randomUUID()}`);
  try {
    writeFileSync(temporary, JSON.stringify({ token, auth_method: "consumer" }), { flag: "wx", mode: 0o600 });
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }
}

const redactPayload: (value: unknown, mask: (text: string) => string) => unknown = (value, mask) => {
  if (typeof value === "string") return mask(value);
  if (Array.isArray(value)) return value.map((entry) => redactPayload(entry, mask));
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [mask(key), redactPayload(entry, mask)]));
  return value;
};

export class AntigravityDriver implements Driver {
  private readonly acp: AcpDriver;
  private readonly redact: ReturnType<typeof createRedactor>;
  private readonly secretForms: string[];

  constructor(options: {
    executable: string;
    root: string;
    cwd: string;
    credential: AntigravityCredential;
    githubTools?: { root: string; home: string };
    readableVariables?: Record<string, string>;
    journal: Pick<Journal, "registerApplicationSecrets">;
  }) {
    const { credential, root } = options;
    const secrets = antigravitySecrets(credential);
    options.journal.registerApplicationSecrets(secrets);
    this.redact = createRedactor(secrets);
    this.secretForms = secrets
      .filter(Boolean)
      .flatMap((value) => [value, encodeURIComponent(value), JSON.stringify(value).slice(1, -1)]);
    const home = join(root, "antigravity");
    const tmp = join(root, "antigravity-tmp");
    const env: Record<string, string> = {
      GEMINI_HOME: home,
      AGY_CLI_DISABLE_AUTO_UPDATE: "1",
      AGY_ACP_FORCE_FILE_STORAGE: "1",
      TMPDIR: tmp,
      ...(options.githubTools
        ? {
            ...githubRuntimeEnvironment({}, options.githubTools.root),
            GIT_CONFIG_GLOBAL: join(options.githubTools.home, ".gitconfig"),
            HOME: home,
          }
        : {}),
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
      authMethodId: credential.method === "google" ? "oauth-personal" : "gemini-api-key",
      authenticationRequiredLine: "Open the following link to authenticate the ACP server: ",
      modelSelection: "config-option",
    });
    this.configureReadableVariables(options.readableVariables ?? {});
  }

  configureReadableVariables(variables: Record<string, string>) {
    if (
      Object.keys(variables).some(
        (key) =>
          /^(AGY_|GEMINI_|GOOGLE_|GCLOUD_|CLOUDSDK_)/.test(key) ||
          /^(TMPDIR|SSH_CONNECTION|DISPLAY|WAYLAND_DISPLAY|BROWSER|GIT_CONFIG_GLOBAL|HOME)$/.test(key),
      )
    )
      throw Error("invalid_request");
    this.acp.configureReadableVariables(variables);
  }

  start(context: DriverContext) {
    let pending = "";
    let messageId: string | undefined;
    const mask = (text: string) => redactKnownTokens(text, this.secretForms);
    const emit = (event: DriverEvent) => {
      const safe: DriverEvent = JSON.parse(this.redact(JSON.stringify(event)));
      if (safe.kind !== "message" || event.kind !== "message") {
        context.emit(safe);
        return;
      }
      if (event.partial) {
        if (messageId !== event.messageId) pending = "";
        messageId = event.messageId;
        const text = mask(pending + event.text);
        let held = 0;
        for (const secret of this.secretForms) {
          for (let size = Math.min(secret.length - 1, text.length); size > held; size--) {
            if (!secret.startsWith(text.slice(-size))) continue;
            held = size;
            break;
          }
        }
        const end = text.length - held;
        pending = text.slice(end);
        if (end) context.emit({ ...safe, text: text.slice(0, end) });
        return;
      }
      context.emit({
        ...safe,
        text: mask(event.text),
        tools: safe.tools.map((tool) => ({
          ...tool,
          id: mask(tool.id),
          name: mask(tool.name),
          ...(tool.input === undefined ? {} : { input: redactPayload(tool.input, mask) }),
          ...(tool.result ? { result: { ...tool.result, output: redactPayload(tool.result.output, mask) } } : {}),
        })),
      });
    };
    return this.acp.start({ ...context, emit });
  }

  close() {
    return this.acp.close();
  }
}
