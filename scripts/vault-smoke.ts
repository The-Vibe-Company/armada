/** API-only vault checks. Secret canaries and response bodies must never reach output. */
export type VaultSmokeCode =
  | "invalid_response"
  | "secret_exposed"
  | "unexpected_acceptance"
  | "unexpected_refusal"
  | "cleanup_unconfirmed";
export class VaultSmokeFailure extends Error {
  constructor(readonly code: VaultSmokeCode) {
    super(code);
  }
}
export interface VaultSmokeIo {
  request<T>(path: string, body: object): Promise<T>;
  step<T>(name: string, action: () => Promise<T>): Promise<T>;
  withCleanup<T>(action: () => Promise<T>): Promise<T>;
  out(line: string): void;
  protect(value: string): void;
  isFailure(error: unknown, status: number, code: string): boolean;
}
type Row = Record<string, unknown>;
type Handle = { id: string; version: number };
type Resource = {
  family: "variables" | "secrets";
  name: string;
  attempted: boolean;
  confirmed: boolean;
  handle?: Handle;
};
const uuid = /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const keys = new Set([
  "id",
  "orgId",
  "ownerId",
  "scope",
  "name",
  "version",
  "epoch",
  "status",
  "createdAt",
  "updatedAt",
  "expiresAt",
]);
const object = (value: unknown): value is Row => typeof value === "object" && value !== null && !Array.isArray(value);
const positive = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;
function fail(code: VaultSmokeCode): never {
  throw new VaultSmokeFailure(code);
}

/** One personal readable variable and one write-only secret; no sandbox/provider allocation. */
export async function runVaultCase(org: string, io: VaultSmokeIo): Promise<boolean> {
  const suffix = crypto.randomUUID().replaceAll("-", "").toUpperCase();
  const variable: Resource = { family: "variables", name: `SMOKE_VAR_${suffix}`, attempted: false, confirmed: false };
  const secret: Resource = { family: "secrets", name: `SMOKE_SECRET_${suffix}`, attempted: false, confirmed: false };
  const readable = `readable-${crypto.randomUUID()}`;
  const canaries = [`secret-${crypto.randomUUID()}`, `replacement-${crypto.randomUUID()}`];
  for (const value of canaries) io.protect(value);
  let passed = true;
  function guard(value: unknown) {
    const encoded = JSON.stringify(value);
    if (
      encoded &&
      canaries.some((canary) => encoded.includes(canary) || encoded.includes(JSON.stringify(canary).slice(1, -1)))
    )
      fail("secret_exposed");
  }
  function retain(resource: Resource, value: unknown) {
    if (
      object(value) &&
      value.name === resource.name &&
      value.orgId === org &&
      value.scope === "personal" &&
      typeof value.id === "string" &&
      uuid.test(value.id) &&
      positive(value.version)
    )
      resource.handle = { id: value.id, version: value.version };
  }
  async function api(path: string, body: object = {}, observe?: (value: unknown) => void): Promise<unknown> {
    const result = await io.request<unknown>(path, { org, ...body });
    observe?.(result);
    guard(result);
    return result;
  }
  function metadata(value: unknown): asserts value is Row {
    if (!object(value) || Object.keys(value).some((key) => !keys.has(key))) fail("invalid_response");
    if (
      typeof value.id !== "string" ||
      !uuid.test(value.id) ||
      typeof value.orgId !== "string" ||
      !uuid.test(value.orgId) ||
      typeof value.ownerId !== "string" ||
      !uuid.test(value.ownerId) ||
      !["personal", "org"].includes(String(value.scope)) ||
      typeof value.name !== "string" ||
      !positive(value.version) ||
      !positive(value.epoch) ||
      !["active", "revoked", "deleted"].includes(String(value.status)) ||
      typeof value.createdAt !== "string" ||
      typeof value.updatedAt !== "string" ||
      (value.expiresAt !== undefined && value.expiresAt !== null && typeof value.expiresAt !== "string")
    )
      fail("invalid_response");
  }
  function item(result: unknown, resource: Resource, version: number, status: string) {
    if (!object(result) || Object.keys(result).some((key) => key !== "item")) fail("invalid_response");
    metadata(result.item);
    const row = result.item;
    if (
      row.id !== resource.handle?.id ||
      row.orgId !== org ||
      row.name !== resource.name ||
      row.scope !== "personal" ||
      row.version !== version ||
      row.epoch !== version ||
      row.status !== status
    )
      fail("invalid_response");
  }
  function observeItem(resource: Resource) {
    return (result: unknown) => {
      if (object(result)) retain(resource, result.item);
    };
  }
  async function list(resource: Resource): Promise<Row[]> {
    const result = await api(`${resource.family}/list`, {}, (result) => {
      if (!object(result) || !Array.isArray(result.items)) return;
      // Retain owned random-name handles before validating potentially compromised metadata.
      for (const row of result.items)
        if (object(row) && row.name === resource.name && row.orgId === org && row.scope === "personal")
          retain(resource, row);
    });
    if (!object(result) || Object.keys(result).some((key) => key !== "items") || !Array.isArray(result.items))
      fail("invalid_response");
    for (const row of result.items) metadata(row);
    return result.items as Row[];
  }
  async function checkList(resource: Resource, version: number, status: string) {
    const rows = (await list(resource)).filter(
      (row) => row.name === resource.name && row.orgId === org && row.scope === "personal",
    );
    if (rows.length !== 1) fail("invalid_response");
    item({ item: rows[0] }, resource, version, status);
  }
  async function refusal(path: string, body: object, status: number, code: string) {
    try {
      await api(path, body, observeItem(secret));
    } catch (error) {
      if (error instanceof VaultSmokeFailure) throw error;
      if (io.isFailure(error, status, code)) return;
      fail("unexpected_refusal");
    }
    fail("unexpected_acceptance");
  }
  async function mutation(resource: Resource, operation: string, body: object, version: number, status: string) {
    const result = await api(`${resource.family}/${operation}`, body, observeItem(resource));
    item(result, resource, version, status);
  }
  try {
    await io.step("vault_variable_set", async () => {
      variable.attempted = true;
      await mutation(variable, "set", { name: variable.name, scope: "personal", value: readable }, 1, "active");
    });
    await io.step("vault_variable_list", () => checkList(variable, 1, "active"));
    await io.step("vault_variable_read", async () => {
      const result = await api("variables/read", { id: variable.handle?.id });
      if (
        !object(result) ||
        Object.keys(result).some((key) => key !== "item" && key !== "value") ||
        result.value !== readable
      )
        fail("invalid_response");
      item({ item: result.item }, variable, 1, "active");
    });
    await io.step("vault_secret_set", async () => {
      secret.attempted = true;
      await mutation(secret, "set", { name: secret.name, scope: "personal", value: canaries[0] }, 1, "active");
    });
    await io.step("vault_secret_list", () => checkList(secret, 1, "active"));
    await io.step("vault_secret_read_refused", () =>
      refusal("secrets/read", { id: secret.handle?.id }, 400, "invalid"),
    );
    await io.step("vault_secret_rotate", () =>
      mutation(secret, "rotate", { id: secret.handle?.id, expectedVersion: 1, value: canaries[1] }, 2, "active"),
    );
    await io.step("vault_secret_stale_rotate_refused", () =>
      refusal("secrets/rotate", { id: secret.handle?.id, expectedVersion: 1, value: canaries[0] }, 409, "conflict"),
    );
    await io.step("vault_secret_stale_version_unchanged", () => checkList(secret, 2, "active"));
    await io.step("vault_secret_revoke", () =>
      mutation(secret, "revoke", { id: secret.handle?.id, expectedVersion: 2 }, 3, "revoked"),
    );
    await io.step("vault_secret_revoked_rotate_refused", () =>
      refusal("secrets/rotate", { id: secret.handle?.id, expectedVersion: 3, value: canaries[1] }, 409, "conflict"),
    );
    await io.step("vault_secret_revoked_version_unchanged", () => checkList(secret, 3, "revoked"));
  } catch {
    passed = false;
  } finally {
    async function cleanupStep(name: string, action: () => Promise<void>) {
      try {
        await io.step(name, action);
      } catch {
        passed = false;
      }
    }
    try {
      await io.withCleanup(async () => {
        for (const resource of [secret, variable]) {
          if (!resource.attempted) continue;
          let reconciled = false;
          await cleanupStep(`vault_reconcile_${resource.family}`, async () => {
            const rows = (await list(resource)).filter(
              (row) => row.name === resource.name && row.orgId === org && row.scope === "personal",
            );
            if (rows.length > 1) fail("cleanup_unconfirmed");
            reconciled = true;
            // A missing list row cannot prove an unknown create never committed.
            // Delete known handles; otherwise report the exact random name.
            if (!rows.length && !resource.handle) fail("cleanup_unconfirmed");
          });
          if (resource.confirmed) continue;
          if (resource.handle) {
            const current = resource.handle;
            await cleanupStep(`vault_cleanup_${resource.family}`, async () => {
              const result = await api(
                `${resource.family}/delete`,
                { id: current.id, expectedVersion: current.version },
                observeItem(resource),
              );
              item(result, resource, current.version + 1, "deleted");
              resource.confirmed = true;
            });
            // Lost deletion acknowledgements can be confirmed without replaying the mutation.
            if (!resource.confirmed)
              await cleanupStep(`vault_confirm_${resource.family}`, async () => {
                const rows = await list(resource);
                if (rows.some((row) => row.name === resource.name || row.id === resource.handle?.id))
                  fail("cleanup_unconfirmed");
                resource.confirmed = true;
              });
          } else if (!reconciled) passed = false;
        }
      });
    } catch {
      passed = false;
    }
    const leftovers = [secret, variable].filter((resource) => resource.attempted && !resource.confirmed);
    if (leftovers.length) passed = false;
    io.out(
      JSON.stringify({
        step: "vault_cleanup_summary",
        pass: leftovers.length === 0,
        leftoverSecrets: leftovers
          .filter((resource) => resource.family === "secrets")
          .map((resource) => resource.handle?.id ?? resource.name),
        leftoverVariables: leftovers
          .filter((resource) => resource.family === "variables")
          .map((resource) => resource.handle?.id ?? resource.name),
      }),
    );
  }
  return passed;
}
