// Prepare one redactor per command. Keys come only from resolved credentials
// and a scoped release from Armada; no machine credential reads here.
import { type ArmadaConfig, type Credentials, projectOf, redactor } from "@armada/core";
import { apiOf } from "./api.ts";
import { type Io, UsageError } from "./io.ts";

export function credentialSecrets(credentials: Credentials): { name: string; value: string }[] {
  const signIn = credentials.armadaSignIn;
  return [
    { name: "LINEAR_API_KEY", value: credentials.linearApiKey ?? "" },
    { name: "GITHUB_TOKEN", value: credentials.githubToken ?? "" },
    {
      name: signIn?.kind === "api-key" ? "ARMADA_API_KEY" : "ARMADA_SESSION_TOKEN",
      value: signIn ? (signIn.kind === "api-key" ? signIn.key : signIn.token) : "",
    },
  ];
}

export function commandRedactor(io: Io, values: { name: string; value: string }[]) {
  const warned = new Set<string | null>();
  return redactor(values, {
    onRedact: (name) => {
      if (warned.has(name)) return;
      warned.add(name);
      io.stderr(`armada: warning: masked ${name ?? "a value matching a key pattern"}\n`);
    },
  });
}

export async function outgoingRedactor(io: Io, config: ArmadaConfig, credentials: Credentials) {
  const values = credentialSecrets(credentials);
  const signIn = credentials.armadaSignIn;
  if (signIn) {
    if (signIn.kind === "worker" && signIn.project !== config.project.slug)
      throw new UsageError("this worker session belongs to another project; no message was sent");
    // Fleet availability must never prevent a worker's Linear report. When
    // unavailable, mask resolved credentials and patterns and explain the
    // missing exact-value protection without quoting the failed response.
    try {
      const release = await apiOf(io, credentials.armadaApi.url).releaseSecrets(signIn, projectOf(config), null);
      values.push(...release.secrets);
      if (release.warnings.length) throw new Error("not all project secrets could be opened");
    } catch {
      io.stderr(
        "armada: warning: project secrets unavailable for masking; masking readable values, resolved credentials and key patterns\n",
      );
    }
  }
  return commandRedactor(io, values);
}
