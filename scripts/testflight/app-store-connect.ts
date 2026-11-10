// App Store Connect API calls for the TestFlight workflow (.github/workflows/testflight.yml).
// Reads the API key from the environment; never prints it or the token.
//
//   bun scripts/testflight/app-store-connect.ts profile <name> <output.mobileprovision>
//     downloads the active App Store profile with that name and prints its UUID.
//   bun scripts/testflight/app-store-connect.ts distribute <app id> <version> <build> <group> <what-to-test file>
//     waits for the uploaded build, sets its What to Test (en-US) and adds it to the beta group.

const API = "https://api.appstoreconnect.apple.com";

export interface Deps {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  sleep: (ms: number) => Promise<void>;
  log: (line: string) => void;
  now: () => number;
}

export interface Key {
  id: string;
  issuer: string;
  privateKey: string;
}

function base64url(bytes: Uint8Array | string): string {
  return Buffer.from(bytes).toString("base64url");
}

// ES256 JWT for the App Store Connect API (20 minutes maximum lifetime).
export async function token(key: Key, nowSeconds: number): Promise<string> {
  const pem = key.privateKey.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "").replace(/\s+/g, "");
  const signingKey = await crypto.subtle.importKey(
    "pkcs8",
    Buffer.from(pem, "base64"),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const header = base64url(JSON.stringify({ alg: "ES256", kid: key.id, typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({ iss: key.issuer, iat: nowSeconds, exp: nowSeconds + 15 * 60, aud: "appstoreconnect-v1" }),
  );
  const input = `${header}.${payload}`;
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, signingKey, Buffer.from(input));
  return `${input}.${base64url(new Uint8Array(signature))}`;
}

interface Resource {
  id: string;
  attributes: Record<string, unknown>;
}

export class Client {
  constructor(
    private readonly key: Key,
    private readonly deps: Deps,
  ) {}

  async request(method: string, path: string, body?: unknown): Promise<{ data?: unknown } | undefined> {
    const bearer = await token(this.key, Math.floor(this.deps.now() / 1000));
    const init: RequestInit = { method, headers: { authorization: `Bearer ${bearer}` } };
    if (body !== undefined) {
      init.headers = { ...init.headers, "content-type": "application/json" };
      init.body = JSON.stringify(body);
    }
    const response = await this.deps.fetch(`${API}${path}`, init);
    const text = await response.text();
    if (!response.ok) {
      // App Store Connect error bodies hold codes and titles, never credentials.
      throw new Error(`App Store Connect ${method} ${path.split("?")[0]} failed with ${response.status}: ${text}`);
    }
    return text ? JSON.parse(text) : undefined;
  }

  async list(path: string): Promise<Resource[]> {
    const result = await this.request("GET", path);
    return (result?.data ?? []) as Resource[];
  }
}

function query(params: Record<string, string>): string {
  return new URLSearchParams(params).toString();
}

export async function downloadProfile(client: Client, name: string): Promise<{ uuid: string; content: Buffer }> {
  const profiles = await client.list(
    `/v1/profiles?${query({
      "filter[name]": name,
      "filter[profileType]": "IOS_APP_STORE",
      "filter[profileState]": "ACTIVE",
      "fields[profiles]": "name,profileContent,uuid,expirationDate",
    })}`,
  );
  // filter[name] is not guaranteed to be an exact match; keep only the exact one.
  const exact = profiles.filter((profile) => profile.attributes.name === name);
  if (exact.length !== 1) {
    throw new Error(`Expected exactly one active App Store profile named "${name}", found ${exact.length}.`);
  }
  const profile = exact[0] as Resource;
  return {
    uuid: String(profile.attributes.uuid),
    content: Buffer.from(String(profile.attributes.profileContent), "base64"),
  };
}

export interface Distribution {
  appId: string;
  version: string;
  build: string;
  group: string;
  whatToTest: string;
}

const POLL_MS = 30_000;
const WAIT_MS = 60 * 60_000;

export async function waitForBuild(client: Client, deps: Deps, target: Distribution): Promise<Resource> {
  const deadline = deps.now() + WAIT_MS;
  const path = `/v1/builds?${query({
    "filter[app]": target.appId,
    "filter[version]": target.build,
    "filter[preReleaseVersion.version]": target.version,
    "filter[preReleaseVersion.platform]": "IOS",
    "fields[builds]": "version,processingState,usesNonExemptEncryption",
  })}`;
  for (;;) {
    const [build] = await client.list(path);
    const state = build?.attributes.processingState;
    if (build && state === "VALID") return build;
    if (build && (state === "FAILED" || state === "INVALID")) {
      throw new Error(`Build ${target.version} (${target.build}) processing ended ${state}; see App Store Connect.`);
    }
    if (deps.now() >= deadline) {
      throw new Error(
        `Build ${target.version} (${target.build}) is not processed after ${WAIT_MS / 60_000} minutes (state ${state ?? "not visible yet"}).`,
      );
    }
    deps.log(`Waiting for build ${target.version} (${target.build}): ${state ?? "not visible yet"}`);
    await deps.sleep(POLL_MS);
  }
}

// App Store Connect rejects a What to Test longer than this.
const WHATS_NEW_LIMIT = 4000;

export async function distribute(client: Client, deps: Deps, target: Distribution): Promise<void> {
  if (target.whatToTest.length > WHATS_NEW_LIMIT) {
    throw new Error(`What to Test is ${target.whatToTest.length} characters; the limit is ${WHATS_NEW_LIMIT}.`);
  }
  const build = await waitForBuild(client, deps, target);
  deps.log(`Build ${target.version} (${target.build}) is processed: ${build.id}`);
  if (build.attributes.usesNonExemptEncryption !== false) {
    // Compliance is declared by ITSAppUsesNonExemptEncryption=false in Info.plist; anything else needs a human.
    throw new Error(
      `Build ${build.id} has usesNonExemptEncryption=${String(build.attributes.usesNonExemptEncryption)}; answer export compliance in App Store Connect.`,
    );
  }

  const localizations = await client.list(`/v1/builds/${build.id}/betaBuildLocalizations`);
  const english = localizations.find((localization) => localization.attributes.locale === "en-US");
  if (english) {
    await client.request("PATCH", `/v1/betaBuildLocalizations/${english.id}`, {
      data: { type: "betaBuildLocalizations", id: english.id, attributes: { whatsNew: target.whatToTest } },
    });
  } else {
    await client.request("POST", "/v1/betaBuildLocalizations", {
      data: {
        type: "betaBuildLocalizations",
        attributes: { locale: "en-US", whatsNew: target.whatToTest },
        relationships: { build: { data: { type: "builds", id: build.id } } },
      },
    });
  }
  deps.log("What to Test updated (en-US).");

  const groups = (
    await client.list(
      `/v1/betaGroups?${query({
        "filter[app]": target.appId,
        "filter[name]": target.group,
        "fields[betaGroups]": "name,isInternalGroup,hasAccessToAllBuilds",
      })}`,
    )
  ).filter((group) => group.attributes.name === target.group);
  if (groups.length !== 1) {
    throw new Error(`Expected exactly one TestFlight group named "${target.group}", found ${groups.length}.`);
  }
  const group = groups[0] as Resource;
  if (group.attributes.hasAccessToAllBuilds === true) {
    deps.log(`Group "${target.group}" already receives every build automatically.`);
    return;
  }
  await client.request("POST", `/v1/betaGroups/${group.id}/relationships/builds`, {
    data: [{ type: "builds", id: build.id }],
  });
  deps.log(`Build ${target.version} (${target.build}) added to "${target.group}".`);
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set.`);
  return value;
}

async function main(args: string[]): Promise<void> {
  const deps: Deps = {
    fetch: (url, init) => fetch(url, init),
    sleep: (ms) => Bun.sleep(ms),
    log: (line) => console.error(line),
    now: () => Date.now(),
  };
  const client = new Client(
    {
      id: required("APP_STORE_CONNECT_API_KEY_ID"),
      issuer: required("APP_STORE_CONNECT_API_ISSUER_ID"),
      privateKey: required("APP_STORE_CONNECT_API_PRIVATE_KEY"),
    },
    deps,
  );
  const [command, ...rest] = args;
  if (command === "profile" && rest.length === 2) {
    const [name, output] = rest as [string, string];
    const profile = await downloadProfile(client, name);
    await Bun.write(output, profile.content);
    console.log(profile.uuid);
    return;
  }
  if (command === "distribute" && rest.length === 5) {
    const [appId, version, build, group, file] = rest as [string, string, string, string, string];
    const whatToTest = (await Bun.file(file).text()).trim();
    await distribute(client, deps, { appId, version, build, group, whatToTest });
    return;
  }
  throw new Error(
    "usage: app-store-connect.ts profile <name> <output> | distribute <app> <version> <build> <group> <file>",
  );
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
